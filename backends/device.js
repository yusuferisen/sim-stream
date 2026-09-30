// The device backend: a real, USB-tethered iPhone or iPad from the QA bench,
// driven through the WebDriverAgent (WDA) the bench already runs, behind the
// backend interface in docs/architecture.md § Backends.
//
//   createDeviceBackend(opts)    WDA check + identity + session + forward → backend
//   resolveDeviceSpec(spec, …)   `--device <udid|role>` + `--wda` → {udid, wda, role}
//   wdaSettings(mjpeg)           --fps/--scale/--quality → WDA's MJPEG settings (pure)
//   deviceTarget(info, udid)     `ios info` JSON → the backend's `target` (pure)
//   parseBoundary(contentType)   the multipart boundary from a Content-Type (pure)
//
// Video is WDA's own MJPEG server (device port 9100), reached through an
// `ios forward` (go-ios) child this backend owns: a free host port is picked
// at startup, the forward is proven to answer with WDA's MJPEG before the
// server starts, and stop() — or, failing that, a process "exit" hook — kills
// it. Bounds (points) come from WDA's /window/size, screenshots from
// /screenshot. The tool never starts WDA or the tunnel: a missing WDA fails
// at startup with `qa-device up <role>`.
//
// Input is not wired yet (Phase 9.3): every event is refused with an error
// ack. H.264 is off (Phase 9.4).
//
// Import-safe: nothing runs until createDeviceBackend() is called. Covered by
// test/device-backend.test.js against a fake WDA server and
// test/fixtures/fake-ios.

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

// qa-device's bench roles. Anything else given to --device is a UDID.
export const BENCH_ROLES = Object.freeze(["primary", "secondary", "tablet"]);
export const DEFAULT_WDA = "http://localhost:8100";
// Where WDA's MJPEG server listens on the device.
export const DEVICE_MJPEG_PORT = 9100;
export const INPUT_NOT_SUPPORTED = "input on a real device is not supported yet (Phase 9.3)";
export const IOS_INSTALL = "npm i -g go-ios";

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
  async call(method, path, body) {
    const r = await this.request(method, path, body);
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

  async session(method, path, body) {
    if (!this.sessionId) await this.createSession();
    const r = await this.request(method, `/session/${this.sessionId}${path}`, body);
    if (!isInvalidSession(r)) {
      if (r.status >= 300 || r.value?.error) throw wdaError(method, path, r);
      return r.value;
    }
    this.log("session gone — creating a new one and retrying once");
    await this.createSession();
    return this.call(method, `/session/${this.sessionId}${path}`, body);
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

    async input() {
      throw new Error(INPUT_NOT_SUPPORTED);
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
