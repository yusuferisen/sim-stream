# Journal

> Append-only per-phase narrative. Never auto-loaded. Newest entries at the
> bottom. Entries before 2026-07-31 were reconstructed from git history by
> `/adopt` — they record what the commits show, not a contemporaneous account.

---

## 2026-04-24 — Phase 1: Core streaming + input

Initial commit (`121cd6d`). Established the whole shape of the tool in one go:
a ~550-line ESM Node server (`server.js`), a single-page browser client
(`public/index.html`), and a dev launcher (`scripts/start.sh`).

- **MJPEG hub** — `MjpegHub extends EventEmitter` spawns
  `axe stream-video --format mjpeg`, strips the leading HTTP headers AXe emits,
  and fans the byte stream out to every `GET /stream` client. Refcounted: the
  AXe process is spawned on the first client and stopped after a 5s grace
  window (`graceMs`) once the last one drops. A `generation` counter guards
  against a stale exit handler killing a freshly respawned process.
- **Input path** — `WS /ws` carries JSON events; `dispatchInput()` translates
  them into AXe argv, serialized through a `CommandQueue` FIFO so two taps
  never race. Acks return as `{type:"ack", id}`.
- **Coordinates** — the browser sends normalized `(0..1, 0..1)`; the server
  maps to simulator logical points via `boundsForDeviceType()`, a hand-kept
  table (iPhone 17 Pro Max → 440×956).
- **Auth** — a random 12-byte hex token, compared with
  `crypto.timingSafeEqual`, accepted as `?token=…` on every route and on the
  WS upgrade. `--auth false` disables it for local-only use.

Gotcha fixed in the same period: `scripts/start.sh` hit bash 3.2's empty-array
pitfall (`EXTRA[@]: unbound variable`) — resolved by building the flag string
and re-splitting rather than using an array.

---

## 2026-04-24 — Phase 2: Mobile UI

Commit `bd893c5`. The client was desktop-shaped; on a phone the controls panel
ate the screen. Reworked to fullscreen at ≤720px: the panel collapses into a
bottom sheet opened by a corner ⋯ FAB, dismissed by backdrop tap or by dragging
the handle down.

Deliberate asymmetry in the auto-close behavior: Hardware / Gesture / Send-text
actions close the sheet (they're one-shot), keyboard quick-keys
(Return/Back/Space/Tab) do not — so they can be chained without reopening.

---

## 2026-04-25 — Phase 3: Remote access providers

Commit `1a2d2b6`. The server bound to `127.0.0.1` and reaching it from a phone
meant hand-passing `--host 0.0.0.0`. Introduced `remote.js`: a `PROVIDERS` map
where each entry implements `prepare` / `start` / `stop`, selected by
`--remote <name>`.

Shipped providers: `lan` (sugar for `--host 0.0.0.0` + LAN-IP discovery via
`primaryLanIp()`), `tailscale-serve` (private HTTPS across the tailnet), and
`tailscale-funnel` (publicly reachable HTTPS).

Gotchas that shaped the code:
- Tailnet Serve/Funnel are off by default. The failure path was opaque, so the
  provider now parses the admin-console URL out of the CLI error and prints it
  — one click enables it.
- The App Store / standalone-installer Tailscale builds on macOS route
  serve/funnel through the GUI agent and can hang indefinitely. A 30s timeout
  was added so the command fails loudly instead of appearing to work.
  Homebrew's non-sandboxed `tailscaled` is the recommendation for headless Macs.

---

## 2026-05-12 — Phase 4: Build-vs-adopt evaluation (SimCast)

Commit `82a3213`. Evaluated `simcast-dev/simcast` as a replacement for this
repo. **Verdict: keep `sim-stream`.**

The deciding factor was the auth model, not the feature list: SimCast keys its
realtime channel to a single Supabase user that both the macOS app and the web
dashboard must sign into, so there is no token-URL share story — which is
exactly this tool's workflow. Bring-up cost (Supabase project + 2 SQL
migrations + an edge function with 3 secrets + LiveKit Cloud + a Vercel deploy)
versus `npm i && node server.js` reinforced it, as did the repo health signal
(3 stars, ~7 weeks old, schema still moving).

SimCast's one real advantage — 60fps WebRTC via ScreenCaptureKit + VideoToolbox
against our ~7–10fps AXe screenshot loop — was judged **severable**: buildable
later as a Swift helper feeding our existing pipeline, no re-platforming
required. Full report: `docs/research/2026-05-12-simcast-evaluation.md`.

---

## 2026-07-31 — /adopt: converged onto the canonical doc contract

Structural only; no behavior changed. The repo was born outside the autopilot
pipeline and had no `PROGRESS.md`, so `autopilot-doctor.sh` exited 3.

- Relocated `simcast-evaluation.md` → `docs/research/2026-05-12-simcast-evaluation.md`
  (content untouched).
- Evicted the `### Roadmap` section from `README.md` — its five remote-access
  improvement items became plan prose in `docs/ROADMAP.md` and checklist items
  in `PROGRESS.md`. README keeps a pointer.
- Unioned the roadmap: the five README items plus the three "worth stealing
  from SimCast" items (WebRTC pipeline, screenshot gallery, tap-by-a11y-label)
  now live as one checklist in `PROGRESS.md`. Nothing was dropped.
- Stubbed `docs/PRD.md`, `docs/OVERVIEW.md`, `docs/architecture.md`,
  `docs/DECISIONS.md`, root `CLAUDE.md`, and this file from repo reality.
- Phases 1–4 above were reconstructed from git history so the checked boxes in
  `PROGRESS.md` could be trimmed to label + title without losing the narrative.

Milestone placed after Phase 6 (**Safe public sharing**) per an explicit
decision during adoption: the token in the URL bar is the only gate on a
Tailscale Funnel URL, so hardening ranks above the framerate rewrite.

---

## 2026-09-30 — 5.1 (cookie handoff)

An authorized `GET /?token=…` now sets an httpOnly `sim_stream_<PORT>` cookie
(`SameSite=Lax`, `Secure` over https) and 302s to the token-free URL. Both check
sites (HTTP `authCheck`, WS upgrade) call one `requestAuthorized()` accepting
query, `x-token`, or cookie, which ends the old query-only WS asymmetry. The
client no longer reads or forwards the token; that also fixed a latent
malformed `/stream&_r=` reconnect URL under `--auth false`. Verified by hand on
a sandbox clone: a 13-case curl/ws auth matrix, plus a real browser where the
address bar was clean, `document.cookie` was empty, and the stream, WS, and
reload grace window all held. Gotcha: `axe tap` takes ~10 s on the iOS 27 clone
while streaming, which is environmental and unrelated to auth.

---

## 2026-09-30 — 5.2 (expiring per-share tokens)

The single `TOKEN` constant became a `ShareRegistry` in a new pure module,
`shares.js`: the operator's token (never expires) plus one random token per
repeatable `--share [label=]<ttl>`. Expiry is defined once (`remaining()`), is
reached when either the wall or the monotonic clock says so, and latches. The
part the spec didn't spell out turned out to be the important one: `/stream`
and `/ws` authorize only at connect, so an open tab would have outlived its
link — connections are now tracked per share and closed at the deadline
(`1008 "share expired"`; the client shows a toast and stops retrying). Review
also changed credential precedence to "one channel decides" (query, else
`x-token`, else cookie), because with fall-through an expired link still
opened in the operator's own browser. Providers now return a token-free base
URL and the server prints one link per share. Phase 5 (token & session
hardening) is complete.

Tests: first automated suite — `npm test`, 21 `node:test` cases on
`shares.js`, each of 11 hand-made mutations killed. Live on a sandbox clone: a
55-check curl/WebSocket matrix (incl. a raw socket that ignores the close
frame), Chrome watching a share die at its deadline, and the `lan` provider
opened from a bench iPhone. Gotchas: `simctl io screenshot` timed out (10 s) on
the iOS 27 clone while streaming — the same environmental slowness 5.1 saw with
`axe tap`;
the Tailscale providers' one-line URL change was not exercised against a real
tailnet.

## 2026-09-30 — 7.1 (Swift encoder helper)

New optional SwiftPM package `helper/` → `sim-stream-encoder`: AXe's raw BGRA
frames on stdin, VideoToolbox H.264 (Main, no B-frames, keyframe ≤ 1 s, SPS +
PPS on every keyframe) on stdout, as 16-byte-header records (`framed`) or bare
Annex B (`annexb`); `npm run build:helper` builds it. The surprise: AXe's raw
frames are **not** `w×h×4` — rows are padded to 64 bytes (603 px → 2432 B/row)
and at scale 1.0 the row count is padded to 16 (2622 → 2624), so feeding the
naive size shears the picture. The layout rule was measured at six scales and
lives in the helper (`--source WxH --scale S`), pinned by tests to the measured
frame sizes. H.264 4:2:0 can't code odd sizes, so 603×1311 encodes as 602×1310.
`server.js` / `start.sh` untouched; the contract 7.2 builds on is in
`docs/architecture.md` § H.264 encoder helper. Tests: `swift test` 11 tests
(25 cases); live on a sandbox clone, scrolling Settings: 30.3 fps at scale 0.5
and 30.7 at 1.0 from framed timestamps, keyframes ≤ 1.05 s apart, `ffprobe`
decoding every frame; `npm test` still 21/21.

## 2026-09-30 — 7.2 (H.264 hub + authenticated `/video` WebSocket)

The server now spawns `axe stream-video --format bgra` with its stdout handed
straight to the encoder helper (a file descriptor, never through Node) and
serves the result on `/video`: one JSON `config` message (codec string read
from the SPS), then one helper record per binary message. New pure module
`h264.js` holds the capture plan, the record parser, the group-of-pictures
cache and `H264Hub` — refcount, 5 s grace window, generation guard,
keyframe-on-join, and the slow-viewer rule (skipped forward at ~2 s of
backlog, closed with `1013` after 10 s behind). `/video` authorizes through
`requestAuthorized()` in the shared upgrade handler and registers with
`ShareRegistry.track()`; `/api/info` and `hello` advertise `h264`, and status
is broadcast as `{type:"h264"}`. `start.sh` builds the helper when it is
missing or stale; without it the server logs "MJPEG only" and `/video` answers
`404`. MJPEG and the page are untouched. New `scripts/video-probe.js` is the
scripted client used for the done check.

Found on the way, both in the WebSocket entry `/video` was about to share and
both fatal to the process: a malformed `Host` header on any upgrade request
threw out of the handler (no credential needed), and a protocol-invalid frame
on `/ws` was an unhandled `error` event. Fixed; now an invariant in
`docs/architecture.md`. Gotcha: `simctl io <udid> screenshot -` does not write
to stdout — it creates a file named `-` — so the startup pixel-size probe goes
through a temp file. Node's stdio pipes are socketpairs on macOS; handing one
to the helper still held 30 fps at scale 1.0.

Tests: `npm test` 59/59 (38 new — parser at every chunk boundary, the cache,
the hub on a fake pipeline and clock); `swift test` 11. Live on a sandbox
clone: 5 s of `/video` = 146 records at 31 fps, keyframes ≤ 1.0 s apart,
`ffprobe` decoding every one; 1206×2622 at scale 1.0 and 300×654 @10 fps also
decode; unauthenticated upgrade `401`; a `--share 30s` viewer closed with
`1008 share expired`; three connections inside the grace window = one spawn;
killing either child closes viewers with `1011` and leaves no process behind;
a viewer that never reads is dropped and the capture stops; Chrome's
`VideoDecoder` decoded 90/90 frames over the cookie. Taps measured 1.1–2.0 s
with `/video` streaming.
