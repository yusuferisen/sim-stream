// sim-stream: serves an iOS Simulator to a web browser.
//
// Channels to each client:
//   - GET /stream  — MJPEG, from `axe stream-video --format mjpeg` (stdout
//     proxied after stripping AXe's HTTP preamble).
//   - WS /video    — H.264 at up to 30 fps, when the optional encoder helper
//     is built: `axe stream-video --format bgra` piped into it, its records
//     fanned out as binary messages (h264.js). MJPEG stays the fallback.
//   - WS /ws       — JSON input events (tap/swipe/type/button/key),
//     dispatched as AXe commands through a FIFO queue.
//
// Access is by token: the operator's own plus any expiring `--share` tokens,
// all held in the in-memory registry in shares.js.
//
// See README.md for the full architecture.

import express from "express";
import { WebSocketServer } from "ws";
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRemoteProvider } from "./remote.js";
import { ShareRegistry, mintToken, parseShareSpec } from "./shares.js";
import { H264Hub, parsePngSize, planCapture } from "./h264.js";
import { ThumbCache, galleryDir, listScreenshots, renderGalleryPage, resolveScreenshot, screenshotName, sipsArgs } from "./gallery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Flags that take a value. Anything else is treated as a boolean switch.
// Keeping this explicit means `--token --port 9090` fails loudly instead of
// silently treating `token` as a boolean and eating the next flag.
const VALUE_FLAGS = new Set([
  "port", "host", "fps", "quality", "scale", "udid", "token", "auth", "remote", "share",
]);
// Value flags that may be given more than once; these parse to an array.
const REPEATABLE_FLAGS = new Set(["share"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      if (REPEATABLE_FLAGS.has(key)) (out[key] ??= []).push(next);
      else out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || process.env.PORT || "8080", 10);
const HOST_EXPLICIT = args.host !== undefined || process.env.HOST !== undefined;
const HOST = args.host || process.env.HOST || "127.0.0.1";
const FPS = parseInt(args.fps || "15", 10);
const QUALITY = parseInt(args.quality || "75", 10);
const SCALE = parseFloat(args.scale || "0.5");
// The H.264 path captures at 30 fps unless --fps says otherwise. (MJPEG's
// default of 15 is already more than AXe's MJPEG mode delivers.)
const H264_FPS = args.fps !== undefined ? FPS : 30;
// The optional encoder helper (`npm run build:helper`). Absent → MJPEG only.
const ENCODER = path.join(__dirname, "helper", ".build", "release", "sim-stream-encoder");
const REQUIRE_AUTH = args.auth !== "false";
const REMOTE = getRemoteProvider(args.remote || null);
// Screenshots, and the /gallery that lists them (gallery.js).
const GALLERY_DIR = galleryDir();
const tildePath = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

// Every token the server accepts lives in one in-memory registry (shares.js):
// the operator's own, valid until the process exits, plus one expiring token
// per `--share [label=]<ttl>`. `null` means auth is off.
function buildShares() {
  const specs = args.share || [];
  if (!REQUIRE_AUTH) {
    // Refuse rather than ignore: the operator asked for links that expire, and
    // a server that is open to everyone would silently never honor that.
    if (specs.length) throw new Error("--share needs auth — drop --auth false / --no-auth");
    return null;
  }
  return new ShareRegistry({
    ownerToken: args.token || mintToken(),
    shares: specs.map(parseShareSpec),
  });
}

let SHARES;
try {
  SHARES = buildShares();
} catch (e) {
  console.error(`[auth] ${e.message}`);
  process.exit(1);
}

// What a request is authorized as when auth is off. Never expires.
const NO_AUTH = Object.freeze({ label: "no-auth", expiresAt: null });

// --- Credential channels ---------------------------------------------------
//
// A request may carry the token three ways: `?token=` (the shareable link —
// leaks into URL bars and history, so `GET /` trades it for the cookie and
// redirects), the `x-token` header (scripted access; never reaches a URL), and
// the httpOnly cookie set by that handoff. Every entry point — the HTTP routes
// AND the WebSocket upgrade — authorizes through `requestAuthorized()`, so the
// channels cannot drift apart between check sites. Expiry lives below all
// three, in the registry: a dead share is dead on every channel at once.
//
// Exactly ONE credential is evaluated per request: `?token=` if the request
// carries one, otherwise `x-token`, otherwise the cookie — with no falling
// through. A link must behave the same in every browser; if a dead `?token=`
// could ride on a cookie that happens to be valid, an expired share link would
// still open for the operator (whose browser holds the owner cookie), which is
// precisely the person checking whether it died.
//
// Cookies are scoped by host, not port, so the name carries the port: two
// servers on one machine would otherwise overwrite each other's cookie.
const AUTH_COOKIE = `sim_stream_${PORT}`;

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

// Returns the registry entry the request is authorized as, or null.
// `queryToken` is undefined when the URL has no `token` parameter; anything
// else — including an empty string — counts as presented and must match.
function requestAuthorized(req, queryToken) {
  if (!SHARES) return NO_AUTH;
  const presented = queryToken ?? req.headers["x-token"] ?? readCookie(req, AUTH_COOKIE);
  return SHARES.match(presented);
}

// Tie a long-lived connection to the share that authorized it, so the share's
// expiry ends it. Returns the untrack function for the connection's close.
function trackSession(share, close) {
  return SHARES ? SHARES.track(share, close) : () => {};
}

function shareLive(share) {
  return !SHARES || SHARES.isLive(share);
}

// The owner credential — or anyone at all when auth is off, since then there
// is no owner to tell apart. Share links are for driving the simulator, not
// for browsing what was captured before they were issued.
function isOwner(share) {
  return !SHARES || share === SHARES.owner;
}

function authCookieHeader(req, share) {
  // `Secure` only when the browser is actually on https (directly or through a
  // TLS-terminating tunnel such as Tailscale Serve); on plain http a Secure
  // cookie is silently dropped and the redirect would land unauthenticated.
  // `SameSite=Lax`, not Strict: the link is usually opened from another app,
  // and Strict would withhold the cookie on that cross-site redirect.
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  // The cookie holds the token that was actually presented, and lives exactly
  // as long as that share does (the owner's stays a session cookie). Rounded
  // up: the server is the authority on expiry, so a cookie that lingers for a
  // fraction of a second is harmless, while `Max-Age=0` would delete it and
  // turn the redirect into a 401 for a link that is still valid.
  const left = SHARES.remaining(share);
  const maxAge = Number.isFinite(left) ? `; Max-Age=${Math.max(1, Math.ceil(left / 1000))}` : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(share.value)}; Path=/; HttpOnly; SameSite=Lax${maxAge}${https ? "; Secure" : ""}`;
}

// Human-readable lifetime for the startup banner, e.g. "2h" or "1d 3h".
function formatTtl(ms) {
  const parts = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(" ") || "0s";
}

// --- Simulator discovery ---------------------------------------------------

function listSimulators() {
  const json = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" });
  const data = JSON.parse(json);
  const all = [];
  for (const runtime of Object.keys(data.devices)) {
    for (const d of data.devices[runtime]) {
      if (!d.isAvailable) continue;
      all.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
        deviceType: d.deviceTypeIdentifier.replace("com.apple.CoreSimulator.SimDeviceType.", ""),
      });
    }
  }
  return all;
}

function pickSimulator() {
  const list = listSimulators();
  if (args.udid) {
    const found = list.find((d) => d.udid === args.udid);
    if (!found) throw new Error(`Simulator ${args.udid} not found`);
    return found;
  }
  const booted = list.find((d) => d.state === "Booted");
  if (booted) return booted;
  const preferred =
    list.find((d) => d.deviceType.startsWith("iPhone-17-Pro") && !d.deviceType.endsWith("Max")) ||
    list.find((d) => d.deviceType.startsWith("iPhone-17")) ||
    list.find((d) => d.deviceType.startsWith("iPhone"));
  if (!preferred) throw new Error("No iPhone simulator available");
  return preferred;
}

function ensureBooted(udid) {
  const state = listSimulators().find((d) => d.udid === udid)?.state;
  if (state === "Booted") return;
  console.log(`[sim] Booting ${udid}...`);
  try {
    execFileSync("xcrun", ["simctl", "boot", udid], { stdio: "inherit" });
  } catch {
    // "already booted" is fine
  }
  try {
    execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
  } catch {}
  execFileSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: "inherit" });
}

// --- AXe binary resolution -------------------------------------------------

function axeBinary() {
  for (const p of ["/opt/homebrew/bin/axe", "/usr/local/bin/axe", "axe"]) {
    try {
      execFileSync(p, ["--version"], { stdio: "pipe" });
      return p;
    } catch {}
  }
  throw new Error("axe CLI not found. Install with: brew install cameroncooke/axe/axe");
}

const AXE = axeBinary();

// --- Point-bounds lookup (portrait, logical pixels) -----------------------
//
// Used for mapping normalized browser coordinates → simulator points.
// iOS logical dimensions don't change between sim and device for a given
// model, so hardcoded values are safe. Fallback preserves aspect for
// unknown devices.

function boundsForDeviceType(type = "") {
  if (type.includes("iPhone-17-Pro-Max") || type.includes("iPhone-16-Pro-Max")) return { w: 440, h: 956 };
  if (type.includes("iPhone-17-Pro") || type.includes("iPhone-16-Pro")) return { w: 402, h: 874 };
  if (type.includes("iPhone-Air")) return { w: 402, h: 874 };
  if (type.includes("iPhone-17") || type.includes("iPhone-16")) return { w: 393, h: 852 };
  if (type.includes("iPhone-16e") || type.includes("iPhone-15") || type.includes("iPhone-14")) return { w: 390, h: 844 };
  if (type.includes("iPhone-SE")) return { w: 375, h: 667 };
  if (type.includes("iPad-Pro-13")) return { w: 1032, h: 1376 };
  if (type.includes("iPad-Pro-11")) return { w: 834, h: 1194 };
  if (type.includes("iPad-Air-13") || type.includes("iPad-Air-11")) return { w: 820, h: 1180 };
  if (type.includes("iPad-mini")) return { w: 744, h: 1133 };
  if (type.includes("iPad")) return { w: 820, h: 1180 };
  return { w: 393, h: 852 };
}

// --- MJPEG streaming (pass-through) ---------------------------------------
//
// AXe's `stream-video --format mjpeg` emits a complete HTTP response on
// stdout: status line, headers, then multipart body. We strip the HTTP
// preamble and pipe the multipart body to all connected HTTP clients.
// Boundary is literally `--mjpegstream` (with the leading dashes included
// in the value) — we preserve it verbatim.

class MjpegHub extends EventEmitter {
  constructor(udid) {
    super();
    this.udid = udid;
    this.clients = new Set();
    this.proc = null;
    this.generation = 0; // incremented on each spawn; exit handler only acts on matching gen
    this.headerStripped = false;
    this.preBuffer = Buffer.alloc(0);
    this.stopTimer = null;
    this.graceMs = 5000;
    this.status = "idle"; // idle | live | dead
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  addClient(res) {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.clients.add(res);
    const drop = () => {
      if (!this.clients.has(res)) return;
      this.clients.delete(res);
      if (this.clients.size === 0) this.scheduleStop();
    };
    res.on("close", drop);
    res.on("error", drop);
    this.start();
  }

  scheduleStop() {
    if (this.stopTimer) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.clients.size === 0) this.stop();
    }, this.graceMs);
  }

  start() {
    if (this.proc) return;
    const gen = ++this.generation;
    const cmdArgs = [
      "stream-video",
      "--udid", this.udid,
      "--format", "mjpeg",
      "--fps", String(FPS),
      "--quality", String(QUALITY),
      "--scale", String(SCALE),
    ];
    console.log(`[mjpeg] spawn: ${AXE} ${cmdArgs.join(" ")}`);
    const proc = spawn(AXE, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.headerStripped = false;
    this.preBuffer = Buffer.alloc(0);
    this.setStatus("live");
    proc.stdout.on("data", (c) => {
      if (this.generation === gen) this.onData(c);
    });
    proc.stderr.on("data", (d) => {
      // Filter AXe's "Captured N frames (X FPS actual)" progress noise
      const line = d.toString();
      if (/^Captured \d+ frames/m.test(line) || /^Streamed \d+ frames/m.test(line)) return;
      process.stderr.write(`[axe stream] ${line}`);
    });
    proc.on("exit", (code, sig) => {
      console.log(`[mjpeg] axe stream-video exited (code=${code} sig=${sig})`);
      // Only act if we're still the current generation — otherwise a newer
      // spawn has already taken over and we must not touch its state.
      if (this.generation !== gen) return;
      this.proc = null;
      const toClose = [...this.clients];
      this.clients.clear();
      for (const c of toClose) {
        try { c.end(); } catch {}
      }
      this.setStatus(code === 0 ? "idle" : "dead");
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.setStatus("idle");
  }

  onData(chunk) {
    if (!this.headerStripped) {
      this.preBuffer = Buffer.concat([this.preBuffer, chunk]);
      const end = this.preBuffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      chunk = this.preBuffer.slice(end + 4);
      this.preBuffer = null;
      this.headerStripped = true;
    }
    if (chunk.length === 0) return;
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

// --- H.264 capture pipeline -----------------------------------------------
//
// `axe stream-video --format bgra | sim-stream-encoder`, as two child
// processes. The hub that owns their lifecycle and fans the encoder's records
// out to `/video` viewers is in h264.js; this is only the process plumbing.

// Decides once, at startup, whether the H.264 path exists for this run.
// Returns planCapture()'s result, or { ok: false, reason }. Never throws:
// every failure just means "MJPEG only".
async function planH264(udid) {
  try {
    fs.accessSync(ENCODER, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "encoder helper not built (npm run build:helper)" };
  }
  // The simulator's size in PIXELS, from a screenshot's PNG header. The
  // bounds table is in points and cannot stand in for it: a wrong size does
  // not fail, it shears every row of the picture.
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-stream-"));
    const shot = path.join(dir, "probe.png");
    await runScreenshot(udid, shot);
    const head = Buffer.alloc(24);
    const fd = fs.openSync(shot, "r");
    try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
    const source = parsePngSize(head);
    if (!source) return { ok: false, reason: "could not read the simulator's pixel size from a screenshot" };
    return planCapture({ source, scale: SCALE, fps: H264_FPS });
  } catch (e) {
    return { ok: false, reason: `could not measure the simulator screen (${e.message})` };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Spawns the pipeline for one hub generation. Returns an emitter with "data"
// (chunks of encoder records), "exit" (once, when both processes are gone)
// and kill() — the shape H264Hub expects.
function spawnH264Pipeline(udid, plan) {
  const axeArgs = [
    "stream-video",
    "--udid", udid,
    "--format", "bgra",
    "--fps", String(plan.fps),
    "--scale", String(plan.scale),
  ];
  // The helper derives AXe's padded frame layout from --source and --scale,
  // so it must be told exactly what AXe was told.
  const encArgs = [
    "--source", `${plan.source.width}x${plan.source.height}`,
    "--scale", String(plan.scale),
    "--fps", String(plan.fps),
  ];
  console.log(`[h264] spawn: ${AXE} ${axeArgs.join(" ")} | sim-stream-encoder ${encArgs.join(" ")}`);

  // A spawn that fails for lack of file descriptors comes back without its
  // stdio streams (and reports through "error"); there is no pipeline to build.
  const abandon = (procs, message) => {
    for (const proc of procs) {
      proc.on("error", () => {});
      proc.kill("SIGKILL");
    }
    throw new Error(message);
  };
  const axe = spawn(AXE, axeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  if (!axe.stdout || !axe.stderr) abandon([axe], "could not spawn axe");
  // AXe's stdout is handed to the helper as its stdin — a file descriptor, not
  // a Node stream: the raw frames are ~95 MB/s at the default scale and must
  // never pass through this process.
  let enc;
  try {
    enc = spawn(ENCODER, encArgs, { stdio: [axe.stdout, "pipe", "pipe"] });
  } catch (e) {
    abandon([axe], `could not spawn the encoder (${e.message})`);
  } finally {
    // Drop our copy of the read end. While we held it, a dead helper would
    // leave AXe writing into a pipe nobody reads, instead of getting EPIPE.
    axe.stdout.destroy();
  }
  if (!enc.stdout || !enc.stderr) abandon([axe, enc], "could not spawn the encoder");

  const pipeline = new EventEmitter();
  const procs = [["axe", axe], ["encoder", enc]];
  const running = (proc) => proc.exitCode === null && proc.signalCode === null;
  const ends = [];
  let alive = procs.length;
  let killed = false;
  let killTimer = null;

  pipeline.kill = () => {
    if (killed) return;
    killed = true;
    for (const [, proc] of procs) if (running(proc)) proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      for (const [, proc] of procs) if (running(proc)) proc.kill("SIGKILL");
    }, 2000);
    killTimer.unref();
  };

  for (const [name, proc] of procs) {
    let done = false;
    const end = (how) => {
      if (done) return;
      done = true;
      ends.push(`${name} ${how}`);
      // One half gone means the stream is over; take the other half with it
      // rather than trusting EOF/EPIPE to get there.
      pipeline.kill();
      if (--alive > 0) return;
      clearTimeout(killTimer);
      pipeline.emit("exit", ends.join(", "));
    };
    proc.on("exit", (code, sig) => end(sig ? `killed by ${sig}` : `exited ${code}`));
    proc.on("error", (e) => end(`failed (${e.message})`));
  }

  enc.stdout.on("data", (chunk) => pipeline.emit("data", chunk));
  enc.stdout.on("error", () => {});
  // AXe narrates every raw stream on stderr (a banner with an ffmpeg hint,
  // then progress counters). Only what is not that routine chatter is shown.
  const chatter = /^(\s*$|Starting BGRA video stream|Format: bgra|Note: This is raw pixel data|\s+axe stream-video |Press Ctrl\+C|BGRA stream |Stopping BGRA stream|Captured \d+ frames|Streamed \d+ frames)/;
  const relay = (stream, prefix, skip) => {
    let partial = "";
    stream.on("data", (d) => {
      const lines = (partial + d.toString()).split("\n");
      partial = lines.pop();
      // A child that never ends its line must not grow this without bound.
      if (partial.length > 4096) lines.push(partial), partial = "";
      for (const line of lines) {
        if (!skip?.test(line)) process.stderr.write(`${prefix} ${line}\n`);
      }
    });
    stream.on("end", () => {
      if (partial && !skip?.test(partial)) process.stderr.write(`${prefix} ${partial}\n`);
    });
  };
  relay(axe.stderr, "[axe video]", chatter);
  relay(enc.stderr, "[encoder]");
  return pipeline;
}

// --- AXe command queue (input) --------------------------------------------

class CommandQueue {
  constructor(udid) {
    this.udid = udid;
    this.queue = [];
    this.running = false;
  }

  push(argv) {
    return new Promise((resolve, reject) => {
      this.queue.push({ argv, resolve, reject });
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        job.resolve(await this.runAxe(job.argv));
      } catch (e) {
        job.reject(e);
      }
    }
    this.running = false;
  }

  runAxe(argv) {
    return new Promise((resolve, reject) => {
      const full = [...argv, "--udid", this.udid];
      // `axe type` sends one HID event per char; long strings take real time.
      // Other commands (tap, swipe, button, key) are fast; 5s is plenty.
      const timeoutMs = argv[0] === "type"
        ? Math.max(10_000, (argv[1]?.length || 0) * 80)
        : 5000;
      const proc = spawn(AXE, full, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`axe ${argv[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`axe ${argv.join(" ")} exit=${code} ${stderr.trim()}`));
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

// --- Input event dispatch -------------------------------------------------

// HID keycodes for common keys (USB HID usage IDs)
const KEYCODES = {
  return: 40, enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  space: 44,
  right: 79, left: 80, down: 81, up: 82,
  home: 74, end: 77,
  pageup: 75, pagedown: 78,
  delete: 76,
};

async function dispatchInput(queue, bounds, evt) {
  const pt = (nx, ny) => ({
    x: Math.round(Math.max(0, Math.min(1, nx ?? 0)) * bounds.w),
    y: Math.round(Math.max(0, Math.min(1, ny ?? 0)) * bounds.h),
  });

  switch (evt.type) {
    case "tap": {
      const p = pt(evt.x, evt.y);
      // `physical` = a touch down/up pair. AXe's default for a coordinate tap
      // (FBSimulator tapAt) acks but lands nowhere on iOS 27 simulators.
      await queue.push(["tap", "-x", String(p.x), "-y", String(p.y), "--tap-style", "physical"]);
      return;
    }
    case "long-press": {
      const p = pt(evt.x, evt.y);
      const sec = (evt.duration || 800) / 1000;
      await queue.push([
        "touch",
        "-x", String(p.x),
        "-y", String(p.y),
        "--down", "--up",
        "--delay", String(sec),
      ]);
      return;
    }
    case "swipe": {
      const a = pt(evt.fromX, evt.fromY);
      const b = pt(evt.toX, evt.toY);
      const sec = (evt.duration || 300) / 1000;
      await queue.push([
        "swipe",
        "--start-x", String(a.x),
        "--start-y", String(a.y),
        "--end-x", String(b.x),
        "--end-y", String(b.y),
        "--duration", String(sec),
      ]);
      return;
    }
    case "type": {
      if (!evt.text) return;
      await queue.push(["type", evt.text]);
      return;
    }
    case "key": {
      const code = typeof evt.key === "number" ? evt.key : KEYCODES[String(evt.key).toLowerCase()];
      if (!code) throw new Error(`unknown key: ${evt.key}`);
      await queue.push(["key", String(code)]);
      return;
    }
    case "button": {
      const allowed = ["home", "lock", "side-button", "siri", "apple-pay", "screenshot"];
      const name = evt.name;
      if (name === "screenshot") {
        await fs.promises.mkdir(GALLERY_DIR, { recursive: true });
        const dest = path.join(GALLERY_DIR, screenshotName());
        await runScreenshot(queue.udid, dest);
        console.log(`[button] screenshot saved to ${dest}`);
        return { detail: `saved to ${tildePath(dest)}` };
      }
      if (!allowed.includes(name)) throw new Error(`unknown button: ${name}`);
      await queue.push(["button", name]);
      return;
    }
    default:
      throw new Error(`unknown event type: ${evt.type}`);
  }
}

// Async screenshot via simctl. Does NOT go through the AXe command queue,
// which is reserved for HID input, but still avoids blocking the event loop
// the way execFileSync would.
function runScreenshot(udid, dest) {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "io", udid, "screenshot", dest], { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("screenshot timed out"));
    }, 10_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`simctl screenshot exit=${code}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Writes a JPEG thumbnail of `src` to `dest` with macOS's built-in `sips`.
function runSips(src, dest) {
  return new Promise((resolve, reject) => {
    const proc = spawn("sips", sipsArgs(src, dest), { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("sips timed out"));
    }, 10_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`sips exit=${code}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- Server ---------------------------------------------------------------

async function main() {
  const sim = pickSimulator();
  console.log(`[sim] selected: ${sim.name} (${sim.udid}) state=${sim.state}`);
  ensureBooted(sim.udid);

  const hub = new MjpegHub(sim.udid);
  const queue = new CommandQueue(sim.udid);

  const bounds = boundsForDeviceType(sim.deviceType);

  // The H.264 path is decided once, here: it exists for this run only if the
  // helper is built and the simulator's pixel size could be measured. Anything
  // else is MJPEG exactly as before — `videoHub` stays null and `/video`
  // answers 404.
  const plan = await planH264(sim.udid);
  for (const note of plan.notes ?? []) console.log(`[h264] ${note}`);
  if (plan.ok) console.log(`[h264] encoder helper found — /video serves H.264 ${plan.width}x${plan.height} @${plan.fps}fps`);
  else console.log(`[h264] off — ${plan.reason}; serving MJPEG only`);
  // What /api/info and the `hello` frame advertise. width × height is the
  // decoded picture; it maps onto the whole screen (`bounds`).
  const h264Info = plan.ok
    ? { available: true, path: "/video", width: plan.width, height: plan.height, fps: plan.fps }
    : { available: false, reason: plan.reason };
  const videoHub = plan.ok
    ? new H264Hub({
        spawnPipeline: () => spawnH264Pipeline(sim.udid, plan),
        info: { width: plan.width, height: plan.height, fps: plan.fps },
        // A viewer with about two seconds of video still unsent is skipped
        // forward to the next keyframe instead of being queued for. (Two, not
        // one: joining replays up to a second of video in one burst.)
        highWaterBytes: Math.max(512 * 1024, Math.ceil(plan.bitrate / 4)),
        log: (line) => console.log(`[h264] ${line}`),
      })
    : null;
  const app = express();

  // Templated HTML: inject the real aspect-ratio into the page so the img tag
  // reserves correct dimensions before /api/info returns (avoids layout flash).
  const htmlTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const renderedHtml = htmlTemplate.replace("__ASPECT__", `${bounds.w} / ${bounds.h}`);

  // A `token` parameter that is present but not a plain string (`?token=a&token=b`
  // parses to an array) is still *presented* — it becomes "", which never matches.
  const queryToken = (req) => {
    const q = req.query.token;
    return q === undefined || typeof q === "string" ? q : "";
  };

  const authCheck = (req, res, next) => {
    req.share = requestAuthorized(req, queryToken(req));
    if (req.share) return next();
    return res.status(401).type("text/plain").send("Unauthorized");
  };

  // Cookie handoff: an authorized page load that still has `token` in its URL
  // gets the cookie and a redirect to the same URL without it, so the
  // credential leaves the address bar before the page ever renders — and the
  // page's own requests (/api/info, /stream, /ws, gallery images) are
  // authorized by the cookie. Used by both HTML pages, `/` and `/gallery`.
  const cookieHandoff = (req, res, next) => {
    const original = new URL(req.originalUrl, "http://x");
    if (!SHARES || !original.searchParams.has("token")) return next();
    original.searchParams.delete("token");
    // A request with `?token=` is authorized by that token and nothing else
    // (see requestAuthorized), so req.share is the share the link belongs to.
    res.setHeader("Set-Cookie", authCookieHeader(req, req.share));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(302, original.pathname + original.search);
  };

  app.get("/", authCheck, cookieHandoff, (req, res) => {
    res.type("html").send(renderedHtml);
  });
  app.get("/api/info", authCheck, (req, res) => res.json({
    simulator: sim, bounds, fps: FPS, quality: QUALITY, scale: SCALE, h264: h264Info,
    // Whether this viewer may open /gallery — the page shows the link only then.
    gallery: isOwner(req.share),
  }));

  // --- Screenshot gallery (owner only; read-only) ---
  // Files are named by a bare filename and served only if it is in the
  // gallery directory's listing (gallery.js) — never a path from the request.
  const thumbs = new ThumbCache({ dir: GALLERY_DIR, generate: runSips });
  const ownerOnly = (req, res, next) => {
    if (isOwner(req.share)) return next();
    return res.status(403).type("text/plain").send("The screenshot gallery is only open to the server's owner, not to share links.");
  };
  const privateFile = (res, file, type) => {
    res.setHeader("Cache-Control", "private, no-cache");
    res.type(type).sendFile(file, { dotfiles: "allow" }, (e) => {
      if (e && !res.headersSent) res.status(404).type("text/plain").send("Not found");
    });
  };
  app.get("/gallery", authCheck, ownerOnly, cookieHandoff, async (req, res) => {
    try {
      const entries = await listScreenshots(GALLERY_DIR);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.type("html").send(renderGalleryPage(entries, { dirShown: tildePath(GALLERY_DIR) }));
    } catch (e) {
      console.error(`[gallery] ${e.message}`);
      res.status(500).type("text/plain").send("Could not read the screenshot folder");
    }
  });
  app.get("/gallery/file/:name", authCheck, ownerOnly, async (req, res) => {
    const file = await resolveScreenshot(GALLERY_DIR, req.params.name).catch(() => null);
    if (!file) return res.status(404).type("text/plain").send("Not found");
    privateFile(res, file, "png");
  });
  app.get("/gallery/thumb/:name", authCheck, ownerOnly, async (req, res) => {
    const file = await resolveScreenshot(GALLERY_DIR, req.params.name).catch(() => null);
    if (!file) return res.status(404).type("text/plain").send("Not found");
    try {
      privateFile(res, await thumbs.get(req.params.name), "jpeg");
    } catch (e) {
      // No thumbnail (sips missing or failed): the full image still shows.
      console.error(`[gallery] thumbnail for ${req.params.name}: ${e.message}`);
      privateFile(res, file, "png");
    }
  });

  app.get("/stream", authCheck, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=--mjpegstream",
      "Cache-Control": "no-cache, private, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "close",
      "X-Accel-Buffering": "no",
    });
    hub.addClient(res);
    // Authorization happened once, at connect; this is what ends the stream
    // when the share behind it expires. destroy() fires "close", which is also
    // how the hub drops the client and keeps its refcount right.
    res.on("close", trackSession(req.share, () => res.destroy()));
  });

  // Express's default error page prints a stack trace with server paths, and
  // a route parameter is decoded *before* authCheck runs — so a malformed one
  // (`/gallery/file/%E0%A4%A.png`) would hand that page to anyone. Plain text.
  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(`[http] ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return res.destroy();
    res.status(status).type("text/plain").send(status === 500 ? "Internal error" : "Bad request");
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  // `/video` is send-only: viewers have nothing to say, so anything beyond a
  // control frame's worth of inbound data closes the socket (1009).
  const videoWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  const safeSend = (ws, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  };
  const broadcast = (payload) => {
    for (const ws of wss.clients) safeSend(ws, payload);
  };
  hub.on("status", (status) => broadcast({ type: "stream", status }));
  videoHub?.on("status", (status) => broadcast({ type: "h264", status }));

  // Both WebSocket endpoints enter here and pass the same check, in the same
  // order: path, then credential, then (for /video) whether the path exists.
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      // A fixed base, never the Host header: only the path and query matter,
      // and a malformed Host must not be able to throw out of this handler.
      url = new URL(req.url, "http://x");
    } catch {
      return socket.destroy();
    }
    const target = url.pathname === "/ws" ? wss : url.pathname === "/video" ? videoWss : null;
    if (!target) return socket.destroy();
    const share = requestAuthorized(req, url.searchParams.get("token") ?? undefined);
    if (!share) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    if (target === videoWss && !videoHub) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req, share));
  });

  // 1008 (policy violation) is one of the two codes the client reads as "your
  // credential is bad"; the reason lets it say *why* and stop retrying.
  const expireSocket = (ws) => ws.close(1008, "share expired");

  wss.on("connection", (ws, _req, share) => {
    console.log("[ws] connected");
    // `ws` reports a malformed frame as an "error" event and then closes the
    // socket itself. Unhandled, that event is an uncaught exception: one bad
    // frame from any authorized client would take the whole server down.
    ws.on("error", (e) => console.error(`[ws] protocol error: ${e.message}`));
    ws.on("close", trackSession(share, () => expireSocket(ws)));
    safeSend(ws, {
      type: "hello",
      simulator: sim,
      bounds,
      stream: hub.status,
      h264: { ...h264Info, status: videoHub?.status ?? "idle" },
    });
    ws.on("message", async (raw) => {
      // Checked per message, not just by the expiry sweep: close() only starts
      // a handshake, and a client that never answers it keeps the socket
      // readable until ws gives up. No input is dispatched past expiry.
      if (!shareLive(share)) return expireSocket(ws);
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const result = await dispatchInput(queue, bounds, evt);
        safeSend(ws, { type: "ack", id: evt.id, detail: result?.detail });
      } catch (e) {
        console.error(`[ws] ${evt.type || "?"}: ${e.message}`);
        safeSend(ws, { type: "error", id: evt.id, message: e.message });
      }
    });
    ws.on("close", () => console.log("[ws] disconnected"));
  });

  // H.264 viewers. The socket carries video one way; the hub decides what each
  // viewer is sent (h264.js). Like /stream and /ws, the connection is
  // authorized once, at the upgrade, so it is tracked against its share.
  videoWss.on("connection", (ws, _req, share) => {
    console.log("[video] connected");
    let leave = () => {};
    let expired = false;
    // Must have a listener (see /ws above); "close" follows and does the rest.
    ws.on("error", (e) => console.error(`[video] protocol error: ${e.message}`));
    ws.on("close", trackSession(share, () => {
      // Out of the hub first: close() only starts a handshake, and not one
      // more frame may go to a viewer whose share is dead.
      expired = true;
      leave();
      expireSocket(ws);
    }));
    ws.on("close", () => {
      leave();
      console.log("[video] disconnected");
    });
    if (expired) return; // the share died between the upgrade check and here
    leave = videoHub.addViewer(ws);
  });

  // Provider may advise a bind host (e.g. lan -> 0.0.0.0, tailscale-* -> 127.0.0.1).
  // An explicit --host always wins.
  let bindHost = HOST;
  if (REMOTE?.prepare && !HOST_EXPLICIT) {
    const adj = REMOTE.prepare();
    if (adj?.host) bindHost = adj.host;
  }

  await new Promise((resolve) => server.listen(PORT, bindHost, resolve));

  let remoteEndpoint = null;
  if (REMOTE?.start) {
    try {
      remoteEndpoint = await REMOTE.start({ port: PORT });
    } catch (e) {
      console.error(`[remote:${REMOTE.name}] ${e.message}`);
      process.exit(1);
    }
  }

  // Providers return a token-free base URL; the server is the only thing that
  // knows about tokens, and turns each base into one link per registry entry.
  const hostShown = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  const localBase = `http://${hostShown}:${PORT}/`;
  const link = (base, share) => (share ? `${base}?token=${encodeURIComponent(share.value)}` : base);
  const owner = SHARES?.owner ?? null;
  console.log("");
  console.log("  sim-stream running");
  console.log(`  local:     ${link(localBase, owner)}`);
  if (remoteEndpoint) {
    const label = `${REMOTE.name}:`.padEnd(10);
    if (remoteEndpoint.url) console.log(`  ${label} ${link(remoteEndpoint.url, owner)}`);
    if (remoteEndpoint.note) console.log(`             ${remoteEndpoint.note}`);
  }
  if (owner) console.log(`  token:     ${owner.value}  (yours — never expires; restart to revoke)`);
  if (SHARES) {
    // Share links are for handing out, so they use the remote URL when there
    // is one.
    const shareBase = remoteEndpoint?.url || localBase;
    for (const share of SHARES.entries.slice(1)) {
      const until = new Date(share.expiresAt).toLocaleString();
      console.log(`  share:     ${share.label} — valid ${formatTtl(share.ttlMs)}, until ${until}`);
      console.log(`             ${link(shareBase, share)}`);
    }
    SHARES.watch(({ entry, closed }) => {
      console.log(`[auth] share "${entry.label}" expired — closed ${closed} open connection${closed === 1 ? "" : "s"}`);
    });
  }
  console.log(`  simulator: ${sim.name} (${sim.udid})`);
  console.log(`  stream:    ${FPS}fps scale=${SCALE} quality=${QUALITY}`);
  console.log(plan.ok
    ? `  video:     H.264 ${plan.width}x${plan.height} @${plan.fps}fps on /video (MJPEG on /stream)`
    : `  video:     MJPEG only — ${plan.reason}`);
  console.log("");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[shutdown] cleaning up...");
    hub.stop();
    videoHub?.stop();
    SHARES?.stop();
    if (REMOTE?.stop) {
      try { await REMOTE.stop(); } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
