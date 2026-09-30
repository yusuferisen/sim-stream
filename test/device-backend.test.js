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
  WdaClient,
  createDeviceBackend,
  deviceTarget,
  labelPredicate,
  parseBoundary,
  pickLabelTarget,
  resolveDeviceSpec,
  tapActions,
  wdaInputRequest,
  wdaSettings,
} from "../backends/device.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_IOS = path.join(FIXTURES, "fake-ios");
const FAKE_ENCODER = path.join(FIXTURES, "fake-encoder");
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
// settings) answer 404 invalid session id; every request is recorded, input
// bodies too. `locked` is the lock state (a home-screen press clears it unless
// `stuckLocked`); `elements` maps a predicate to the matches' rects.
function fakeWda({ sessionGone = 0, size = { width: 390, height: 844 }, locked = false, stuckLocked = false, elements = {} } = {}) {
  const state = { requests: [], settings: [], input: [], sessions: 0, sessionGone, locked, rects: {} };
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
      if (req.method === "POST" && req.url === "/wda/homescreen") {
        if (!stuckLocked) state.locked = false;
        return send(200, null);
      }
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
        if (m[2] === "/wda/locked") return send(200, state.locked);
        if (req.method === "POST" && ["/actions", "/wda/keys", "/wda/pressButton", "/wda/lock"].includes(m[2])) {
          state.input.push({ path: m[2], body: JSON.parse(body) });
          return send(200, null);
        }
        if (req.method === "POST" && m[2] === "/elements") {
          const rects = elements[JSON.parse(body).value] ?? [];
          const found = rects.map((r, i) => {
            const id = `E${Object.keys(state.rects).length + i}`;
            return [id, r];
          });
          for (const [id, r] of found) state.rects[id] = r;
          return send(200, found.map(([id]) => ({ ELEMENT: id, "element-6066-11e4-a52e-4f735466cecf": id })));
        }
        const el = /^\/element\/([^/]+)\/rect$/.exec(m[2]);
        if (el && state.rects[el[1]]) return send(200, state.rects[el[1]]);
      }
      send(404, { error: "unknown command", message: `Unhandled endpoint: ${req.url}` });
    });
  });
  return { server, state };
}

// A marker-valid JPEG header (not decodable): an APP1 holding a thumbnail with
// its own SOI/EOI and SOF, then the image's SOF0 of width×height, SOS, data.
function fakeJpeg(width, height) {
  const sof = (w, h) => [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const thumb = [0xff, 0xd8, ...sof(160, 120), 0xff, 0xd9];
  const app1 = [0xff, 0xe1, 0x00, 2 + 6 + thumb.length, ...Buffer.from("Exif\0\0", "latin1"), ...thumb];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  return Buffer.from([0xff, 0xd8, ...app1, ...sof(width, height), ...sos, 0x11, 0xff, 0x00, 0x11, 0xff, 0xd9]);
}

// WDA's MJPEG server: its real headers, then two frames and a held connection.
// `jpeg` makes the frames fakeJpeg(width, height) instead of "JPG<n>";
// `end` closes the stream after the frames.
function fakeMjpeg({ contentType = "multipart/x-mixed-replace; boundary=--BoundaryString", jpeg = null, end = false } = {}) {
  const state = { connections: 0 };
  const server = http.createServer((req, res) => {
    state.connections++;
    res.writeHead(200, { Server: "WDA MJPEG Server", "Content-Type": contentType, Connection: "close" });
    const frame = (n) => {
      const body = jpeg ? fakeJpeg(jpeg.width, jpeg.height) : Buffer.from(`JPG${n}`);
      return Buffer.concat([
        Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`),
        body,
        Buffer.from("\r\n\r\n"),
      ]);
    };
    res.write(frame(1));
    setTimeout(() => {
      if (res.destroyed) return;
      res.write(frame(2));
      if (end) res.end();
    }, 20);
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

// --- Input translation -------------------------------------------------------

const B = { w: 390, h: 844 };
const pointer = (req) => req.body.actions[0].actions;

test("wdaInputRequest: taps, long-presses and swipes are W3C touch actions in points", () => {
  const tap = wdaInputRequest({ type: "tap", x: 0.5, y: 0.25 }, B);
  assert.equal(tap.method, "POST");
  assert.equal(tap.path, "/actions");
  assert.equal(tap.body.actions[0].parameters.pointerType, "touch");
  assert.deepEqual(pointer(tap), [
    { type: "pointerMove", duration: 0, x: 195, y: 211 },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 50 },
    { type: "pointerUp", button: 0 },
  ]);
  // Clamped to the screen, like the simulator's axe arguments; junk is 0.
  assert.deepEqual(pointer(wdaInputRequest({ type: "tap", x: 1.7, y: -3 }, B))[0], { type: "pointerMove", duration: 0, x: 390, y: 0 });
  assert.deepEqual(pointer(wdaInputRequest({ type: "tap", x: "nope" }, B))[0], { type: "pointerMove", duration: 0, x: 0, y: 0 });

  const lp = wdaInputRequest({ type: "long-press", x: 0.1, y: 0.1, duration: 1200 }, B);
  assert.equal(pointer(lp)[2].duration, 1200);
  assert.equal(pointer(wdaInputRequest({ type: "long-press", x: 0, y: 0 }, B))[2].duration, 800);
  // The request's timeout outlasts the gesture itself.
  assert.ok(lp.timeoutMs > 1200 + 5000);

  const sw = wdaInputRequest({ type: "swipe", fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.25, duration: 250 }, B);
  assert.deepEqual(pointer(sw), [
    { type: "pointerMove", duration: 0, x: 195, y: 633 },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 50 },
    { type: "pointerMove", duration: 250, x: 195, y: 211 },
    { type: "pointerUp", button: 0 },
  ]);
  // A hostile duration cannot hold the queue for minutes.
  assert.equal(pointer(wdaInputRequest({ type: "swipe", duration: 1e9 }, B))[3].duration, 10_000);
});

test("wdaInputRequest: text and the keys WDA can type go through /wda/keys; the rest are refused", () => {
  assert.deepEqual(wdaInputRequest({ type: "type", text: "héllo 👋" }, B), { method: "POST", path: "/wda/keys", body: { value: ["héllo 👋"] }, timeoutMs: 10_000 });
  assert.ok(wdaInputRequest({ type: "type", text: "x".repeat(500) }, B).timeoutMs >= 50_000);
  assert.equal(wdaInputRequest({ type: "type", text: "" }, B), null);
  assert.equal(wdaInputRequest({ type: "type" }, B), null);
  const key = (k) => wdaInputRequest({ type: "key", key: k }, B).body.value[0];
  assert.equal(key("return"), "\n");
  assert.equal(key("Return"), "\n");
  assert.equal(key("backspace"), "\b");
  assert.equal(key("tab"), "\t");
  assert.equal(key("space"), " ");
  for (const k of ["escape", "up", "delete", 40, "constructor", undefined]) {
    assert.throws(() => wdaInputRequest({ type: "key", key: k }, B), /key is not available on a real device/);
  }
});

test("wdaInputRequest: home and lock go through WDA; Siri and Apple Pay are refused", () => {
  assert.deepEqual(wdaInputRequest({ type: "button", name: "home" }, B), { method: "POST", path: "/wda/homescreen", body: {}, sessionless: true, timeoutMs: 15_000 });
  assert.equal(wdaInputRequest({ type: "button", name: "lock" }, B).path, "/wda/lock");
  assert.equal(wdaInputRequest({ type: "button", name: "side-button" }, B).path, "/wda/lock");
  assert.throws(() => wdaInputRequest({ type: "button", name: "siri" }, B), /Siri button is not available on a real device/);
  assert.throws(() => wdaInputRequest({ type: "button", name: "apple-pay" }, B), /Apple Pay button is not available/);
  assert.throws(() => wdaInputRequest({ type: "button", name: "toString" }, B), /unknown button: toString/);
  assert.throws(() => wdaInputRequest({ type: "nope" }, B), /unknown event type: nope/);
  assert.throws(() => wdaInputRequest(null, B), /unknown event type/);
});

test("labelPredicate: label or name, with the literal escaped", () => {
  assert.equal(labelPredicate({ by: "label", target: "Sign In" }), 'label == "Sign In"');
  assert.equal(labelPredicate({ by: "id", target: "login.submit" }), 'name == "login.submit"');
  assert.equal(labelPredicate({ by: "label", target: 'say "hi" \\o/' }), 'label == "say \\"hi\\" \\\\o/"');
});

test("pickLabelTarget: off-screen matches are ignored; nested ones are one control; several are refused", () => {
  const T = { by: "label", target: "Search" };
  const r = (x, y, width, height) => ({ x, y, width, height });
  assert.deepEqual(pickLabelTarget([r(0, 0, 0, 0), r(116, 750, 68, 68)], T, B), { x: 150, y: 784 });
  // A button and its own icon and text all carry the label.
  assert.deepEqual(pickLabelTarget([r(170, 697, 12, 11), r(156, 688, 78, 30), r(182, 695, 41, 15)], T, B), { x: 195, y: 703 });
  assert.throws(() => pickLabelTarget([], T, B), /^Error: No on-screen element matched label 'Search'\.$/);
  // A zero rect (another home-screen page) and a centre off the screen.
  assert.throws(() => pickLabelTarget([r(0, 0, 0, 0), r(500, 100, 40, 40)], T, B), /No on-screen element/);
  assert.throws(() => pickLabelTarget([r(10, 10, 40, 40), r(200, 10, 40, 40)], { by: "id", target: "cell" }, B), /Multiple \(2\) on-screen elements matched #'cell'/);
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
  assert.match(backend.h264.reason, /no encoder helper configured/);
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

test("createDeviceBackend: screenshots are WDA's PNG; H.264 throws", async (t) => {
  const { make } = await rig(t);
  const backend = await make();
  t.after(() => backend.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-stream-dev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, "shot.png");
  await backend.screenshot(dest);
  assert.ok(fs.readFileSync(dest).equals(PNG));
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

// --- Input through the backend -----------------------------------------------

test("input: every command goes through WDA in order, one at a time", async (t) => {
  const { wda, make } = await rig(t);
  const backend = await make();
  t.after(() => backend.stop());
  const acks = await Promise.all([
    backend.input({ type: "tap", x: 0.5, y: 0.5 }),
    backend.input({ type: "type", text: "abc" }),
    backend.input({ type: "key", key: "return" }),
    backend.input({ type: "button", name: "home" }),
    backend.input({ type: "type", text: "" }),
  ]);
  assert.deepEqual(acks, [undefined, undefined, undefined, undefined, undefined]);
  // Home is the sessionless /wda/homescreen, in its place in the order.
  const order = wda.state.requests.filter((r) => /\/(actions|wda\/keys|wda\/homescreen)$/.test(r)).map((r) => r.replace(/\/session\/[^/]+/, ""));
  assert.deepEqual(order, ["POST /actions", "POST /wda/keys", "POST /wda/keys", "POST /wda/homescreen"]);
  assert.deepEqual(wda.state.input[1].body, { value: ["abc"] });
  // A lock check before each of the four commands; no unlock press on an
  // unlocked device.
  assert.equal(wda.state.requests.filter((r) => r.endsWith("/wda/locked")).length, 4);
  await assert.rejects(backend.input({ type: "button", name: "siri" }), /Siri/);
});

test("input: a locked device is woken first; the gesture aimed at the lock screen is spent on it", async (t) => {
  const { wda, make } = await rig(t, { wdaOpts: { locked: true } });
  const backend = await make();
  t.after(() => backend.stop());
  assert.deepEqual(await backend.input({ type: "tap", x: 0.5, y: 0.5 }), { detail: "unlocked" });
  assert.equal(wda.state.locked, false);
  assert.deepEqual(wda.state.input, []);
  await backend.input({ type: "tap", x: 0.5, y: 0.5 });
  assert.equal(wda.state.input.length, 1);

  // Typing is not aimed at a point: wake, then type.
  wda.state.locked = true;
  await backend.input({ type: "type", text: "hi" });
  assert.deepEqual(wda.state.input.at(-1), { path: "/wda/keys", body: { value: ["hi"] } });
});

test("input: a device that stays locked answers an error, and the queue keeps going", async (t) => {
  const { wda, make } = await rig(t, { wdaOpts: { locked: true, stuckLocked: true } });
  const backend = await make();
  t.after(() => backend.stop());
  await assert.rejects(backend.input({ type: "type", text: "x" }), /locked and could not be unlocked/);
  wda.state.locked = false;
  await backend.input({ type: "type", text: "y" });
  assert.deepEqual(wda.state.input.map((i) => i.body.value[0]), ["y"]);
});

test("input: tap by label taps the on-screen match's centre; misses and ambiguity are error acks", async (t) => {
  const elements = {
    'label == "Safari"': [{ x: 0, y: 0, width: 0, height: 0 }, { x: 116, y: 750, width: 68, height: 68 }],
    'name == "row"': [{ x: 0, y: 100, width: 390, height: 44 }, { x: 0, y: 200, width: 390, height: 44 }],
    'label == "Photos"': [{ x: 0, y: 0, width: 0, height: 0 }],
  };
  const { wda, make } = await rig(t, { wdaOpts: { elements } });
  const backend = await make();
  t.after(() => backend.stop());
  assert.deepEqual(await backend.input({ type: "tap-label", text: "  Safari " }), { detail: "Safari" });
  assert.deepEqual(wda.state.input.at(-1).body, tapActions({ x: 150, y: 784 }));
  const taps = wda.state.input.length;
  await assert.rejects(backend.input({ type: "tap-label", text: "#row" }), /Multiple \(2\) on-screen elements matched #'row'/);
  await assert.rejects(backend.input({ type: "tap-label", text: "Photos" }), /No on-screen element matched label 'Photos'/);
  await assert.rejects(backend.input({ type: "tap-label", text: "Nothing" }), /No on-screen element matched label 'Nothing'/);
  await assert.rejects(backend.input({ type: "tap-label", text: "#" }), /nothing after #/);
  assert.equal(wda.state.input.length, taps, "no tap after a refused lookup");
});

// --- H.264 (9.4) -------------------------------------------------------------

test("createDeviceBackend: H.264 is planned from the first JPEG's size, even, at scale 1", async (t) => {
  const { make } = await rig(t, { mjpegOpts: { jpeg: { width: 585, height: 1266 } } });
  const backend = await make({ h264: { encoder: FAKE_ENCODER, fps: 30 } });
  t.after(() => backend.stop());
  const p = backend.h264;
  assert.equal(p.ok, true, p.reason);
  // The APP1 thumbnail's 160×120 SOF comes first in the bytes, and is not it.
  assert.deepEqual(p.source, { width: 585, height: 1266 });
  assert.deepEqual([p.width, p.height, p.fps, p.scale], [584, 1266, 30, 1]);
});

test("createDeviceBackend: H.264 is off, never fatal, without a helper or a measurable stream", async (t) => {
  const { make } = await rig(t);
  const missing = await make({ h264: { encoder: path.join(FIXTURES, "no-such-encoder"), fps: 30 } });
  t.after(() => missing.stop());
  assert.equal(missing.h264.ok, false);
  assert.match(missing.h264.reason, /encoder helper not built \(npm run build:helper\)/);

  // "JPG1"/"JPG2" frames and a held connection: no JPEG header ever arrives.
  const blind = await make({ h264: { encoder: FAKE_ENCODER, fps: 30 }, readyTimeoutMs: 300 });
  t.after(() => blind.stop());
  assert.equal(blind.h264.ok, false);
  assert.match(blind.h264.reason, /could not measure the device's MJPEG picture \(no JPEG header within/);
  assert.throws(() => blind.h264Pipeline(), /H\.264 is off: could not measure/);
});

test("device h264Pipeline: the forwarded MJPEG body goes into the helper's stdin; kill() ends it once", async (t) => {
  const { make } = await rig(t, { mjpegOpts: { jpeg: { width: 585, height: 1266 } } });
  const backend = await make({ h264: { encoder: FAKE_ENCODER, fps: 30 } });
  t.after(() => backend.stop());
  const pipeline = backend.h264Pipeline();
  const chunks = [];
  pipeline.on("data", (c) => chunks.push(c));
  const exits = [];
  pipeline.on("exit", (d) => exits.push(d));
  const jpeg = fakeJpeg(585, 1266);
  assert.ok(await waitFor(() => {
    const all = Buffer.concat(chunks);
    return all.indexOf(jpeg) !== all.lastIndexOf(jpeg); // both frames arrived
  }), Buffer.concat(chunks).toString("latin1").slice(0, 200));
  assert.ok(Buffer.concat(chunks).toString("latin1").startsWith("ARGS --input mjpeg --source 585x1266 --fps 30\n"));
  pipeline.kill();
  pipeline.kill();
  assert.ok(await waitFor(() => exits.length === 1));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exits.length, 1);
  assert.match(exits[0], /encoder killed by SIGTERM/);
});

test("device h264Pipeline: the end of the device's stream ends the helper, and the pipeline", async (t) => {
  const { make } = await rig(t, { mjpegOpts: { jpeg: { width: 390, height: 844 }, end: true } });
  const backend = await make({ h264: { encoder: FAKE_ENCODER, fps: 15 } });
  t.after(() => backend.stop());
  assert.equal(backend.h264.fps, 15);
  const pipeline = backend.h264Pipeline();
  pipeline.on("data", () => {});
  const exits = [];
  pipeline.on("exit", (d) => exits.push(d));
  assert.ok(await waitFor(() => exits.length === 1));
  assert.match(exits[0], /stream ended, encoder exited 0/);
});

test("device h264Pipeline: refuses once the forward is gone", async (t) => {
  const { make } = await rig(t, { mjpegOpts: { jpeg: { width: 390, height: 844 } } });
  const backend = await make({ h264: { encoder: FAKE_ENCODER, fps: 30 } });
  backend.stop();
  assert.ok(await waitFor(() => { try { backend.openMjpeg(); return false; } catch { return true; } }));
  assert.throws(() => backend.h264Pipeline(), /port-forward to the device has exited/);
});
