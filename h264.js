// The H.264 video path's logic: everything between the encoder helper's
// stdout and a viewer's socket that can be decided without a process, a socket
// or a clock of its own.
//
//   planCapture()      what to ask AXe and the helper for, and the picture size
//   parsePngSize()     the simulator's pixel size, from a screenshot's header
//   RecordParser       the helper's byte stream -> whole records
//   GopCache           the current group of pictures, so a joiner starts at once
//   codecFromKeyframe  the WebCodecs codec string, from the SPS
//   H264Hub            refcount + grace window + generation guard + delivery
//
// The helper's side of the contract (arguments, record layout, exit codes) is
// docs/architecture.md § H.264 encoder helper; the wire format this module
// produces for `/video` is § H.264 video path.
//
// No I/O and no side effects at import: the capture pipeline, the viewer
// sockets, the clock and the timers are all handed in, so `node --test` covers
// the concurrency rules without a simulator (test/h264.test.js).

import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

// --- Capture plan ------------------------------------------------------------

export const FPS_RANGE = Object.freeze({ min: 1, max: 30 });
export const SCALE_RANGE = Object.freeze({ min: 0.1, max: 1.0 });
// The helper refuses a --source outside this range (exit 2).
const SOURCE_RANGE = Object.freeze({ min: 2, max: 16384 });

// Mirrors the helper's default: ~0.08 bit per pixel per frame.
export function defaultBitrate(width, height, fps) {
  return Math.max(250_000, Math.floor(width * height * fps * 0.08));
}

// Decides what `axe stream-video` and the helper are both told, and what
// picture comes out. `source` is the simulator screen in PIXELS.
//
// Returns { ok: true, fps, scale, source, width, height, bitrate, notes } or
// { ok: false, reason }. Out-of-range values are clamped into the helper's
// ranges (it exits 2 on anything else) with a note per clamp; a value that is
// not a number at all is refused rather than guessed at.
//
// width × height is the ENCODED picture: AXe scales with floor(pixels × scale)
// per axis (no resampling at scale 1.0), and H.264 4:2:0 drops an odd last
// column/row — 1206×2622 at 0.5 → 603×1311 → 602×1310. Same arithmetic as the
// helper's FrameLayout.axe; the tests pin both to the measured sizes.
export function planCapture({ source, scale, fps }) {
  const sw = source?.width, sh = source?.height;
  for (const v of [sw, sh]) {
    if (!Number.isInteger(v) || v < SOURCE_RANGE.min || v > SOURCE_RANGE.max) {
      return { ok: false, reason: `unusable simulator pixel size ${sw}x${sh}` };
    }
  }
  if (!Number.isFinite(fps)) return { ok: false, reason: `--fps is not a number` };
  if (!Number.isFinite(scale)) return { ok: false, reason: `--scale is not a number` };

  const notes = [];
  const clamp = (name, value, { min, max }) => {
    const c = Math.min(max, Math.max(min, value));
    if (c !== value) notes.push(`--${name} ${value} is outside ${min}–${max}; H.264 uses ${c}`);
    return c;
  };
  const f = clamp("fps", Math.trunc(fps), FPS_RANGE);
  const s = clamp("scale", scale, SCALE_RANGE);

  const unscaled = s >= 1.0;
  const width = (unscaled ? sw : Math.floor(sw * s)) & ~1;
  const height = (unscaled ? sh : Math.floor(sh * s)) & ~1;
  if (width < 2 || height < 2) return { ok: false, reason: `picture too small at scale ${s} (${width}x${height})` };

  return {
    ok: true,
    fps: f,
    scale: s,
    source: { width: sw, height: sh },
    width,
    height,
    bitrate: defaultBitrate(width, height, f),
    notes,
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { width, height } from the first 24 bytes of a PNG, or null if `buf` is not
// one. The IHDR chunk is required to come first, so no chunk walking.
export function parsePngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// --- Helper records ----------------------------------------------------------

export const RECORD_HEADER_BYTES = 16;
export const FLAG_KEYFRAME = 0x01;
// No real access unit comes near this (a full-scale keyframe is well under
// 1 MB). A larger length field means the byte stream is out of step.
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

// Reassembles the helper's `--output framed` stream into records:
//
//   0  u32 BE  payload length N      5  3 bytes reserved, zero
//   4  u8      flags (bit 0: key)    8  u64 BE  pts, µs      16  N bytes, Annex B
//
// push(chunk) returns the records completed by that chunk, each
// { keyframe, pts, bytes, payload } — `bytes` is the whole record (header
// included), which is exactly what goes on the wire; `payload` is a view of
// its access unit. Chunk boundaries are arbitrary.
//
// A header that cannot be right (zero or absurd length, non-zero reserved
// bytes or unknown flags) throws: there is no way to resynchronise a stream
// with no markers, so the caller must restart the pipeline.
export class RecordParser {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    // Always a fresh buffer: records handed out below are views into it, and
    // they are kept (the GOP cache, socket queues) long after this call.
    const buf = Buffer.concat([this.pending, chunk]);
    const out = [];
    let off = 0;
    while (buf.length - off >= RECORD_HEADER_BYTES) {
      const length = buf.readUInt32BE(off);
      const flags = buf[off + 4];
      if (length === 0 || length > MAX_PAYLOAD_BYTES) {
        throw new Error(`encoder stream out of step: record length ${length}`);
      }
      if ((flags & ~FLAG_KEYFRAME) !== 0 || buf[off + 5] !== 0 || buf[off + 6] !== 0 || buf[off + 7] !== 0) {
        throw new Error("encoder stream out of step: unexpected header bytes");
      }
      const end = off + RECORD_HEADER_BYTES + length;
      if (end > buf.length) break;
      out.push({
        keyframe: (flags & FLAG_KEYFRAME) !== 0,
        pts: Number(buf.readBigUInt64BE(off + 8)),
        bytes: buf.subarray(off, end),
        payload: buf.subarray(off + RECORD_HEADER_BYTES, end),
      });
      off = end;
    }
    this.pending = buf.subarray(off);
    return out;
  }
}

// "avc1.PPCCLL" from the SPS in a keyframe's Annex B payload, or null when
// there is none. The three bytes after the SPS NAL header are profile_idc, the
// constraint flags and level_idc — by definition the codec string's hex digits.
// Only the leading NAL units are looked at: the helper puts SPS first.
export function codecFromKeyframe(payload) {
  const limit = Math.min(payload.length, 256);
  for (let i = 0; i + 3 < limit; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0) continue;
    let nal;
    if (payload[i + 2] === 1) nal = i + 3;
    else if (payload[i + 2] === 0 && payload[i + 3] === 1) nal = i + 4;
    else continue;
    if (nal + 3 >= payload.length) return null;
    const type = payload[nal] & 0x1f;
    if (type === 7) {
      return "avc1." + payload.subarray(nal + 1, nal + 4).toString("hex");
    }
    if (type === 1 || type === 5) return null; // reached picture data: no SPS in front
    i = nal - 1;
  }
  return null;
}

// The current group of pictures: the latest keyframe and every frame after
// it. Replaying it lets a joining viewer decode from a keyframe immediately
// and arrive at the live frame, instead of waiting for the next keyframe.
//
// Bounded: the helper emits a keyframe at least once a second, so a group
// that outgrows the caps means that promise broke. The cache then empties and
// joiners wait for the next keyframe — it never grows without limit.
export class GopCache {
  constructor({ maxFrames = 150, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.clear();
  }

  clear() {
    this.records = [];
    this.bytes = 0;
  }

  get joinable() {
    return this.records.length > 0;
  }

  push(record) {
    if (record.keyframe) this.clear();
    else if (!this.joinable) return; // a delta with no keyframe behind it decodes to nothing
    this.records.push(record);
    this.bytes += record.bytes.length;
    if (this.records.length > this.maxFrames || this.bytes > this.maxBytes) this.clear();
  }
}

// --- The hub -----------------------------------------------------------------

// WebSocket close codes the hub uses. Neither is 1006/1008, which the client
// reads as "your credential is bad".
export const CLOSE_CAPTURE_ENDED = 1011; // the pipeline died; reconnecting respawns it
export const CLOSE_TOO_SLOW = 1013;      // the viewer stopped draining

// One capture pipeline (AXe -> encoder helper) shared by every `/video`
// viewer. The same rules as MjpegHub, plus delivery:
//
// - Refcounted with a grace window: spawn on the first viewer, stop `graceMs`
//   after the last one leaves; a reload inside the window keeps the pipeline.
// - Only the current generation may act: every spawn AND every deliberate stop
//   bumps `generation`, and the data and exit handlers compare before touching
//   anything — a dying pipeline can neither tear down its replacement nor feed
//   it stale frames, and the exit of a pipeline we stopped is not a death.
// - Status (`idle | live | dead`) is emitted on every transition.
// - A viewer's first frame is always a keyframe, preceded by one JSON `config`
//   message: on join it gets the cached group of pictures at once.
// - A viewer that falls behind (its socket holds more than `highWaterBytes`
//   unsent) gets nothing more until a keyframe arrives with its backlog back
//   under `lowWaterBytes` — skipped forward, never buffered without bound. One
//   that stays behind for `stallMs` is closed, so a vanished peer cannot hold
//   the capture running.
//
// Injected:
//   spawnPipeline()  -> an emitter with "data" (Buffer chunks of helper
//                       records), "exit" (detail string, once, when the
//                       pipeline is gone for any reason) and kill(), which
//                       must be safe to call at any time, any number of times.
//   viewers          -> anything with send(data), bufferedAmount and
//                       close(code, reason) — a `ws` WebSocket as-is.
export class H264Hub extends EventEmitter {
  constructor({
    spawnPipeline,
    info = {},               // merged into each viewer's `config` message (width, height, fps)
    graceMs = 5000,
    highWaterBytes = 1024 * 1024,
    lowWaterBytes = highWaterBytes / 4,
    stallMs = 10_000,
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  } = {}) {
    super();
    if (typeof spawnPipeline !== "function") throw new Error("H264Hub needs spawnPipeline");
    this.spawnPipeline = spawnPipeline;
    this.info = info;
    this.graceMs = graceMs;
    this.highWaterBytes = highWaterBytes;
    this.lowWaterBytes = lowWaterBytes;
    this.stallMs = stallMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;

    this.viewers = new Set();
    this.pipeline = null;
    this.generation = 0;
    this.parser = null;
    this.cache = new GopCache();
    this.codec = null;
    this.stopTimer = null;
    this.status = "idle"; // idle | live | dead
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  // Registers a viewer and returns the function that removes it (idempotent —
  // wire it to the socket's close AND call it before closing a socket for any
  // other reason, so nothing more is sent to it).
  addViewer(sink) {
    if (this.stopTimer) {
      this.clearTimer(this.stopTimer);
      this.stopTimer = null;
    }
    // `behind` from the start: a viewer may only ever begin on a keyframe.
    const viewer = { sink, behind: true, behindSince: this.now(), configured: false };
    this.viewers.add(viewer);
    const leave = () => this.#remove(viewer);
    this.start();
    // start() may have failed and already closed this viewer.
    if (this.viewers.has(viewer) && this.cache.joinable) {
      for (const record of this.cache.records) {
        if (!this.#send(viewer, record)) break;
      }
    }
    return leave;
  }

  #remove(viewer) {
    if (!this.viewers.delete(viewer)) return;
    if (this.viewers.size === 0) this.scheduleStop();
  }

  scheduleStop() {
    if (this.stopTimer || !this.pipeline) return;
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = null;
      if (this.viewers.size === 0) this.stop();
    }, this.graceMs);
  }

  start() {
    if (this.pipeline) return;
    const gen = ++this.generation;
    this.#resetStream();
    let pipeline;
    try {
      pipeline = this.spawnPipeline();
    } catch (e) {
      this.#died(`could not start: ${e.message}`);
      return;
    }
    this.pipeline = pipeline;
    this.setStatus("live");
    pipeline.on("data", (chunk) => {
      if (this.generation === gen) this.#onData(chunk);
    });
    pipeline.on("exit", (detail) => {
      // A newer spawn, or our own stop(), has moved the generation on: this
      // pipeline is no longer ours to account for.
      if (this.generation !== gen) return;
      // Bumps the generation too, so nothing it still has in flight is parsed.
      this.#discardPipeline();
      this.#died(detail);
    });
  }

  // Deliberate stop (grace window elapsed, shutdown). Viewers, if any, are
  // left alone: the caller owns their sockets.
  stop() {
    if (this.stopTimer) {
      this.clearTimer(this.stopTimer);
      this.stopTimer = null;
    }
    this.#discardPipeline();
    this.setStatus("idle");
  }

  #discardPipeline() {
    const pipeline = this.pipeline;
    this.pipeline = null;
    this.generation++; // its trailing data and its exit are now nobody's business
    this.#resetStream();
    if (pipeline) {
      try { pipeline.kill(); } catch {}
    }
  }

  #resetStream() {
    this.parser = new RecordParser();
    this.cache.clear();
    this.codec = null;
  }

  // The pipeline is gone without us asking (or never started). Every viewer is
  // closed — a reconnect is what respawns it — and nobody is left to wait for.
  #died(detail) {
    this.log(`capture ended: ${detail}`);
    this.#resetStream();
    const gone = [...this.viewers];
    this.viewers.clear();
    if (this.stopTimer) {
      this.clearTimer(this.stopTimer);
      this.stopTimer = null;
    }
    for (const viewer of gone) {
      try { viewer.sink.close(CLOSE_CAPTURE_ENDED, "capture ended"); } catch {}
    }
    this.setStatus("dead");
  }

  #onData(chunk) {
    let records;
    try {
      records = this.parser.push(chunk);
      for (const record of records) {
        if (record.keyframe) {
          this.codec = codecFromKeyframe(record.payload);
          if (!this.codec) throw new Error("keyframe without an SPS in front");
        }
        this.cache.push(record);
        if (!this.cache.joinable) continue; // deltas before the first keyframe
        for (const viewer of [...this.viewers]) this.#offer(viewer, record);
      }
    } catch (e) {
      // Out of step with the helper, and nothing to resynchronise on.
      this.#discardPipeline();
      this.#died(e.message);
    }
  }

  // Decide whether `record` goes to `viewer` now.
  #offer(viewer, record) {
    let backlog;
    try { backlog = viewer.sink.bufferedAmount; } catch { backlog = Infinity; }
    if (!viewer.behind) {
      if (backlog <= this.highWaterBytes) {
        this.#send(viewer, record);
        return;
      }
      viewer.behind = true;
      viewer.behindSince = this.now();
    }
    if (record.keyframe && backlog <= this.lowWaterBytes) {
      viewer.behind = false;
      this.#send(viewer, record);
      return;
    }
    if (this.now() - viewer.behindSince >= this.stallMs) {
      this.#remove(viewer);
      try { viewer.sink.close(CLOSE_TOO_SLOW, "viewer too slow"); } catch {}
    }
  }

  // Returns false when the viewer had to be dropped.
  #send(viewer, record) {
    try {
      if (!viewer.configured) {
        viewer.sink.send(JSON.stringify({ type: "config", codec: this.codec, ...this.info }));
        viewer.configured = true;
      }
      viewer.behind = false;
      viewer.sink.send(record.bytes);
      return true;
    } catch {
      this.#remove(viewer);
      try { viewer.sink.close(CLOSE_CAPTURE_ENDED, "send failed"); } catch {}
      return false;
    }
  }
}
