// sim-stream: serves an iOS Simulator to a web browser.
//
// Two channels to each client:
//   - GET /stream  — MJPEG, from `axe stream-video --format mjpeg` (stdout
//     proxied after stripping AXe's HTTP preamble).
//   - WS /ws       — JSON input events (tap/swipe/type/button/key),
//     dispatched as AXe commands through a FIFO queue.
//
// See README.md for the full architecture.

import express from "express";
import { WebSocketServer } from "ws";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Flags that take a value. Anything else is treated as a boolean switch.
// Keeping this explicit means `--token --port 9090` fails loudly instead of
// silently treating `token` as a boolean and eating the next flag.
const VALUE_FLAGS = new Set([
  "port", "host", "fps", "quality", "scale", "udid", "token", "auth",
]);

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
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || process.env.PORT || "8080", 10);
const HOST = args.host || process.env.HOST || "127.0.0.1";
const FPS = parseInt(args.fps || "15", 10);
const QUALITY = parseInt(args.quality || "75", 10);
const SCALE = parseFloat(args.scale || "0.5");
const REQUIRE_AUTH = args.auth !== "false";
const TOKEN = REQUIRE_AUTH ? (args.token || randomBytes(12).toString("hex")) : null;
const TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null;

function tokenMatches(provided) {
  if (!TOKEN_BUF) return true;
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  if (a.length !== TOKEN_BUF.length) return false;
  return timingSafeEqual(a, TOKEN_BUF);
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
      await queue.push(["tap", "-x", String(p.x), "-y", String(p.y)]);
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
        const dest = `${process.env.HOME}/Desktop/sim-stream-${Date.now()}.png`;
        await runScreenshot(queue.udid, dest);
        console.log(`[button] screenshot saved to ${dest}`);
        return { detail: `saved to ${dest.replace(process.env.HOME, "~")}` };
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

// --- Server ---------------------------------------------------------------

async function main() {
  const sim = pickSimulator();
  console.log(`[sim] selected: ${sim.name} (${sim.udid}) state=${sim.state}`);
  ensureBooted(sim.udid);

  const hub = new MjpegHub(sim.udid);
  const queue = new CommandQueue(sim.udid);

  const bounds = boundsForDeviceType(sim.deviceType);
  const app = express();

  // Templated HTML: inject the real aspect-ratio into the page so the img tag
  // reserves correct dimensions before /api/info returns (avoids layout flash).
  const htmlTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const renderedHtml = htmlTemplate.replace("__ASPECT__", `${bounds.w} / ${bounds.h}`);

  const authCheck = (req, res, next) => {
    if (!REQUIRE_AUTH) return next();
    const provided = req.query.token || req.headers["x-token"];
    if (tokenMatches(provided)) return next();
    return res.status(401).type("text/plain").send("Unauthorized");
  };

  app.get("/", authCheck, (req, res) => res.type("html").send(renderedHtml));
  app.get("/api/info", authCheck, (req, res) => res.json({ simulator: sim, bounds, fps: FPS, quality: QUALITY, scale: SCALE }));

  app.get("/stream", authCheck, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=--mjpegstream",
      "Cache-Control": "no-cache, private, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "close",
      "X-Accel-Buffering": "no",
    });
    hub.addClient(res);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const safeSend = (ws, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  };
  const broadcast = (payload) => {
    for (const ws of wss.clients) safeSend(ws, payload);
  };
  hub.on("status", (status) => broadcast({ type: "stream", status }));

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/ws") return socket.destroy();
    if (REQUIRE_AUTH && !tokenMatches(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    console.log("[ws] connected");
    safeSend(ws, { type: "hello", simulator: sim, bounds, stream: hub.status });
    ws.on("message", async (raw) => {
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

  server.listen(PORT, HOST, () => {
    const hostShown = HOST === "0.0.0.0" ? "localhost" : HOST;
    const url = `http://${hostShown}:${PORT}/${TOKEN ? `?token=${TOKEN}` : ""}`;
    console.log("");
    console.log("  sim-stream running");
    console.log(`  → ${url}`);
    if (TOKEN) console.log(`  token:     ${TOKEN}`);
    console.log(`  simulator: ${sim.name} (${sim.udid})`);
    console.log(`  stream:    ${FPS}fps scale=${SCALE} quality=${QUALITY}`);
    console.log("");
  });

  const shutdown = () => {
    console.log("\n[shutdown] cleaning up...");
    hub.stop();
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
