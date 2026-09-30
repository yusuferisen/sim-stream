// Unit tests for the H.264 video path's logic. Run with `npm test`.
//
// What is covered here is what breaks without throwing: a record cut at the
// wrong byte, a viewer handed a frame it cannot decode, a capture pipeline
// that is spawned twice, torn down by its predecessor, or left running for
// nobody. The pipeline, the viewers, the clock and the timers are fakes, so
// none of it needs a simulator or waits on real time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

import {
  CLOSE_CAPTURE_ENDED,
  CLOSE_TOO_SLOW,
  GopCache,
  H264Hub,
  MAX_PAYLOAD_BYTES,
  RECORD_HEADER_BYTES,
  RecordParser,
  codecFromKeyframe,
  defaultBitrate,
  parseJpegSize,
  parsePngSize,
  planCapture,
} from "../h264.js";

// --- builders ---------------------------------------------------------------

const SPS = [0x67, 0x4d, 0x00, 0x28, 0xaa]; // NAL type 7, Main (0x4d), level 4.0 (0x28)
const PPS = [0x68, 0xee, 0x3c, 0x80];
const START = [0, 0, 0, 1];

// An access unit the way the helper writes it: SPS + PPS + IDR on a keyframe,
// one non-IDR slice otherwise. `tag` makes each payload distinguishable.
function accessUnit(keyframe, tag = 0) {
  return Buffer.from(keyframe
    ? [...START, ...SPS, ...START, ...PPS, ...START, 0x65, 0x88, tag]
    : [...START, 0x41, 0x9a, tag]);
}

function record(keyframe, pts, payload = accessUnit(keyframe, pts & 0xff)) {
  const header = Buffer.alloc(RECORD_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  header[4] = keyframe ? 1 : 0;
  header.writeBigUInt64BE(BigInt(pts), 8);
  return Buffer.concat([header, payload]);
}

const key = (pts) => record(true, pts);
const delta = (pts) => record(false, pts);

// --- planCapture ------------------------------------------------------------

test("planCapture reproduces the measured picture sizes (the helper's FrameLayout)", () => {
  const source = { width: 1206, height: 2622 };
  const size = (scale) => {
    const p = planCapture({ source, scale, fps: 30 });
    return [p.ok, p.width, p.height];
  };
  assert.deepEqual(size(0.5), [true, 602, 1310]);   // 603×1311, odd column/row dropped
  assert.deepEqual(size(1.0), [true, 1206, 2622]);  // no resampling, already even
  assert.deepEqual(size(0.99), [true, 1192, 2594]); // 1193×2595
  assert.deepEqual(size(0.9), [true, 1084, 2358]);  // 1085×2359
  assert.deepEqual(size(0.25), [true, 300, 654]);   // 301×655
});

test("planCapture passes in-range values through untouched, with the helper's default bit rate", () => {
  const p = planCapture({ source: { width: 1206, height: 2622 }, scale: 0.5, fps: 30 });
  assert.deepEqual(p, {
    ok: true, fps: 30, scale: 0.5, source: { width: 1206, height: 2622 },
    width: 602, height: 1310, bitrate: 1_892_688, notes: [],
  });
  assert.equal(defaultBitrate(602, 1310, 30), 1_892_688);
  assert.equal(defaultBitrate(20, 20, 1), 250_000); // the helper's floor
});

test("planCapture clamps into the helper's ranges and says so", () => {
  const source = { width: 1206, height: 2622 };
  const high = planCapture({ source, scale: 2, fps: 60 });
  assert.equal(high.ok, true);
  assert.equal(high.fps, 30);
  assert.equal(high.scale, 1);
  assert.equal(high.notes.length, 2);
  assert.match(high.notes[0], /--fps 60/);
  assert.match(high.notes[1], /--scale 2/);

  const low = planCapture({ source, scale: 0.01, fps: 0 });
  assert.deepEqual([low.ok, low.fps, low.scale], [true, 1, 0.1]);
  assert.equal(low.notes.length, 2);

  // A fractional rate is cut to a whole one without a note, as parseInt would.
  assert.deepEqual(planCapture({ source, scale: 0.5, fps: 24.9 }).fps, 24);
});

test("planCapture refuses what it cannot make sense of", () => {
  const source = { width: 1206, height: 2622 };
  assert.equal(planCapture({ source, scale: NaN, fps: 30 }).ok, false);
  assert.equal(planCapture({ source, scale: 0.5, fps: NaN }).ok, false);
  assert.equal(planCapture({ source: null, scale: 0.5, fps: 30 }).ok, false);
  assert.equal(planCapture({ source: { width: 0, height: 2622 }, scale: 0.5, fps: 30 }).ok, false);
  assert.equal(planCapture({ source: { width: 1206.5, height: 2622 }, scale: 0.5, fps: 30 }).ok, false);
  assert.equal(planCapture({ source: { width: 20000, height: 2622 }, scale: 0.5, fps: 30 }).ok, false);
  // 12 px × 0.1 = 1 px → 0 after the even crop: nothing to encode.
  const tiny = planCapture({ source: { width: 12, height: 2622 }, scale: 0.1, fps: 30 });
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /too small/);
});

// --- parsePngSize -----------------------------------------------------------

test("parsePngSize reads width and height from the IHDR chunk", () => {
  // The first 24 bytes of a real simulator screenshot (1206×2622).
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452000004b600000a3e", "hex");
  assert.deepEqual(parsePngSize(head), { width: 1206, height: 2622 });
});

test("parsePngSize returns null for anything that is not a PNG header", () => {
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452000004b600000a3e", "hex");
  assert.equal(parsePngSize(head.subarray(0, 23)), null);         // truncated
  assert.equal(parsePngSize(Buffer.alloc(24)), null);             // empty file
  assert.equal(parsePngSize("not a buffer"), null);
  const jpeg = Buffer.from(head); jpeg[0] = 0xff;
  assert.equal(parsePngSize(jpeg), null);                         // wrong signature
  const noIhdr = Buffer.from(head); noIhdr.write("IDAT", 12, "latin1");
  assert.equal(parsePngSize(noIhdr), null);                       // first chunk is not IHDR
  const zero = Buffer.from(head); zero.writeUInt32BE(0, 16);
  assert.equal(parsePngSize(zero), null);                         // zero width
});

// --- RecordParser -----------------------------------------------------------

test("RecordParser yields whole records with their flag, timestamp and payload", () => {
  const parser = new RecordParser();
  const k = key(0), d = delta(33_366);
  const out = parser.push(Buffer.concat([k, d]));
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].keyframe, out[0].pts], [true, 0]);
  assert.deepEqual([out[1].keyframe, out[1].pts], [false, 33_366]);
  assert.ok(out[0].bytes.equals(k));
  assert.ok(out[1].bytes.equals(d));
  assert.ok(out[0].payload.equals(accessUnit(true, 0)));
  assert.equal(parser.pending.length, 0);
});

test("RecordParser gives the same records wherever the stream is cut", () => {
  const records = [key(0), delta(33_000), delta(66_000), key(1_000_000), delta(1_033_000)];
  const stream = Buffer.concat(records);
  // Every two-piece cut, then byte-at-a-time.
  for (let cut = 0; cut <= stream.length; cut++) {
    const parser = new RecordParser();
    const out = [...parser.push(stream.subarray(0, cut)), ...parser.push(stream.subarray(cut))];
    assert.equal(out.length, records.length, `cut at ${cut}`);
    out.forEach((r, i) => assert.ok(r.bytes.equals(records[i]), `cut at ${cut}, record ${i}`));
  }
  const parser = new RecordParser();
  const out = [];
  for (const byte of stream) out.push(...parser.push(Buffer.from([byte])));
  assert.equal(out.length, records.length);
  out.forEach((r, i) => assert.ok(r.bytes.equals(records[i])));
});

test("RecordParser holds an incomplete record back until the rest arrives", () => {
  const parser = new RecordParser();
  const k = key(0);
  assert.deepEqual(parser.push(k.subarray(0, RECORD_HEADER_BYTES + 3)), []);
  assert.deepEqual(parser.push(k.subarray(RECORD_HEADER_BYTES + 3, k.length - 1)), []);
  assert.equal(parser.push(k.subarray(k.length - 1)).length, 1);
});

test("RecordParser's records do not alias the chunk they arrived in", () => {
  const parser = new RecordParser();
  const chunk = Buffer.from(key(0));
  const [rec] = parser.push(chunk);
  chunk.fill(0xff); // the caller reuses its buffer
  assert.ok(rec.bytes.equals(key(0)));
});

test("RecordParser reads a timestamp past 32 bits", () => {
  const pts = 5 * 3600 * 1_000_000; // five hours in µs
  const [rec] = new RecordParser().push(record(false, pts));
  assert.equal(rec.pts, pts);
});

test("RecordParser throws on a header that cannot be right", () => {
  const broken = (mutate) => {
    const bytes = Buffer.from(key(0));
    mutate(bytes);
    return () => new RecordParser().push(bytes);
  };
  assert.throws(broken((b) => b.writeUInt32BE(0, 0)), /out of step/);                     // empty payload
  assert.throws(broken((b) => b.writeUInt32BE(MAX_PAYLOAD_BYTES + 1, 0)), /out of step/); // absurd length
  assert.throws(broken((b) => { b[4] = 0x03; }), /out of step/);                          // unknown flag bit
  assert.throws(broken((b) => { b[6] = 0x01; }), /out of step/);                          // reserved byte set
  // The largest plausible length is accepted (and simply waits for its payload).
  assert.deepEqual(broken((b) => b.writeUInt32BE(MAX_PAYLOAD_BYTES, 0))(), []);
});

// --- codecFromKeyframe ------------------------------------------------------

test("codecFromKeyframe builds the codec string from the SPS", () => {
  assert.equal(codecFromKeyframe(accessUnit(true)), "avc1.4d0028");
  // Three-byte start codes, and an access-unit delimiter in front of the SPS.
  const au = Buffer.from([0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 1, 0x65, 0x88]);
  assert.equal(codecFromKeyframe(au), "avc1.64001f");
});

test("codecFromKeyframe returns null when no SPS leads the payload", () => {
  assert.equal(codecFromKeyframe(accessUnit(false)), null);           // a delta frame
  assert.equal(codecFromKeyframe(Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, ...SPS])), null); // SPS after the slice
  assert.equal(codecFromKeyframe(Buffer.from([0, 0, 0, 1, 0x67, 0x4d])), null);                     // SPS cut short
  assert.equal(codecFromKeyframe(Buffer.alloc(0)), null);
  assert.equal(codecFromKeyframe(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), null);                     // no start code
});

// --- GopCache ---------------------------------------------------------------

const parsed = (bytes) => new RecordParser().push(bytes)[0];

test("GopCache holds the latest keyframe and everything after it", () => {
  const cache = new GopCache();
  assert.equal(cache.joinable, false);
  cache.push(parsed(delta(1)));           // nothing to decode it against
  assert.equal(cache.joinable, false);
  cache.push(parsed(key(2)));
  cache.push(parsed(delta(3)));
  cache.push(parsed(delta(4)));
  assert.deepEqual(cache.records.map((r) => r.pts), [2, 3, 4]);
  cache.push(parsed(key(5)));             // a new group replaces the old one
  assert.deepEqual(cache.records.map((r) => r.pts), [5]);
  assert.equal(cache.bytes, key(5).length);
});

test("GopCache empties itself rather than grow when keyframes stop coming", () => {
  const byFrames = new GopCache({ maxFrames: 3 });
  byFrames.push(parsed(key(0)));
  byFrames.push(parsed(delta(1)));
  byFrames.push(parsed(delta(2)));
  assert.equal(byFrames.records.length, 3);
  byFrames.push(parsed(delta(3)));        // the fourth frame breaks the cap
  assert.equal(byFrames.joinable, false);
  byFrames.push(parsed(delta(4)));        // and later deltas do not restart it
  assert.equal(byFrames.joinable, false);
  byFrames.push(parsed(key(5)));
  assert.equal(byFrames.joinable, true);

  const byBytes = new GopCache({ maxBytes: key(0).length + delta(1).length });
  byBytes.push(parsed(key(0)));
  byBytes.push(parsed(delta(1)));
  assert.equal(byBytes.joinable, true);
  byBytes.push(parsed(delta(2)));
  assert.deepEqual([byBytes.joinable, byBytes.bytes], [false, 0]);
});

// --- H264Hub ----------------------------------------------------------------

class FakePipeline extends EventEmitter {
  kills = 0;
  kill() { this.kills++; }
  feed(...buffers) { this.emit("data", Buffer.concat(buffers)); }
  exit(detail = "axe exited 1") { this.emit("exit", detail); }
}

class FakeViewer {
  sent = [];
  closed = null;
  bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = { code, reason }; }
  // What the viewer received, as "config" / "K<pts>" / "D<pts>".
  get log() {
    return this.sent.map((m) => {
      if (typeof m === "string") return JSON.parse(m).type;
      return (m[4] & 1 ? "K" : "D") + Number(m.readBigUInt64BE(8));
    });
  }
  get frames() { return this.log.filter((x) => x !== "config"); }
}

// A hub on a hand-cranked clock and timer.
function setup(options = {}) {
  const pipelines = [];
  const timers = [];
  const clock = { t: 0 };
  const statuses = [];
  const hub = new H264Hub({
    spawnPipeline: () => {
      const p = new FakePipeline();
      pipelines.push(p);
      return p;
    },
    info: { width: 602, height: 1310, fps: 30 },
    graceMs: 5000,
    highWaterBytes: 1000,
    lowWaterBytes: 250,
    stallMs: 10_000,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    ...options,
  });
  hub.on("status", (s) => statuses.push(s));
  // Fire whatever timers are still armed, as if their delay had elapsed.
  const elapse = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
  };
  const armed = () => timers.filter((t) => !t.cleared);
  return { hub, pipelines, timers, armed, elapse, clock, statuses };
}

test("hub: the first viewer spawns the pipeline, later ones share it", () => {
  const { hub, pipelines, statuses } = setup();
  assert.equal(hub.status, "idle");
  hub.addViewer(new FakeViewer());
  hub.addViewer(new FakeViewer());
  hub.addViewer(new FakeViewer());
  assert.equal(pipelines.length, 1);
  assert.deepEqual(statuses, ["live"]);
});

test("hub: every viewer gets a config message, then frames in order", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  pipelines[0].feed(key(0), delta(33), delta(66));
  assert.deepEqual(a.log, ["config", "K0", "D33", "D66"]);
  assert.deepEqual(JSON.parse(a.sent[0]), { type: "config", codec: "avc1.4d0028", width: 602, height: 1310, fps: 30 });
  assert.ok(a.sent[1].equals(key(0)), "the record goes out byte for byte");
});

test("hub: a viewer who joins mid-stream starts on the cached keyframe at once", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  pipelines[0].feed(key(0), delta(33), delta(66), key(1000), delta(1033));
  const b = new FakeViewer();
  hub.addViewer(b);
  assert.deepEqual(b.log, ["config", "K1000", "D1033"], "the current group, not the stale one");
  pipelines[0].feed(delta(1066));
  assert.deepEqual(b.frames, ["K1000", "D1033", "D1066"]);
  assert.deepEqual(a.frames, ["K0", "D33", "D66", "K1000", "D1033", "D1066"]);
});

test("hub: a viewer who joins before any keyframe waits for one", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  assert.deepEqual(a.sent, []);
  pipelines[0].feed(key(0));
  assert.deepEqual(a.log, ["config", "K0"]);
});

test("hub: a record split across chunks is delivered once, whole", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  const stream = Buffer.concat([key(0), delta(33)]);
  pipelines[0].emit("data", stream.subarray(0, 20));
  assert.deepEqual(a.sent, []);
  pipelines[0].emit("data", stream.subarray(20));
  assert.deepEqual(a.frames, ["K0", "D33"]);
});

test("hub: a reload inside the grace window keeps the pipeline", () => {
  const { hub, pipelines, armed, elapse, statuses } = setup();
  const leave = hub.addViewer(new FakeViewer());
  leave();
  assert.equal(armed().length, 1);
  assert.equal(armed()[0].ms, 5000);
  assert.equal(pipelines[0].kills, 0, "not stopped yet");
  hub.addViewer(new FakeViewer());       // the reload
  assert.equal(armed().length, 0, "the pending stop is cancelled");
  elapse();
  assert.equal(pipelines.length, 1);
  assert.equal(pipelines[0].kills, 0);
  assert.deepEqual(statuses, ["live"]);
});

test("hub: the pipeline stops once the grace window passes with nobody watching", () => {
  const { hub, pipelines, elapse, statuses } = setup();
  const leaveA = hub.addViewer(new FakeViewer());
  const leaveB = hub.addViewer(new FakeViewer());
  leaveA();
  elapse();                               // one viewer left: nothing armed, nothing stops
  assert.equal(pipelines[0].kills, 0);
  leaveB();
  leaveB();                               // leaving twice is harmless
  elapse();
  assert.equal(pipelines[0].kills, 1);
  assert.deepEqual(statuses, ["live", "idle"]);
  // The next viewer gets a fresh pipeline.
  hub.addViewer(new FakeViewer());
  assert.equal(pipelines.length, 2);
  assert.deepEqual(statuses, ["live", "idle", "live"]);
});

test("hub: the exit of a pipeline we stopped is not a death", () => {
  const { hub, pipelines, elapse, statuses } = setup();
  hub.addViewer(new FakeViewer())();
  elapse();                               // grace over: stopped
  pipelines[0].exit("axe killed by SIGTERM, encoder exited 0");
  assert.equal(hub.status, "idle");
  assert.deepEqual(statuses, ["live", "idle"]);
});

test("hub: a dying old pipeline cannot tear down or feed its replacement", () => {
  const { hub, pipelines, elapse } = setup();
  hub.addViewer(new FakeViewer())();
  elapse();                               // pipeline 0 stopped, still dying
  const b = new FakeViewer();
  hub.addViewer(b);                       // pipeline 1
  assert.equal(pipelines.length, 2);

  pipelines[0].feed(key(999));            // trailing output of the old one
  assert.deepEqual(b.sent, [], "stale frames never reach the new stream");
  pipelines[0].exit();
  assert.equal(hub.status, "live");
  assert.equal(b.closed, null);
  assert.equal(pipelines[1].kills, 0);

  pipelines[1].feed(key(0));
  assert.deepEqual(b.frames, ["K0"]);
});

test("hub: an unexpected exit closes every viewer and reports dead; a reconnect respawns", () => {
  const { hub, pipelines, armed, statuses } = setup();
  const a = new FakeViewer(), b = new FakeViewer();
  const leaveA = hub.addViewer(a);
  hub.addViewer(b);
  pipelines[0].feed(key(0));
  pipelines[0].exit("encoder exited 1");
  assert.deepEqual(a.closed, { code: CLOSE_CAPTURE_ENDED, reason: "capture ended" });
  assert.deepEqual(b.closed, { code: CLOSE_CAPTURE_ENDED, reason: "capture ended" });
  assert.deepEqual(statuses, ["live", "dead"]);
  leaveA();                               // the socket's own close, arriving afterwards
  assert.equal(armed().length, 0, "nothing left to stop");

  // Trailing output from the dead pipeline is ignored, not parsed.
  pipelines[0].feed(delta(33));
  const c = new FakeViewer();
  hub.addViewer(c);
  assert.equal(pipelines.length, 2);
  assert.deepEqual(c.sent, [], "the dead pipeline's group of pictures is gone");
  assert.deepEqual(statuses, ["live", "dead", "live"]);
  pipelines[1].feed(key(0));
  assert.deepEqual(c.frames, ["K0"]);
});

test("hub: a pipeline that cannot start closes the viewer and reports dead", () => {
  const logged = [];
  const { hub, statuses } = setup({
    spawnPipeline: () => { throw new Error("spawn EMFILE"); },
    log: (line) => logged.push(line),
  });
  const a = new FakeViewer();
  const leave = hub.addViewer(a);
  assert.deepEqual(a.closed, { code: CLOSE_CAPTURE_ENDED, reason: "capture ended" });
  assert.deepEqual(statuses, ["dead"]);
  assert.match(logged[0], /EMFILE/);
  leave();
});

test("hub: a stream that goes out of step kills the pipeline instead of guessing", () => {
  const { hub, pipelines, statuses } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  const bad = Buffer.from(delta(33));
  bad[5] = 0x7f;                          // reserved byte set: not a record header
  pipelines[0].feed(key(0));
  pipelines[0].feed(bad, delta(66));
  assert.deepEqual(a.frames, ["K0"], "nothing from the broken chunk is delivered");
  assert.equal(pipelines[0].kills, 1);
  assert.equal(a.closed.code, CLOSE_CAPTURE_ENDED);
  assert.deepEqual(statuses, ["live", "dead"]);
  pipelines[0].exit();                    // its real exit, later: already accounted for
  assert.deepEqual(statuses, ["live", "dead"]);
});

test("hub: a keyframe without an SPS is treated as a broken stream", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  pipelines[0].feed(record(true, 0, accessUnit(false)));
  assert.deepEqual(a.sent, []);
  assert.equal(hub.status, "dead");
});

test("hub: a viewer that falls behind is skipped forward to a keyframe", () => {
  const { hub, pipelines } = setup();
  const slow = new FakeViewer(), fast = new FakeViewer();
  hub.addViewer(slow);
  hub.addViewer(fast);
  pipelines[0].feed(key(0), delta(33));
  slow.bufferedAmount = 1001;             // over the high-water mark
  pipelines[0].feed(delta(66), delta(100));
  assert.deepEqual(slow.frames, ["K0", "D33"], "nothing more is queued for it");

  slow.bufferedAmount = 0;                // drained — but mid-group
  pipelines[0].feed(delta(133));
  assert.deepEqual(slow.frames, ["K0", "D33"], "a delta after a gap would not decode");

  pipelines[0].feed(key(1000), delta(1033));
  assert.deepEqual(slow.frames, ["K0", "D33", "K1000", "D1033"]);
  assert.deepEqual(fast.frames, ["K0", "D33", "D66", "D100", "D133", "K1000", "D1033"]);
  assert.equal(slow.log.filter((x) => x === "config").length, 1, "config is sent once");
});

test("hub: a keyframe does not resume a viewer whose backlog is still high", () => {
  const { hub, pipelines } = setup();
  const slow = new FakeViewer();
  hub.addViewer(slow);
  pipelines[0].feed(key(0));
  slow.bufferedAmount = 1001;
  pipelines[0].feed(delta(33));           // marked behind
  slow.bufferedAmount = 251;              // under high water, over low water
  pipelines[0].feed(key(1000), delta(1033));
  assert.deepEqual(slow.frames, ["K0"]);
  slow.bufferedAmount = 250;              // at the low-water mark: resume
  pipelines[0].feed(key(2000));
  assert.deepEqual(slow.frames, ["K0", "K2000"]);
});

test("hub: exactly at the high-water mark is still keeping up", () => {
  const { hub, pipelines } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);
  pipelines[0].feed(key(0));
  a.bufferedAmount = 1000;
  pipelines[0].feed(delta(33));
  assert.deepEqual(a.frames, ["K0", "D33"]);
});

test("hub: a viewer that stays behind is closed, and stops holding the capture", () => {
  const { hub, pipelines, clock, armed, elapse } = setup();
  const gone = new FakeViewer();
  hub.addViewer(gone);
  pipelines[0].feed(key(0));
  gone.bufferedAmount = 5000;             // the peer vanished; nothing drains
  clock.t = 1000;
  pipelines[0].feed(delta(33));           // falls behind at t=1000
  clock.t = 10_999;
  pipelines[0].feed(key(1000));
  assert.equal(gone.closed, null, "just under the limit");
  clock.t = 11_000;
  pipelines[0].feed(delta(1033));
  assert.deepEqual(gone.closed, { code: CLOSE_TOO_SLOW, reason: "viewer too slow" });
  assert.equal(armed().length, 1, "last viewer gone: the grace window starts");
  elapse();
  assert.equal(pipelines[0].kills, 1);
  assert.equal(hub.status, "idle");
});

test("hub: waiting for a first keyframe is not the same as being too slow", () => {
  const { hub, pipelines, clock } = setup();
  const a = new FakeViewer();
  hub.addViewer(a);                       // t=0, nothing cached
  clock.t = 60_000;                       // the pipeline took a minute to produce a frame
  pipelines[0].feed(key(0));
  assert.equal(a.closed, null);
  assert.deepEqual(a.frames, ["K0"]);
});

test("hub: a removed viewer receives nothing more", () => {
  const { hub, pipelines } = setup();
  const expired = new FakeViewer(), other = new FakeViewer();
  const leave = hub.addViewer(expired);
  hub.addViewer(other);
  pipelines[0].feed(key(0));
  leave();                                // what share expiry does before closing the socket
  pipelines[0].feed(delta(33), key(1000));
  assert.deepEqual(expired.frames, ["K0"]);
  assert.deepEqual(other.frames, ["K0", "D33", "K1000"]);
});

test("hub: a viewer whose send throws is dropped without disturbing the others", () => {
  const { hub, pipelines } = setup();
  const broken = new FakeViewer(), fine = new FakeViewer();
  broken.send = () => { throw new Error("socket gone"); };
  hub.addViewer(broken);
  hub.addViewer(fine);
  pipelines[0].feed(key(0), delta(33));
  assert.equal(broken.closed.code, CLOSE_CAPTURE_ENDED);
  assert.deepEqual(fine.frames, ["K0", "D33"]);
  assert.equal(hub.viewers.size, 1);
});

test("hub: stop() ends the pipeline and cancels a pending grace stop", () => {
  const { hub, pipelines, armed, statuses } = setup();
  hub.addViewer(new FakeViewer())();
  assert.equal(armed().length, 1);
  hub.stop();                             // shutdown during the grace window
  assert.equal(armed().length, 0);
  assert.equal(pipelines[0].kills, 1);
  assert.deepEqual(statuses, ["live", "idle"]);
  hub.stop();                             // and again: nothing left to do
  assert.equal(pipelines[0].kills, 1);
});

test("hub: refuses to be built without a way to spawn", () => {
  assert.throws(() => new H264Hub({}), /spawnPipeline/);
});

// --- parseJpegSize ----------------------------------------------------------

// SOI, an APP1 whose EXIF thumbnail has its own SOI and SOF, then the real SOF0.
function jpegHead(width, height) {
  const sof = (w, h) => [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const thumb = [0xff, 0xd8, ...sof(160, 120), 0xff, 0xd9];
  const app1 = [0xff, 0xe1, 0x00, 2 + 6 + thumb.length, ...Buffer.from("Exif\0\0", "latin1"), ...thumb];
  return Buffer.from([0xff, 0xd8, ...app1, ...sof(width, height), 0xff, 0xda, 0x00, 0x02]);
}

test("parseJpegSize reads the image's SOF past multipart headers and an EXIF thumbnail", () => {
  const body = Buffer.concat([Buffer.from("--BoundaryString\r\nContent-type: image/jpeg\r\n\r\n"), jpegHead(585, 1266)]);
  assert.deepEqual(parseJpegSize(body), { width: 585, height: 1266 });
  assert.deepEqual(parseJpegSize(jpegHead(1170, 2532)), { width: 1170, height: 2532 });
});

test("parseJpegSize returns null until the SOF has arrived, and for non-JPEGs", () => {
  const head = jpegHead(585, 1266);
  const sofEnd = head.length - 4; // the SOS marker and its length follow the SOF
  for (let n = 0; n < sofEnd - 10; n++) assert.equal(parseJpegSize(head.subarray(0, n)), null, `cut at ${n}`);
  assert.deepEqual(parseJpegSize(head.subarray(0, sofEnd)), { width: 585, height: 1266 });
  assert.equal(parseJpegSize(Buffer.from("JPG1JPG2")), null);
  assert.equal(parseJpegSize("not a buffer"), null);
  assert.equal(parseJpegSize(jpegHead(0, 10)), null);
  const noSof = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11]);
  assert.equal(parseJpegSize(noSof), null);
});
