// Unit tests for the device backend. Run with `npm test`.
//
// Driven against an in-process fake WebDriverAgent (JSON API + an MJPEG
// server) and test/fixtures/fake-ios, which forwards its host port to that
// MJPEG server the way `ios forward` forwards to the device's 9100. No device
// needed. Pinned here is what fails silently or leaks: WDA settings that do
// not match the flags, a stream opened through someone else's listener, a
// session retry that loops, a forward that outlives the server, a missing WDA
// with no advice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_WDA,
  INPUT_NOT_SUPPORTED,
  WdaClient,
  createDeviceBackend,
  deviceTarget,
  parseBoundary,
  resolveDeviceSpec,
  wdaSettings,
} from "../backends/device.js";

const FAKE_IOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ios");
const UDID = "00008140-001A69993C79401C";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

// A fake WDA. `sessionGone` makes the next N session-scoped calls (other than
// settings) answer 404
// invalid session id; every request is recorded.
function fakeWda({ sessionGone = 0, size = { width: 390, height: 844 } } = {}) {
  const state = { requests: [], settings: [], sessions: 0, sessionGone };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url}`);
      const send = (status, value, sessionId = null) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ value, sessionId }));
      };
      if (req.url === "/status") return send(200, { ready: true, message: "WebDriverAgent is ready to accept commands" });
      if (req.method === "POST" && req.url === "/session") {
        state.sessions++;
        return send(200, { sessionId: `S${state.sessions}`, capabilities: {} }, `S${state.sessions}`);
      }
      if (req.url === "/screenshot") return send(200, PNG.toString("base64"));
      if (req.url === "/wda/device/info") return send(200, { name: "iPhone", model: "iPhone" });
      const m = /^\/session\/([^/]+)(\/.*)$/.exec(req.url);
      if (m) {
        const gone = m[2] !== "/appium/settings" && state.sessionGone-- > 0;
        if (gone || m[1] !== `S${state.sessions}`) {
          return send(404, { error: "invalid session id", message: "Session does not exist" });
        }
        if (m[2] === "/appium/settings") {
          state.settings.push(JSON.parse(body).settings);
          return send(200, JSON.parse(body).settings);
        }
        if (m[2] === "/window/size") return send(200, size);
      }
      send(404, { error: "unknown command", message: `Unhandled endpoint: ${req.url}` });
    });
  });
  return { server, state };
}

// WDA's MJPEG server: its real headers, then two frames and a held connection.
function fakeMjpeg({ contentType = "multipart/x-mixed-replace; boundary=--BoundaryString" } = {}) {
  const state = { connections: 0 };
  const server = http.createServer((req, res) => {
    state.connections++;
    res.writeHead(200, { Server: "WDA MJPEG Server", "Content-Type": contentType, Connection: "close" });
    const frame = (n) => `--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPG${n}\r\n\r\n`;
    res.write(frame(1));
    setTimeout(() => res.write(frame(2)), 20);
  });
  return { server, state };
}

async function rig(t, { mode = "ok", wdaOpts, mjpegOpts } = {}) {
  const wda = fakeWda(wdaOpts);
  const mjpeg = fakeMjpeg(mjpegOpts);
  const wdaPort = await listen(wda.server);
  const mjpegPort = await listen(mjpeg.server);
  process.env.FAKE_IOS_MODE = mode;
  process.env.FAKE_IOS_UDID = UDID;
  process.env.FAKE_MJPEG_PORT = String(mjpegPort);
  const logs = [];
  const make = (opts = {}) => createDeviceBackend({
    device: UDID,
    wda: `http://127.0.0.1:${wdaPort}`,
    mjpeg: { fps: 30, scale: 0.5, quality: 75 },
    log: (l) => logs.push(l),
    ios: FAKE_IOS,
    readyTimeoutMs: 1500,
    ...opts,
  });
  t.after(async () => { await close(wda.server); await close(mjpeg.server); });
  return { wda, mjpeg, wdaPort, logs, make };
}

// The fake forward children now running (the backend exposes no pid).
const fakeForwardPids = () => {
  try {
    return execFileSync("pgrep", ["-f", "fake-ios forward"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

// --- Pure pieces -------------------------------------------------------------

test("wdaSettings: the shared flags become WDA's MJPEG settings", () => {
  assert.deepEqual(wdaSettings({ fps: 30, scale: 0.5, quality: 75 }), {
    mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 75,
  });
  // Clamped into WDA's ranges, never passed through.
  assert.deepEqual(wdaSettings({ fps: 500, scale: 3, quality: 0 }), {
    mjpegServerFramerate: 60, mjpegScalingFactor: 100, mjpegServerScreenshotQuality: 1,
  });
  assert.equal(wdaSettings({ fps: 15, scale: 0.001, quality: 60 }).mjpegScalingFactor, 1);
  assert.throws(() => wdaSettings({ fps: NaN, scale: 0.5, quality: 75 }), /--fps must be a number/);
  assert.throws(() => wdaSettings({ fps: 30, scale: "big", quality: 75 }), /--scale must be a number/);
});

test("deviceTarget: go-ios's identity in the target's shape", () => {
  assert.deepEqual(
    deviceTarget({ DeviceName: "MGL-QA-16E", ProductType: "iPhone17,5", ProductVersion: "26.6.2" }, UDID),
    { udid: UDID, name: "MGL-QA-16E", state: "Connected", runtime: "iOS 26.6.2", deviceType: "iPhone17,5" },
  );
  assert.deepEqual(deviceTarget(null, "U"), { udid: "U", name: "iOS device", state: "Connected", runtime: "iOS", deviceType: "unknown" });
});

test("parseBoundary: verbatim, dashes included, quoted or not", () => {
  assert.equal(parseBoundary("multipart/x-mixed-replace; boundary=--BoundaryString"), "--BoundaryString");
  assert.equal(parseBoundary('multipart/x-mixed-replace; boundary="--a b"; charset=x'), "--a b");
  assert.equal(parseBoundary("image/jpeg"), null);
  assert.equal(parseBoundary(undefined), null);
});

test("resolveDeviceSpec: a UDID uses --wda or the default; a role asks qa-device", () => {
  const never = () => { throw new Error("qa-device must not run for a UDID"); };
  assert.deepEqual(resolveDeviceSpec(UDID, { run: never }), { udid: UDID, wda: DEFAULT_WDA, role: null });
  assert.deepEqual(resolveDeviceSpec(UDID, { wda: "http://h:1", run: never }), { udid: UDID, wda: "http://h:1", role: null });

  const calls = [];
  const run = (cmd, argv) => {
    calls.push([cmd, ...argv].join(" "));
    return argv[0] === "udid" ? `${UDID}\n` : "8101\n";
  };
  assert.deepEqual(resolveDeviceSpec("primary", { run }), { udid: UDID, wda: "http://localhost:8101", role: "primary" });
  assert.deepEqual(calls, ["qa-device udid primary", "qa-device port primary"]);
  // An explicit --wda wins over the role's port (and the port is not asked).
  calls.length = 0;
  assert.equal(resolveDeviceSpec("tablet", { wda: "http://x:9", run }).wda, "http://x:9");
  assert.deepEqual(calls, ["qa-device udid tablet"]);
});

test("resolveDeviceSpec: refusals carry the fix", () => {
  const enoent = () => { throw Object.assign(new Error("spawn qa-device ENOENT"), { code: "ENOENT" }); };
  assert.throws(() => resolveDeviceSpec("primary", { run: enoent }), /qa-device is not on PATH — pass the device's UDID and --wda/);
  const fails = () => { throw Object.assign(new Error("exit 1"), { stderr: "qa-device: unknown role\n" }); };
  assert.throws(() => resolveDeviceSpec("secondary", { run: fails }), /qa-device udid secondary failed: qa-device: unknown role/);
  assert.throws(() => resolveDeviceSpec("primary", { run: () => "oops" }), /not a port/);
  assert.throws(() => resolveDeviceSpec("", {}), /needs a UDID or a bench role/);
  assert.throws(() => resolveDeviceSpec("a b", {}), /needs a UDID or a bench role/);
});

// --- WdaClient ---------------------------------------------------------------

test("WdaClient: a dead session is re-created and the call retried once — never a loop", async (t) => {
  const wda = fakeWda({ sessionGone: 1 });
  const port = await listen(wda.server);
  t.after(() => close(wda.server));
  const settings = { mjpegServerFramerate: 30 };
  const client = new WdaClient(`http://127.0.0.1:${port}`, { settings });
  assert.deepEqual(await client.session("GET", "/window/size"), { width: 390, height: 844 });
  // First session's call was refused → one new session, settings re-applied.
  assert.equal(wda.state.sessions, 2);
  assert.equal(wda.state.settings.length, 2);

  wda.state.sessionGone = 5;
  wda.state.requests.length = 0;
  await assert.rejects(client.session("GET", "/window/size"), /WDA GET \/session\/S\d\/window\/size: Session does not exist/);
  // One failed call, one re-create (+ its settings call), one retry: four requests, no more.
  assert.equal(wda.state.requests.length, 4);
});

// --- createDeviceBackend -----------------------------------------------------

test("createDeviceBackend: identity, bounds, settings, boundary; streams through the forward", async (t) => {
  const { wda, mjpeg, logs, make } = await rig(t);
  const backend = await make();
  t.after(() => backend.stop());

  assert.equal(backend.kind, "device");
  assert.deepEqual(backend.target, { udid: UDID, name: "MGL-QA-16E", state: "Connected", runtime: "iOS 26.6.2", deviceType: "iPhone17,5" });
  assert.deepEqual(backend.bounds, { w: 390, h: 844 });
  assert.equal(backend.mjpegBoundary, "--BoundaryString");
  assert.equal(backend.h264.ok, false);
  assert.match(backend.h264.reason, /9\.4/);
  assert.deepEqual(wda.state.settings, [{ mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 75 }]);
  assert.ok(logs.some((l) => l.startsWith("[device] selected: MGL-QA-16E")), logs.join("\n"));

  // The hub's source: a clean multipart body (no HTTP headers), exit on kill.
  const source = backend.openMjpeg();
  const chunks = [];
  source.on("data", (c) => chunks.push(c));
  assert.ok(await waitFor(() => Buffer.concat(chunks).includes("JPG2")));
  assert.ok(Buffer.concat(chunks).subarray(0, 16).equals(Buffer.from("--BoundaryString")));
  let exits = 0;
  source.on("exit", () => exits++);
  source.kill();
  assert.ok(await waitFor(() => exits === 1));
  assert.ok(mjpeg.state.connections >= 2, "startup probe + the stream");
});

test("createDeviceBackend: screenshots are WDA's PNG; input is refused; H.264 throws", async (t) => {
  const { make } = await rig(t);
  const backend = await make();
  t.after(() => backend.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-stream-dev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, "shot.png");
  await backend.screenshot(dest);
  assert.ok(fs.readFileSync(dest).equals(PNG));
  await assert.rejects(backend.input({ type: "tap", x: 0.5, y: 0.5 }), new RegExp(INPUT_NOT_SUPPORTED.replace(/[()]/g, "\\$&")));
  assert.throws(() => backend.h264Pipeline(), /H\.264 is off/);
});

test("createDeviceBackend: stop() kills the forward, and the stream then refuses to open", async (t) => {
  const { make } = await rig(t);
  const before = new Set(fakeForwardPids());
  const backend = await make();
  const pids = fakeForwardPids().filter((p) => !before.has(p));
  assert.equal(pids.length, 1, "one forward child");
  backend.stop();
  assert.ok(await waitFor(() => !alive(pids[0])), "forward still running after stop()");
  assert.throws(() => backend.openMjpeg(), /port-forward to the device has exited/);
});

test("createDeviceBackend: a missing WDA fails at startup with qa-device up <role>, before any forward", async (t) => {
  const { make } = await rig(t);
  const before = fakeForwardPids().length;
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await close(dead);
  const run = (cmd, argv) => (cmd === "qa-device" ? (argv[0] === "udid" ? UDID : String(deadPort)) : execFileSync(cmd, argv, { encoding: "utf8" }));
  await assert.rejects(make({ device: "primary", wda: null, run }), /WebDriverAgent is not answering at http:\/\/localhost:\d+ .*Start it with: qa-device up primary/);
  await assert.rejects(make({ wda: `http://127.0.0.1:${deadPort}` }), /Start it with: qa-device up <role>/);
  assert.equal(fakeForwardPids().length, before);
});

test("createDeviceBackend: a port already in use fails loudly, with go-ios's words", async (t) => {
  const { make } = await rig(t, { mode: "inuse" });
  await assert.rejects(make(), /address already in use/);
});

test("createDeviceBackend: a listener that is not WDA's MJPEG is never trusted", async (t) => {
  const { make } = await rig(t, { mjpegOpts: { contentType: "text/html" } });
  const before = new Set(fakeForwardPids());
  await assert.rejects(make(), /answered HTTP 200 text\/html, not an MJPEG stream/);
  // The forward it started is killed, not left behind.
  assert.ok(await waitFor(() => fakeForwardPids().filter((p) => !before.has(p)).length === 0));
});

test("createDeviceBackend: without go-ios's identity it falls back to WDA's device info", async (t) => {
  const { logs, make } = await rig(t, { mode: "noinfo" });
  const backend = await make();
  t.after(() => backend.stop());
  assert.equal(backend.target.name, "iPhone");
  assert.ok(logs.some((l) => /ios info failed/.test(l)));
});

test("createDeviceBackend: a missing go-ios binary names the install command", async (t) => {
  const { make } = await rig(t);
  await assert.rejects(make({ ios: "/nonexistent/ios" }), /npm i -g go-ios/);
});
