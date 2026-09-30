#!/usr/bin/env node
// video-probe: connect to a running sim-stream's `/video` WebSocket the way a
// script would (x-token header), record for a few seconds, and report what
// arrived. The verification tool for the H.264 path — no browser needed.
//
//   node scripts/video-probe.js --token <TOKEN> [--port 8080] [--host 127.0.0.1]
//                               [--seconds 5] [--out capture.h264]
//
//   --seconds 0   stay connected until the server closes the socket (use it to
//                 watch a --share link die at its deadline)
//   --out FILE    write the bare Annex B stream, for `ffprobe -count_frames`
//
// Prints one JSON object: the `config` message, record and keyframe counts,
// the frame rate from the records' own timestamps, the largest gap between
// keyframes, and how the socket closed. Exits 1 if the upgrade was refused.
// Wire format: docs/architecture.md § H.264 video path.

import fs from "node:fs";
import { WebSocket } from "ws";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const seconds = Number(args.seconds ?? 5);
const url = `ws://${args.host || "127.0.0.1"}:${args.port || 8080}/video`;
const headers = args.token ? { "x-token": args.token } : {};

const out = args.out ? fs.openSync(args.out, "w") : null;
const report = { url, config: null, records: 0, keyframes: 0, bytes: 0, firstIsKeyframe: null, fps: null, maxKeyframeGapMs: null };
let firstPts = null, lastPts = null, lastKeyPts = null;

const finish = (extra, code = 0) => {
  if (out !== null) fs.closeSync(out);
  if (report.records > 1) report.fps = Number(((report.records - 1) / ((lastPts - firstPts) / 1e6)).toFixed(2));
  console.log(JSON.stringify({ ...report, ...extra }, null, 2));
  process.exit(code);
};

const ws = new WebSocket(url, { headers });
ws.on("unexpected-response", (_req, res) => finish({ refused: res.statusCode }, 1));
ws.on("error", (e) => finish({ error: e.message }, 1));
ws.on("open", () => {
  if (seconds > 0) setTimeout(() => ws.close(1000), seconds * 1000);
});
ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    report.config = JSON.parse(data.toString());
    return;
  }
  // One record per message: u32 length, u8 flags, 3 reserved, u64 pts (µs), payload.
  const length = data.readUInt32BE(0);
  const keyframe = (data[4] & 1) === 1;
  const pts = Number(data.readBigUInt64BE(8));
  if (length !== data.length - 16) finish({ error: `record length ${length} does not match message size ${data.length}` }, 1);
  if (report.records === 0) report.firstIsKeyframe = keyframe;
  report.records++;
  report.bytes += length;
  if (keyframe) {
    report.keyframes++;
    if (lastKeyPts !== null) report.maxKeyframeGapMs = Math.max(report.maxKeyframeGapMs ?? 0, Math.round((pts - lastKeyPts) / 1000));
    lastKeyPts = pts;
  }
  firstPts ??= pts;
  lastPts = pts;
  if (out !== null) fs.writeSync(out, data, 16);
});
ws.on("close", (code, reason) => finish({ close: { code, reason: reason.toString() } }));
