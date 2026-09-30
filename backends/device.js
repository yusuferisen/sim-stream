// The device backend: a real, USB-tethered iPhone or iPad from the QA bench,
// driven through the WebDriverAgent (WDA) the bench already runs, behind the
// backend interface in docs/architecture.md § Backends.
//
//   createDeviceBackend(opts)    WDA check + identity + session + forward → backend
//   resolveDeviceSpec(spec, …)   `--device <udid|role>` + `--wda` → {udid, wda, role}
//   wdaSettings(mjpeg)           --fps/--scale/--quality → WDA's MJPEG settings (pure)
//   deviceTarget(info, udid)     `ios info` JSON → the backend's `target` (pure)
//   parseBoundary(contentType)   the multipart boundary from a Content-Type (pure)
//   wdaInputRequest(evt, bounds) input event → one WDA request (pure)
//   labelPredicate / pickLabelTarget  tap-by-label lookup and choice (pure)
//
// Video is WDA's own MJPEG server (device port 9100), reached through an
// `ios forward` (go-ios) child this backend owns: a free host port is picked
// at startup, the forward is proven to answer with WDA's MJPEG before the
// server starts, and stop() — or, failing that, a process "exit" hook — kills
// it. Bounds (points) come from WDA's /window/size, screenshots from
// /screenshot. The tool never starts WDA or the tunnel: a missing WDA fails
// at startup with `qa-device up <role>`.
//
// Input goes through WDA one command at a time (a SerialQueue): taps,
// long-presses and swipes as W3C touch actions in points, text and the
// special keys WDA can type through /wda/keys, home and lock through WDA, tap
// by label as an element lookup plus a tap. A locked device is woken first.
// H.264 is off (Phase 9.4).
//
// Import-safe: nothing runs until createDeviceBackend() is called. Covered by
// test/device-backend.test.js against a fake WDA server and
// test/fixtures/fake-ios.

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import { parseTapTarget } from "../tap-label.js";
import { SerialQueue } from "./queue.js";

// qa-device's bench roles. Anything else given to --device is a UDID.
export const BENCH_ROLES = Object.freeze(["primary", "secondary", "tablet"]);
export const DEFAULT_WDA = "http://localhost:8100";
// Where WDA's MJPEG server listens on the device.
export const DEVICE_MJPEG_PORT = 9100;
export const IOS_INSTALL = "npm i -g go-ios";
// The W3C key an element reference comes under (WDA also sends legacy ELEMENT).
const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
// Above this many label matches, nothing is measured: the answer is "several".
const MAX_LABEL_MATCHES = 20;
// Coordinate gestures: spent on waking a locked device instead of dispatched.
const POINTER_EVENTS = new Set(["tap", "long-press", "swipe"]);

// --- Pure pieces -------------------------------------------------------------

// WDA's MJPEG settings for the shared --fps/--scale/--quality flags. WDA takes
// the scale as a percentage (1–100) and the quality as 1–100.
export function wdaSettings({ fps, scale, quality }) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got ${v})`);
    return n;
  };
  return {
    mjpegServerFramerate: clamp(Math.round(num(fps, "fps")), 1, 60),
    mjpegScalingFactor: clamp(Math.round(num(scale, "scale") * 100), 1, 100),
    mjpegServerScreenshotQuality: clamp(Math.round(num(quality, "quality")), 1, 100),
  };
}

// `ios info --udid` JSON → the backend's `target` (the fields /api/info's
// `simulator` object has always carried). `state` is fixed: a device that
// answered is connected.
export function deviceTarget(info, udid) {
  return {
    udid,
    name: info?.DeviceName || "iOS device",
    state: "Connected",
    runtime: info?.ProductVersion ? `iOS ${info.ProductVersion}` : "iOS",
    deviceType: info?.ProductType || "unknown",
  };
}

// The boundary parameter of a multipart Content-Type, verbatim (WDA's is
// `--BoundaryString`, dashes included — as AXe's is `--mjpegstream`).
export function parseBoundary(contentType) {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType || "");
  return m ? m[2].trim() : null;
}

// `--device <udid|role>` (+ `--wda`) → what to drive. A role needs qa-device,
// which answers both the UDID and the role's WDA port; an explicit --wda
// always wins. `run(cmd, args)` returns stdout or throws (injected in tests).
export function resolveDeviceSpec(spec, { wda = null, run = runSync } = {}) {
  const value = String(spec ?? "").trim();
  if (!value || /\s/.test(value)) throw new Error("--device needs a UDID or a bench role (primary|secondary|tablet)");
  if (!BENCH_ROLES.includes(value)) return { udid: value, wda: wda || DEFAULT_WDA, role: null };
  const ask = (what) => {
    try {
      return run("qa-device", [what, value]).trim();
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`--device ${value} is a bench role, but qa-device is not on PATH — pass the device's UDID and --wda <url> instead`);
      throw new Error(`qa-device ${what} ${value} failed: ${firstLine(e.stderr) || e.message}`);
    }
  };
  const udid = ask("udid");
  const port = wda ? null : ask("port");
  if (!wda && !/^\d+$/.test(port)) throw new Error(`qa-device port ${value} answered "${port}", not a port`);
  return { udid, wda: wda || `http://localhost:${port}`, role: value };
}

// --- Input translation (pure) ------------------------------------------------

// The special keys WDA's /wda/keys can express, as the characters XCTest
// types for them. Others (escape, arrows, forward delete, HID codes) are
// refused rather than approximated (DECISIONS.md § Phase 9 pre-flight defaults).
export const DEVICE_KEYS = Object.freeze({
  return: "\n", enter: "\n",
  backspace: "\b",
  tab: "\t",
  space: " ",
});

// Hardware buttons → WDA. `home` is WDA's sessionless /wda/homescreen:
// `pressButton home` answers success and does nothing on the iOS 26 bench.
// The press lands at once, but with the home screen already in front WDA
// answers only after ~10 s (and runs nothing else meanwhile) — hence 15 s.
// `lock` and `side-button` are one button on a device. Siri and Apple Pay have
// no WDA equivalent a button can press (Siri needs a typed request's text);
// `screenshot` never gets here (server.js).
export const DEVICE_BUTTONS = Object.freeze({
  home: { method: "POST", path: "/wda/homescreen", body: {}, sessionless: true, timeoutMs: 15_000 },
  lock: { method: "POST", path: "/wda/lock", body: {}, timeoutMs: 15_000 },
  "side-button": { method: "POST", path: "/wda/lock", body: {}, timeoutMs: 15_000 },
});
const REFUSED_BUTTONS = Object.freeze({
  siri: "the Siri button is not available on a real device (WDA can only start Siri with a typed request)",
  "apple-pay": "the Apple Pay button is not available on a real device",
});

// A W3C pointer-actions body for one finger: `steps` after an initial move to
// `from`. WDA takes points and milliseconds.
function touchActions(from, steps) {
  return {
    actions: [{
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [{ type: "pointerMove", duration: 0, x: from.x, y: from.y }, ...steps],
    }],
  };
}

export function tapActions(p, holdMs = 50) {
  return touchActions(p, [
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: holdMs },
    { type: "pointerUp", button: 0 },
  ]);
}

// One input event → the WDA request that performs it ({method, path, body,
// timeoutMs?, sessionless?} — session-scoped unless `sessionless`), or null for an event that needs none
// (`type` with nothing to type). `tap-label` is not here: it is a lookup, then
// a tap (the backend's tapLabel). Throws the viewer's error toast on anything
// a device cannot do. Points are normalized × bounds, clamped to the screen.
export function wdaInputRequest(evt, bounds) {
  const pt = (nx, ny) => ({
    x: Math.round(Math.max(0, Math.min(1, Number(nx) || 0)) * bounds.w),
    y: Math.round(Math.max(0, Math.min(1, Number(ny) || 0)) * bounds.h),
  });
  const ms = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(Math.min(n, 10_000)) : dflt;
  };
  // WDA answers an action only once the app is idle again: ~1 s for a tap,
  // over 10 s once for a scroll mid-animation (which still happened).
  const actions = (body, gestureMs) => ({ method: "POST", path: "/actions", body, timeoutMs: 20_000 + gestureMs });
  switch (evt?.type) {
    case "tap":
      return actions(tapActions(pt(evt.x, evt.y)), 50);
    case "long-press": {
      const hold = ms(evt.duration, 800);
      return actions(tapActions(pt(evt.x, evt.y), hold), hold);
    }
    case "swipe": {
      const move = ms(evt.duration, 300);
      const b = pt(evt.toX, evt.toY);
      return actions(touchActions(pt(evt.fromX, evt.fromY), [
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 50 },
        { type: "pointerMove", duration: move, x: b.x, y: b.y },
        { type: "pointerUp", button: 0 },
      ]), move);
    }
    case "type": {
      if (typeof evt.text !== "string" || !evt.text) return null;
      // WDA types at ~60 characters a second.
      return { method: "POST", path: "/wda/keys", body: { value: [evt.text] }, timeoutMs: Math.max(10_000, evt.text.length * 100) };
    }
    case "key": {
      const name = typeof evt.key === "string" ? evt.key.toLowerCase() : null;
      const ch = name !== null && Object.hasOwn(DEVICE_KEYS, name) ? DEVICE_KEYS[name] : undefined;
      if (ch === undefined) throw new Error(`the ${evt.key} key is not available on a real device`);
      return { method: "POST", path: "/wda/keys", body: { value: [ch] } };
    }
    case "button": {
      const req = Object.hasOwn(DEVICE_BUTTONS, evt.name) ? DEVICE_BUTTONS[evt.name] : null;
      if (req) return { ...req, body: { ...req.body } };
      if (Object.hasOwn(REFUSED_BUTTONS, evt.name)) throw new Error(REFUSED_BUTTONS[evt.name]);
      throw new Error(`unknown button: ${evt.name}`);
    }
    default:
      throw new Error(`unknown event type: ${evt?.type}`);
  }
}

// WDA's predicate for a tap-by-label target. WDA's `name` is the
// accessibilityIdentifier, or the label when an element has none — WDA exposes
// no identifier-only attribute. Quotes and backslashes are escaped for
// NSPredicate's string literal.
export function labelPredicate({ by, target }) {
  const lit = `"${target.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `${by === "id" ? "name" : "label"} == ${lit}`;
}

// Which of the matched elements' rects ({x,y,width,height}, points) to tap,
// as a point — or a thrown error toast. Off-screen elements (WDA reports them
// with a zero rect, e.g. an icon on another home-screen page) are ignored.
// Several on-screen matches are refused, as AXe does, unless one contains all
// the others: a control and its own icon/text share a label.
export function pickLabelTarget(rects, { by, target }, bounds) {
  const what = `${by === "id" ? "#" : "label "}'${target}'`;
  const center = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  const onScreen = rects.filter((r) => {
    if (!(r?.width > 0 && r?.height > 0)) return false;
    const c = center(r);
    return c.x >= 0 && c.y >= 0 && c.x <= bounds.w && c.y <= bounds.h;
  });
  if (onScreen.length === 0) throw new Error(`No on-screen element matched ${what}.`);
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  const outer = onScreen.find((a) => onScreen.every((b) => contains(a, b)));
  if (!outer) throw new Error(`Multiple (${onScreen.length}) on-screen elements matched ${what}. Tap by #identifier or by coordinates instead.`);
  return center(outer);
}

function runSync(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
}

function firstLine(s) {
  return String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
}

// --- WebDriverAgent client ---------------------------------------------------

// A thin JSON client for WDA. Session-scoped calls re-create the session and
// retry once when WDA says it is gone (a WDA restart, another client's
// session) — never a loop.
export class WdaClient {
  constructor(base, { timeoutMs = 10_000, settings = null, log = () => {} } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.settings = settings;
    this.log = log;
    this.sessionId = null;
  }

  // Resolves to {status, value}; rejects only when WDA cannot be reached or
  // does not answer JSON.
  async request(method, path, body, timeoutMs = this.timeoutMs) {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`WDA ${method} ${path}: HTTP ${res.status}, not JSON`); }
    return { status: res.status, value: json?.value };
  }

  // The same, but a non-2xx answer or a WDA error value rejects.
  async call(method, path, body, timeoutMs = this.timeoutMs) {
    const r = await this.request(method, path, body, timeoutMs);
    if (r.status >= 300 || r.value?.error) throw wdaError(method, path, r);
    return r.value;
  }

  async createSession() {
    const r = await this.request("POST", "/session", { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
    const id = r.value?.sessionId;
    if (r.status >= 300 || !id) throw wdaError("POST", "/session", r);
    this.sessionId = id;
    this.log(`session ${id}`);
    // Settings belong to WDA, not the session, but a WDA that restarted lost
    // them along with the session — so they go with every new one.
    if (this.settings) await this.call("POST", `/session/${id}/appium/settings`, { settings: this.settings });
    return id;
  }

  async session(method, path, body, timeoutMs = this.timeoutMs) {
    if (!this.sessionId) await this.createSession();
    const r = await this.request(method, `/session/${this.sessionId}${path}`, body, timeoutMs);
    if (!isInvalidSession(r)) {
      if (r.status >= 300 || r.value?.error) throw wdaError(method, path, r);
      return r.value;
    }
    this.log("session gone — creating a new one and retrying once");
    await this.createSession();
    return this.call(method, `/session/${this.sessionId}${path}`, body, timeoutMs);
  }
}

export function isInvalidSession(r) {
  return r.status === 404 || r.value?.error === "invalid session id";
}

function wdaError(method, path, r) {
  const detail = r.value?.message || r.value?.error || `HTTP ${r.status}`;
  return new Error(`WDA ${method} ${path}: ${firstLine(detail)}`);
}

// --- go-ios ------------------------------------------------------------------

function iosBinary(candidates) {
  for (const p of candidates) {
    try {
      execFileSync(p, ["--version"], { stdio: "pipe", timeout: 10_000 });
      return p;
    } catch {}
  }
  throw new Error(`go-ios (\`ios\`) not found — device mode needs it for the port-forward. Install with: ${IOS_INSTALL}`);
}

// Asks the OS for a port nobody is listening on. `ios forward` binds it a
// moment later; if something takes it in between, the forward fails and
// startup says so (waitForForward), rather than streaming someone else's.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// One GET of the forwarded MJPEG, resolved with its boundary once the headers
// arrive (the body is not read). Rejects on anything that is not WDA's MJPEG.
function probeMjpeg(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      const type = res.headers["content-type"] || "";
      const boundary = parseBoundary(type);
      req.destroy();
      if (res.statusCode !== 200 || !/^multipart\/x-mixed-replace/i.test(type) || !boundary) {
        // Something answered, and it is not WDA's stream: no point waiting.
        return reject(Object.assign(new Error(`the forwarded port answered HTTP ${res.statusCode} ${type || "(no content type)"}, not an MJPEG stream`), { definitive: true }));
      }
      resolve({ boundary, server: res.headers.server || "" });
    });
    req.on("timeout", () => req.destroy(new Error("no answer")));
    req.on("error", reject);
  });
}

// Spawns `ios forward --udid <udid> <hostPort> 9100` and resolves once WDA's
// MJPEG answers through it. The child is the caller's to kill on success;
// on failure it is killed here and the rejection carries go-ios's last words.
function startForward(ios, udid, port, { readyTimeoutMs, log }) {
  const argv = ["forward", `--udid=${udid}`, String(port), String(DEVICE_MJPEG_PORT)];
  log(`spawn: ${ios} ${argv.join(" ")}`);
  const child = spawn(ios, argv, { stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  const onOutput = (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 20) tail.shift();
      // go-ios logs JSON lines; only its errors are worth echoing.
      if (/"level":"(ERROR|FATAL)"|\bERROR\b|panic/.test(line)) log(`forward: ${goIosMessage(line)}`);
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  const failed = () => child.exitCode !== null || child.signalCode !== null || tail.some((l) => /failed to forward|address already in use/.test(l));
  const lastWords = () => tail.slice(-3).map(goIosMessage).join(" / ") || "no output";

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + readyTimeoutMs;
    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(new Error(why));
    };
    child.on("error", (e) => fail(e.code === "ENOENT" ? `go-ios (\`ios\`) not found. Install with: ${IOS_INSTALL}` : `ios forward failed to start (${e.message})`));
    child.on("exit", (code, sig) => {
      if (!settled) fail(`ios forward exited (${sig || `code ${code}`}) before the stream answered: ${lastWords()}`);
    });
    const attempt = async () => {
      if (settled) return;
      if (failed()) return fail(`ios forward could not forward port ${port}: ${lastWords()}`);
      try {
        const probe = await probeMjpeg(port, 2000);
        // The bind error and the first connection race; judge the child
        // only after an answer, so a stranger's listener is never trusted.
        if (failed()) return fail(`ios forward could not forward port ${port}: ${lastWords()}`);
        settled = true;
        return resolve({ child, boundary: probe.boundary });
      } catch (e) {
        if (settled) return;
        if (e.definitive) return fail(`${e.message} — is WDA running on this device?`);
        if (Date.now() > deadline) {
          return fail(`WDA's MJPEG server did not answer through ios forward within ${Math.round(readyTimeoutMs / 1000)} s (${e.message}) — is WDA running on this device, and is it the device --wda points at?`);
        }
        setTimeout(attempt, 250);
      }
    };
    setTimeout(attempt, 100);
  });
}

function goIosMessage(line) {
  try {
    const j = JSON.parse(line);
    return [j.msg, j.err].filter(Boolean).join(": ") || line.trim();
  } catch {
    return line.trim();
  }
}

// --- MJPEG source ------------------------------------------------------------

// The forwarded WDA stream as a hub source: "data" is the multipart body
// (WDA speaks real HTTP, so Node has already taken the headers off), "exit"
// fires once with a detail string, kill() ends it.
function openForwardedMjpeg(port, log) {
  const source = new EventEmitter();
  let done = false;
  let killed = false;
  const end = (detail) => {
    if (done) return;
    done = true;
    log(`stream ended (${killed ? "stopped" : detail})`);
    source.emit("exit", detail);
  };
  log(`open: http://127.0.0.1:${port}/ (WDA MJPEG via ios forward)`);
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      req.destroy();
      return end(`HTTP ${res.statusCode}`);
    }
    res.on("data", (chunk) => source.emit("data", chunk));
    res.on("end", () => end("the device closed the stream"));
    res.on("close", () => end("connection closed"));
    res.on("error", (e) => end(`failed (${e.message})`));
  });
  req.on("error", (e) => end(`failed (${e.message})`));
  source.kill = () => {
    killed = true;
    req.destroy();
  };
  return source;
}

// --- The backend -------------------------------------------------------------

// Resolves the device, checks WDA, reads the device's identity, opens a WDA
// session with the MJPEG settings, measures the screen, and brings up the
// port-forward. Returns the backend (docs/architecture.md § Backends). Every
// failure throws with the command that fixes it; nothing is left running.
//
//   device    `--device`: a UDID, or primary|secondary|tablet (via qa-device)
//   wda       `--wda`: WDA's base URL; null = the role's port, else :8100
//   mjpeg     { fps, quality, scale } → WDA's MJPEG settings
//   log(line) startup and lifecycle lines, already prefixed
//   ios, run, readyTimeoutMs, wdaTimeoutMs — injectable for tests
export async function createDeviceBackend({
  device,
  wda = null,
  mjpeg,
  log = () => {},
  ios = null,
  run = runSync,
  readyTimeoutMs = 10_000,
  wdaTimeoutMs = 10_000,
}) {
  const spec = resolveDeviceSpec(device, { wda, run });
  const fix = `qa-device up ${spec.role ?? "<role>"}`;
  // The binary first, like `axe` for a simulator: nothing starts without it.
  const iosBin = iosBinary(ios ? [ios] : ["/opt/homebrew/bin/ios", "/usr/local/bin/ios", "ios"]);

  const settings = wdaSettings(mjpeg);
  const client = new WdaClient(spec.wda, { timeoutMs: wdaTimeoutMs, settings, log: (l) => log(`[wda] ${l}`) });
  try {
    const status = await client.request("GET", "/status", undefined, 3000);
    if (status.status !== 200 || status.value?.ready === false) throw new Error(`HTTP ${status.status}`);
  } catch (e) {
    throw new Error(`WebDriverAgent is not answering at ${spec.wda} (${e.message}). Start it with: ${fix}`);
  }

  // Identity from go-ios; WDA's own device info (a generic "iPhone" on the
  // bench) only if go-ios cannot answer.
  let target;
  try {
    target = deviceTarget(JSON.parse(run(iosBin, ["info", `--udid=${spec.udid}`])), spec.udid);
  } catch (e) {
    log(`[device] ios info failed (${firstLine(e.stderr) || e.message}); using WDA's device info`);
    const info = await client.call("GET", "/wda/device/info").catch(() => ({}));
    target = deviceTarget({ DeviceName: info.name, ProductType: info.model }, spec.udid);
  }
  log(`[device] selected: ${target.name} (${spec.udid}) ${target.deviceType} ${target.runtime} — WDA ${spec.wda}`);

  await client.createSession();
  const size = await client.session("GET", "/window/size");
  if (!(size?.width > 0 && size?.height > 0)) throw new Error(`WDA /window/size answered ${JSON.stringify(size)}`);
  // Portrait, like every other bounds: the page's aspect ratio comes from it.
  const bounds = { w: Math.min(size.width, size.height), h: Math.max(size.width, size.height) };
  log(`[device] bounds ${bounds.w}x${bounds.h} pt · MJPEG ${settings.mjpegServerFramerate}fps scale=${settings.mjpegScalingFactor}% quality=${settings.mjpegServerScreenshotQuality}`);

  const port = await freePort();
  const { child: forward, boundary } = await startForward(iosBin, spec.udid, port, {
    readyTimeoutMs,
    log: (l) => log(`[device] ${l}`),
  });
  log(`[device] forward ready: 127.0.0.1:${port} → device:${DEVICE_MJPEG_PORT}`);

  // A server that exits without stop() — a failed tunnel start, the shutdown
  // timer — must not leave the forward running. Synchronous, so it runs even
  // from process.exit().
  const running = () => forward.exitCode === null && forward.signalCode === null;
  let stopping = false;
  const killOnExit = () => { if (running()) forward.kill("SIGKILL"); };
  process.on("exit", killOnExit);
  forward.on("exit", (code, sig) => {
    if (!stopping) log(`[device] ios forward exited (${sig || `code ${code}`}) — the stream cannot reconnect; restart the server`);
  });

  const queue = new SerialQueue();

  // Auto-lock is 3 minutes on the bench. WDA's /wda/unlock times out on an
  // iOS 26 device while a home-screen press unlocks a passcode-free one at
  // once, so that is the wake. Resolves true when the device was locked.
  const wake = async () => {
    if ((await client.session("GET", "/wda/locked")) !== true) return false;
    log("[device] locked — pressing home to unlock");
    await client.call("POST", "/wda/homescreen");
    if ((await client.session("GET", "/wda/locked")) === true) {
      throw new Error("the device is locked and could not be unlocked (does it have a passcode?)");
    }
    return true;
  };

  // Tap by label: WDA finds the elements, their rects pick the one to tap
  // (pickLabelTarget), and the tap is a pointer action at its centre — WDA's
  // element click reports success on an element that is off screen.
  const tapLabel = async (t) => {
    const found = await client.session("POST", "/elements", { using: "predicate string", value: labelPredicate(t) }, 15_000);
    const ids = (Array.isArray(found) ? found : []).map((e) => e?.ELEMENT || e?.[W3C_ELEMENT]).filter(Boolean);
    if (ids.length > MAX_LABEL_MATCHES) {
      throw new Error(`Multiple (${ids.length}) elements matched ${t.by === "id" ? "#" : "label "}'${t.target}'. Tap by #identifier or by coordinates instead.`);
    }
    const rects = [];
    for (const id of ids) rects.push(await client.session("GET", `/element/${id}/rect`));
    await client.session("POST", "/actions", tapActions(pickLabelTarget(rects, t, bounds)));
  };

  return {
    kind: "device",
    target,
    bounds,
    h264: { ok: false, reason: "H.264 from a device is not built yet (Phase 9.4)" },
    mjpegBoundary: boundary,

    openMjpeg() {
      if (!running()) throw new Error("the port-forward to the device has exited; restart the server");
      return openForwardedMjpeg(port, (line) => log(`[mjpeg] ${line}`));
    },

    h264Pipeline() {
      throw new Error("H.264 is off: from a device it is not built yet (Phase 9.4)");
    },

    // Every command runs through one FIFO, after a wake check. A coordinate
    // gesture that found the device locked is spent on waking it: the viewer
    // aimed it at the lock screen, not at whatever is under it now.
    async input(evt) {
      if (evt?.type === "tap-label") {
        const t = parseTapTarget(evt.text);
        await queue.push(async () => {
          await wake();
          await tapLabel(t);
        });
        // parseTapTarget() proved the text a string.
        return { detail: evt.text.trim() };
      }
      const req = wdaInputRequest(evt, bounds);
      if (!req) return;
      return queue.push(async () => {
        if ((await wake()) && POINTER_EVENTS.has(evt.type)) return { detail: "unlocked" };
        if (req.sessionless) await client.call(req.method, req.path, req.body, req.timeoutMs);
        else await client.session(req.method, req.path, req.body, req.timeoutMs);
      });
    },

    // WDA's screenshot is a base64 PNG; sessionless, never queued.
    async screenshot(dest) {
      const b64 = await client.call("GET", "/screenshot");
      const png = Buffer.from(String(b64 || ""), "base64");
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("WDA's screenshot was not a PNG");
      await fs.promises.writeFile(dest, png);
    },

    // The forward is the one thing this backend owns. SIGTERM, then SIGKILL
    // (the exit hook stays, for a process that exits inside that second).
    stop() {
      stopping = true;
      if (!running()) return;
      forward.kill("SIGTERM");
      const t = setTimeout(() => { if (running()) forward.kill("SIGKILL"); }, 1000);
      t.unref();
      forward.once("exit", () => clearTimeout(t));
    },
  };
}
