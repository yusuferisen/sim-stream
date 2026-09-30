// The simulator backend: everything that knows the target is an iOS Simulator
// driven through the AXe CLI and `xcrun simctl`, behind the backend interface
// in docs/architecture.md § Backends. server.js, MjpegHub and H264Hub talk
// only to that interface; nothing else in the tree spawns `axe` or `simctl`.
//
//   createSimulatorBackend(opts)   discovery + boot + H.264 planning → backend
//   boundsForDeviceType(type)      device type → logical points (hand-kept table)
//   pickSimulator(list, udid)      the selection ladder, on a listing
//   axeInputArgs(evt, bounds)      input event → `axe` argv (pure)
//   axeTimeoutMs(argv)             how long an `axe` command may take (pure)
//   stripHttpPreamble()            AXe's fake HTTP response → the bare body
//
// Import-safe: nothing runs until createSimulatorBackend() is called. The
// pure pieces are covered by test/simulator-backend.test.js; the process
// plumbing needs a booted simulator and is verified by the manual checklist.

import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePngSize, planCapture } from "../h264.js";
import { axeErrorLine, tapLabelArgs } from "../tap-label.js";
import { SerialQueue } from "./queue.js";

// The boundary AXe's MJPEG mode uses, as it appears in the body (the leading
// dashes are part of the value). `/stream`'s Content-Type carries it.
export const MJPEG_BOUNDARY = "--mjpegstream";

// --- Simulator discovery ---------------------------------------------------

export function listSimulators() {
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

// The selection ladder: `udid` if given (and present), else any booted
// device, else the preferred iPhone model. Throws when nothing fits.
export function pickSimulator(list, udid = null) {
  if (udid) {
    const found = list.find((d) => d.udid === udid);
    if (!found) throw new Error(`Simulator ${udid} not found`);
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

function ensureBooted(udid, log) {
  const state = listSimulators().find((d) => d.udid === udid)?.state;
  if (state === "Booted") return;
  log(`Booting ${udid}...`);
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

// --- Point-bounds lookup (portrait, logical points) -------------------------
//
// Used for mapping normalized browser coordinates → simulator points. iOS
// logical dimensions don't change between sim and device for a given model,
// so hardcoded values are safe. Fallback preserves aspect for unknown devices.

export function boundsForDeviceType(type = "") {
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

// --- MJPEG source ------------------------------------------------------------
//
// AXe's `stream-video --format mjpeg` writes a complete HTTP response on
// stdout: status line, headers, then the multipart body. The hub wants the
// body only. Returns a function that takes each stdout chunk and returns the
// part of it that belongs to the body (empty before the preamble has ended).
export function stripHttpPreamble() {
  let pre = Buffer.alloc(0);
  let stripped = false;
  return (chunk) => {
    if (stripped) return chunk;
    pre = Buffer.concat([pre, chunk]);
    const end = pre.indexOf("\r\n\r\n");
    if (end < 0) return Buffer.alloc(0);
    const body = pre.subarray(end + 4);
    pre = null;
    stripped = true;
    return body;
  };
}

// --- Input translation -------------------------------------------------------

// HID keycodes for common keys (USB HID usage IDs)
export const KEYCODES = Object.freeze({
  return: 40, enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  space: 44,
  right: 79, left: 80, down: 81, up: 82,
  home: 74, end: 77,
  pageup: 75, pagedown: 78,
  delete: 76,
});

// Hardware buttons AXe may be asked for. `screenshot` is not among them: it
// is a capture, not an input, and the server routes it to screenshot().
export const BUTTONS = Object.freeze(["home", "lock", "side-button", "siri", "apple-pay"]);

// The `axe` argv (without --udid) for one input event, or null for an event
// that needs no command (`type` with nothing to type). Throws on anything it
// cannot express; the message is the viewer's error toast.
export function axeInputArgs(evt, bounds) {
  const pt = (nx, ny) => ({
    x: Math.round(Math.max(0, Math.min(1, nx ?? 0)) * bounds.w),
    y: Math.round(Math.max(0, Math.min(1, ny ?? 0)) * bounds.h),
  });
  switch (evt?.type) {
    case "tap": {
      const p = pt(evt.x, evt.y);
      // `physical` = a touch down/up pair. AXe's default for a coordinate tap
      // (FBSimulator tapAt) acks but lands nowhere on iOS 27 simulators.
      return ["tap", "-x", String(p.x), "-y", String(p.y), "--tap-style", "physical"];
    }
    case "tap-label":
      return tapLabelArgs(evt.text);
    case "long-press": {
      const p = pt(evt.x, evt.y);
      const sec = (evt.duration || 800) / 1000;
      return ["touch", "-x", String(p.x), "-y", String(p.y), "--down", "--up", "--delay", String(sec)];
    }
    case "swipe": {
      const a = pt(evt.fromX, evt.fromY);
      const b = pt(evt.toX, evt.toY);
      const sec = (evt.duration || 300) / 1000;
      return [
        "swipe",
        "--start-x", String(a.x), "--start-y", String(a.y),
        "--end-x", String(b.x), "--end-y", String(b.y),
        "--duration", String(sec),
      ];
    }
    case "type":
      if (!evt.text) return null;
      return ["type", evt.text];
    case "key": {
      const code = typeof evt.key === "number" ? evt.key : KEYCODES[String(evt.key).toLowerCase()];
      if (!code) throw new Error(`unknown key: ${evt.key}`);
      return ["key", String(code)];
    }
    case "button":
      if (!BUTTONS.includes(evt.name)) throw new Error(`unknown button: ${evt.name}`);
      return ["button", evt.name];
    default:
      throw new Error(`unknown event type: ${evt?.type}`);
  }
}

// `axe type` sends one HID event per char; long strings take real time. A tap
// by label or id first reads the accessibility tree, which can take several
// seconds while the screen is mid-transition (7 s seen). Other commands (tap,
// swipe, button, key) are fast; 5 s is plenty.
export function axeTimeoutMs(argv) {
  if (argv[0] === "type") return Math.max(10_000, (argv[1]?.length || 0) * 80);
  if (argv[0] === "tap" && /^--(label|id)=/.test(argv[1] ?? "")) return 15_000;
  return 5000;
}

// --- Process helpers ---------------------------------------------------------

// Runs one `axe` command to completion. Rejections carry AXe's raw output as
// `err.stderr`; a timeout or spawn failure has none.
function runAxe(axe, udid, argv) {
  return new Promise((resolve, reject) => {
    const full = [...argv, "--udid", udid];
    const timeoutMs = axeTimeoutMs(argv);
    const proc = spawn(axe, full, { stdio: ["ignore", "pipe", "pipe"] });
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
      else reject(Object.assign(new Error(`axe ${argv.join(" ")} exit=${code} ${stderr.trim()}`), { stderr }));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Async screenshot via simctl. Does NOT go through the command queue, which is
// reserved for HID input, but still avoids blocking the event loop the way
// execFileSync would.
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

// Echoes a child's stderr line by line under `prefix`, minus lines matching
// `skip`. A child that never ends its line must not grow the buffer without
// bound.
export function relayStderr(stream, prefix, skip) {
  let partial = "";
  stream.on("data", (d) => {
    const lines = (partial + d.toString()).split("\n");
    partial = lines.pop();
    if (partial.length > 4096) lines.push(partial), partial = "";
    for (const line of lines) {
      if (!skip?.test(line)) process.stderr.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (partial && !skip?.test(partial)) process.stderr.write(`${prefix} ${partial}\n`);
  });
}

// The `axe stream-video` MJPEG process as a hub source: "data" is the bare
// multipart body, "exit" fires once with a detail string, kill() ends it.
function openAxeMjpeg(axe, udid, { fps, quality, scale }, log) {
  const cmdArgs = [
    "stream-video",
    "--udid", udid,
    "--format", "mjpeg",
    "--fps", String(fps),
    "--quality", String(quality),
    "--scale", String(scale),
  ];
  log(`spawn: ${axe} ${cmdArgs.join(" ")}`);
  const proc = spawn(axe, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
  if (!proc.stdout || !proc.stderr) {
    proc.on("error", () => {});
    proc.kill("SIGKILL");
    throw new Error("could not spawn axe");
  }
  const source = new EventEmitter();
  const strip = stripHttpPreamble();
  let done = false;
  const end = (detail) => {
    if (done) return;
    done = true;
    log(`axe stream-video exited (${detail})`);
    source.emit("exit", detail);
  };
  source.kill = () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  };
  proc.stdout.on("data", (chunk) => {
    const body = strip(chunk);
    if (body.length) source.emit("data", body);
  });
  proc.stdout.on("error", () => {});
  // AXe's "Captured N frames (X FPS actual)" progress counters are noise.
  relayStderr(proc.stderr, "[axe stream]", /^(Captured \d+ frames|Streamed \d+ frames)/);
  proc.on("exit", (code, sig) => end(`code=${code} sig=${sig}`));
  proc.on("error", (e) => end(`failed (${e.message})`));
  return source;
}

// The H.264 pipeline: `axe stream-video --format bgra | sim-stream-encoder`,
// as two child processes, in the shape H264Hub expects — an emitter with
// "data" (chunks of encoder records), "exit" (once, when both processes are
// gone) and kill().
function spawnH264Pipeline(axe, udid, encoder, plan, log) {
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
  log(`spawn: ${axe} ${axeArgs.join(" ")} | sim-stream-encoder ${encArgs.join(" ")}`);

  // A spawn that fails for lack of file descriptors comes back without its
  // stdio streams (and reports through "error"); there is no pipeline to build.
  const abandon = (procs, message) => {
    for (const proc of procs) {
      proc.on("error", () => {});
      proc.kill("SIGKILL");
    }
    throw new Error(message);
  };
  const axeProc = spawn(axe, axeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  if (!axeProc.stdout || !axeProc.stderr) abandon([axeProc], "could not spawn axe");
  // AXe's stdout is handed to the helper as its stdin — a file descriptor, not
  // a Node stream: the raw frames are ~95 MB/s at the default scale and must
  // never pass through this process.
  let enc;
  try {
    enc = spawn(encoder, encArgs, { stdio: [axeProc.stdout, "pipe", "pipe"] });
  } catch (e) {
    abandon([axeProc], `could not spawn the encoder (${e.message})`);
  } finally {
    // Drop our copy of the read end. While we held it, a dead helper would
    // leave AXe writing into a pipe nobody reads, instead of getting EPIPE.
    axeProc.stdout.destroy();
  }
  if (!enc.stdout || !enc.stderr) abandon([axeProc, enc], "could not spawn the encoder");

  const pipeline = new EventEmitter();
  const procs = [["axe", axeProc], ["encoder", enc]];
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
  relayStderr(axeProc.stderr, "[axe video]", chatter);
  relayStderr(enc.stderr, "[encoder]");
  return pipeline;
}

// Decides once, at startup, whether the H.264 path exists for this run.
// Returns planCapture()'s result, or { ok: false, reason }. Never throws:
// every failure just means "MJPEG only".
async function planH264(udid, { encoder, fps, scale }) {
  try {
    fs.accessSync(encoder, fs.constants.X_OK);
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
    return planCapture({ source, scale, fps });
  } catch (e) {
    return { ok: false, reason: `could not measure the simulator screen (${e.message})` };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- The backend -------------------------------------------------------------

// Picks (or takes) a simulator, boots it, resolves `axe`, decides the H.264
// plan, and returns the backend (docs/architecture.md § Backends).
//
//   udid      pin to this simulator; null = auto-pick
//   mjpeg     { fps, quality, scale } for `axe stream-video --format mjpeg`
//   h264      { encoder, fps, scale } — the helper binary's path and what to
//             ask for; the plan is { ok: false, reason } when the path is off
//   log(line) startup and lifecycle lines, already prefixed
export async function createSimulatorBackend({ udid = null, mjpeg, h264, log = () => {} }) {
  // The binary first: a missing `axe` must fail before a simulator is booted.
  const axe = axeBinary();
  const sim = pickSimulator(listSimulators(), udid);
  log(`[sim] selected: ${sim.name} (${sim.udid}) state=${sim.state}`);
  ensureBooted(sim.udid, (line) => log(`[sim] ${line}`));
  const bounds = boundsForDeviceType(sim.deviceType);
  const plan = await planH264(sim.udid, h264);
  const queue = new SerialQueue();

  return {
    kind: "simulator",
    target: sim,
    bounds,
    h264: plan,
    mjpegBoundary: MJPEG_BOUNDARY,

    openMjpeg() {
      return openAxeMjpeg(axe, sim.udid, mjpeg, (line) => log(`[mjpeg] ${line}`));
    },

    h264Pipeline() {
      if (!plan.ok) throw new Error(`H.264 is off: ${plan.reason}`);
      return spawnH264Pipeline(axe, sim.udid, h264.encoder, plan, (line) => log(`[h264] ${line}`));
    },

    async input(evt) {
      const argv = axeInputArgs(evt, bounds);
      if (!argv) return;
      try {
        await queue.push(() => runAxe(axe, sim.udid, argv));
      } catch (e) {
        if (evt.type !== "tap-label" || e.stderr === undefined) throw e;
        // AXe's own words ("No accessibility element matched --label 'X'.")
        // are the viewer's error toast; the full output stays in the log.
        log(`[ws] ${e.message}`);
        throw new Error(axeErrorLine(e.stderr) || e.message);
      }
      // tapLabelArgs() proved the target a string.
      if (evt.type === "tap-label") return { detail: evt.text.trim() };
    },

    screenshot(dest) {
      return runScreenshot(sim.udid, dest);
    },

    // Nothing to tear down: the capture processes belong to the hubs, and
    // input commands are one-shot.
    stop() {},
  };
}
