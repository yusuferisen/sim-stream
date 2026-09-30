// Unit tests for the simulator backend's pure pieces. Run with `npm test`.
//
// The selection ladder, the bounds table, the input → `axe` translation and
// the MJPEG preamble stripper all fail silently (a tap lands elsewhere, a
// stream starts with HTTP headers in it), so they are pinned here. The
// process plumbing needs a booted simulator and is on the manual checklist.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUTTONS,
  KEYCODES,
  MJPEG_BOUNDARY,
  axeInputArgs,
  axeTimeoutMs,
  boundsForDeviceType,
  pickSimulator,
  stripHttpPreamble,
} from "../backends/simulator.js";

// --- pickSimulator ----------------------------------------------------------

const sim = (udid, deviceType, state = "Shutdown") => ({ udid, name: udid, state, runtime: "iOS-27-0", deviceType });

test("pickSimulator: an explicit udid wins, and a missing one throws", () => {
  const list = [sim("A", "iPhone-17-Pro", "Booted"), sim("B", "iPhone-SE-3rd-generation")];
  assert.equal(pickSimulator(list, "B").udid, "B");
  assert.throws(() => pickSimulator(list, "Z"), /Simulator Z not found/);
});

test("pickSimulator: a booted device beats the preference ladder", () => {
  const list = [sim("A", "iPhone-17-Pro"), sim("B", "iPad-Pro-11", "Booted")];
  assert.equal(pickSimulator(list).udid, "B");
});

test("pickSimulator: the ladder is 17 Pro (not Max) → any 17 → any iPhone", () => {
  assert.equal(pickSimulator([sim("m", "iPhone-17-Pro-Max"), sim("p", "iPhone-17-Pro")]).udid, "p");
  assert.equal(pickSimulator([sim("m", "iPhone-17-Pro-Max"), sim("s", "iPhone-16")]).udid, "m");
  assert.equal(pickSimulator([sim("i", "iPad-Air-11"), sim("s", "iPhone-SE-3rd-generation")]).udid, "s");
  assert.throws(() => pickSimulator([sim("i", "iPad-Air-11")]), /No iPhone simulator available/);
});

// --- boundsForDeviceType ----------------------------------------------------

test("boundsForDeviceType: the table, including the Pro-before-base ordering", () => {
  assert.deepEqual(boundsForDeviceType("iPhone-17-Pro-Max"), { w: 440, h: 956 });
  assert.deepEqual(boundsForDeviceType("iPhone-17-Pro"), { w: 402, h: 874 });
  assert.deepEqual(boundsForDeviceType("iPhone-17"), { w: 393, h: 852 });
  assert.deepEqual(boundsForDeviceType("iPhone-SE-3rd-generation"), { w: 375, h: 667 });
  assert.deepEqual(boundsForDeviceType("iPad-Pro-13-inch-M4"), { w: 1032, h: 1376 });
  assert.deepEqual(boundsForDeviceType("iPad-mini-A17-Pro"), { w: 744, h: 1133 });
  assert.deepEqual(boundsForDeviceType("Apple-Watch"), { w: 393, h: 852 }, "unknown → the fallback");
  assert.deepEqual(boundsForDeviceType(), { w: 393, h: 852 });
});

// --- axeInputArgs -----------------------------------------------------------

const B = { w: 400, h: 800 };

test("tap: normalized coordinates become points, clamped, with a physical tap", () => {
  assert.deepEqual(axeInputArgs({ type: "tap", x: 0.5, y: 0.25 }, B), ["tap", "-x", "200", "-y", "200", "--tap-style", "physical"]);
  assert.deepEqual(axeInputArgs({ type: "tap", x: 7, y: -3 }, B).slice(1, 5), ["-x", "400", "-y", "0"], "out of range is clamped");
  assert.deepEqual(axeInputArgs({ type: "tap" }, B).slice(1, 5), ["-x", "0", "-y", "0"], "missing is the origin");
});

test("long-press and swipe: durations default in ms and go out in seconds", () => {
  assert.deepEqual(
    axeInputArgs({ type: "long-press", x: 0.5, y: 0.5 }, B),
    ["touch", "-x", "200", "-y", "400", "--down", "--up", "--delay", "0.8"],
  );
  assert.deepEqual(
    axeInputArgs({ type: "swipe", fromX: 0.5, fromY: 0.9, toX: 0.5, toY: 0.1, duration: 500 }, B),
    ["swipe", "--start-x", "200", "--start-y", "720", "--end-x", "200", "--end-y", "80", "--duration", "0.5"],
  );
  assert.equal(axeInputArgs({ type: "swipe" }, B).at(-1), "0.3");
});

test("type: the text as one argument; nothing to type means no command", () => {
  assert.deepEqual(axeInputArgs({ type: "type", text: "hello world" }, B), ["type", "hello world"]);
  assert.equal(axeInputArgs({ type: "type", text: "" }, B), null);
  assert.equal(axeInputArgs({ type: "type" }, B), null);
});

test("key: names map to HID codes, numbers pass through, unknown names throw", () => {
  assert.deepEqual(axeInputArgs({ type: "key", key: "Enter" }, B), ["key", "40"]);
  assert.deepEqual(axeInputArgs({ type: "key", key: "backspace" }, B), ["key", "42"]);
  assert.deepEqual(axeInputArgs({ type: "key", key: 79 }, B), ["key", "79"]);
  assert.equal(KEYCODES.escape, 41);
  assert.throws(() => axeInputArgs({ type: "key", key: "f13" }, B), /unknown key: f13/);
});

test("button: only the allowed names; screenshot is not an input", () => {
  for (const name of BUTTONS) assert.deepEqual(axeInputArgs({ type: "button", name }, B), ["button", name]);
  assert.throws(() => axeInputArgs({ type: "button", name: "screenshot" }, B), /unknown button: screenshot/);
  assert.throws(() => axeInputArgs({ type: "button", name: "volume-up" }, B), /unknown button: volume-up/);
});

test("tap-label goes through tapLabelArgs; unknown types throw", () => {
  assert.deepEqual(axeInputArgs({ type: "tap-label", text: "#ok" }, B), ["tap", "--id=ok", "--tap-style", "physical"]);
  assert.throws(() => axeInputArgs({ type: "tap-label", text: "" }, B), /no label given/);
  assert.throws(() => axeInputArgs({ type: "pinch" }, B), /unknown event type: pinch/);
  assert.throws(() => axeInputArgs(null, B), /unknown event type/);
});

test("axeTimeoutMs: type scales with length, label taps get 15 s, the rest 5 s", () => {
  assert.equal(axeTimeoutMs(["type", "hi"]), 10_000);
  assert.equal(axeTimeoutMs(["type", "x".repeat(200)]), 16_000);
  assert.equal(axeTimeoutMs(["tap", "--label=Sign In", "--tap-style", "physical"]), 15_000);
  assert.equal(axeTimeoutMs(["tap", "--id=x", "--tap-style", "physical"]), 15_000);
  assert.equal(axeTimeoutMs(["tap", "-x", "1", "-y", "2", "--tap-style", "physical"]), 5000);
  assert.equal(axeTimeoutMs(["button", "home"]), 5000);
});

// --- stripHttpPreamble ------------------------------------------------------

test("stripHttpPreamble: the body starts after the blank line, whatever the chunking", () => {
  const response = `HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}\r\n\r\n----mjpegstream\r\nContent-Type: image/jpeg\r\n\r\nJPEG`;
  const buf = Buffer.from(response);
  const bodyStart = response.indexOf("\r\n\r\n") + 4;
  for (const size of [1, 7, 64, buf.length]) {
    const strip = stripHttpPreamble();
    const out = [];
    for (let i = 0; i < buf.length; i += size) out.push(strip(buf.subarray(i, i + size)));
    assert.equal(Buffer.concat(out).toString(), response.slice(bodyStart), `chunks of ${size}`);
  }
});

test("stripHttpPreamble: nothing comes out until the preamble has ended", () => {
  const strip = stripHttpPreamble();
  assert.equal(strip(Buffer.from("HTTP/1.1 200 OK\r\nX: y\r\n")).length, 0);
  assert.equal(strip(Buffer.from("\r")).length, 0);
  assert.equal(strip(Buffer.from("\nbody")).toString(), "body");
  assert.equal(strip(Buffer.from("more\r\n\r\nstill body")).toString(), "more\r\n\r\nstill body");
});
