# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–5: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation, token & session hardening) have been pruned from
> here. Their narrative is in
> `docs/JOURNAL.md`, their rationale in `docs/DECISIONS.md`, and the system as
> built is described in `docs/OVERVIEW.md`.

---

## Phase 6 — Cloudflare quick tunnel

**Why.** A second exit route that needs no account at all. `cloudflared tunnel
--url http://127.0.0.1:<port>` mints an anonymous `trycloudflare.com` hostname
on the spot — useful when Tailscale isn't installed, when its macOS GUI-agent
path is hanging (a failure we've already hit), or when you want Cloudflare's
larger edge in front of the stream.

**Scope.** One `PROVIDERS` entry implementing `prepare` (bind `127.0.0.1`),
`start` (spawn the tunnel, parse the assigned hostname out of its output,
return the token-free base URL — the server adds the tokens), and `stop` — **`stop` is mandatory here**: the tunnel is a
long-lived child process and without teardown it outlives the server.

**Trade-off to settle before recommending it.** MJPEG is a single long-lived
`multipart/x-mixed-replace` response and Cloudflare's edge may buffer it —
which would surface as a stalled first frame or visible stutter. Verify against
a real tunnel; if it buffers, say so in the README rather than quietly shipping
a worse path than Tailscale. On the same tunnel, confirm that a short `--share`
link still cuts the stream at its deadline — expiry has to hold through the
edge, not just on the LAN.

**Out of scope.** Installing `cloudflared` — treat a missing binary the way
`start.sh` already treats a missing `axe`: fail immediately with the install
command, don't attempt a download.

---

## 🏁 Milestone: Safe public sharing

The stop point. After Phase 6, exposing this tool beyond the LAN no longer
rests on a permanent secret parked in a URL bar: the credential rides in an
httpOnly cookie, share links expire on their own, and killing the process
revokes every outstanding link. Everything past here is capability, not risk
reduction.

---

## Phase 6b — Gated public sharing (Cloudflare Access)

**Deferred past the milestone, deliberately** — see `DECISIONS.md § Phase 6.2
deferred`. This is the only option where a leaked URL *and* a leaked token
still don't get someone in: a *named* Cloudflare tunnel on a domain you own,
with Cloudflare Access (email magic link / OAuth / IP rules) in front. Free up
to 50 users.

**Why it isn't in the milestone.** It requires a domain on a Cloudflare
account, which doesn't exist yet. The phase could be written but not verified,
and an unverifiable item shouldn't gate a stop point.

**Prerequisite before this phase can start:** a domain on Cloudflare, a named
tunnel, and an Access policy. All one-time manual setup — documented like the
Tailscale prerequisites, never automated.

**Note on intent.** This phase is the reason `docs/PRD.md` principle 2 was
amended: it puts a login in front of the stream, which the original inferred
wording banned outright. The settled position is that a gate is legitimate as
an *opt-in per-share choice* and never as the default path.

---

## Phase 7 — Capture pipeline (AXe raw frames → H.264 → WebCodecs)

**The ceiling, re-measured.** The ~7–10 fps limit is real, but it is not a
capture limit: AXe's `mjpeg` mode is slow, while its raw `bgra` mode delivers
a steady ~30 fps from the same simulator — headless, with no Screen Recording
permission, and pixel-exact (`DECISIONS.md § Phase 7 capture source`). What is
missing is an encoder and a transport that can carry 30 fps without 30 JPEGs a
second. ~8 fps is adequate for "did the button land in the right place" and
inadequate for anything about motion — animation review, scroll feel, gesture
responsiveness.

**Scope, in three slices.**

- **7.1 — Swift encoder helper.** A small SwiftPM executable under `helper/`
  that reads raw BGRA frames on stdin (dimensions and rate passed as
  arguments), hardware-encodes H.264 with VideoToolbox, and writes one framed
  access unit per frame on stdout. Low-latency settings: real-time, no frame
  reordering, a keyframe every second, parameter sets repeated with every
  keyframe so a stream can be joined at any keyframe. It stands alone: piping
  `axe stream-video --format bgra` through it into a file must give a stream
  `ffprobe` reads at ≥25 fps. It carries its own `swift test` target for the
  argument and framing logic, and an `npm run build:helper` script that builds
  it. It also writes the helper's command line and stdout framing into
  `docs/architecture.md`: 7.2 is built in a separate session and must work
  from that written contract, not from reading the Swift. `server.js` and
  `start.sh` are not touched in this slice.
- **7.2 — H.264 hub and `/video` WebSocket.** A second hub beside `MjpegHub`
  with the same invariants — refcount with the 5 s grace window, the generation
  guard, status broadcast — that spawns AXe and the helper, caches the current
  group of pictures so a joining viewer starts on a keyframe at once, and
  sends access units as binary WebSocket messages. A viewer that falls behind
  is skipped forward to the next keyframe rather than buffered without bound.
  `/video` authenticates through `requestAuthorized()` and registers with
  `ShareRegistry.track()`, exactly like `/stream` and `/ws`. `/api/info` and
  the `hello` frame advertise whether H.264 is available (helper built) and
  its dimensions. The parser, cache and drop logic live in an import-safe
  module with `node:test` coverage. This slice also owns the wiring 7.1 left
  alone: `start.sh` builds the helper when `swift` is on PATH, and the server
  checks for the built binary at startup and logs which path it will serve.
  MJPEG is untouched. **Done when** a scripted WebSocket client saves 5 s of
  `/video` that `ffprobe` reads at ≥25 fps, an unauthenticated upgrade is
  refused with `401`, and a `--share 30s` connection is closed at its
  deadline with `1008 share expired`.
- **7.3 — Browser player with fallback.** On a secure context with
  `VideoDecoder` available and H.264 advertised, the client decodes to a
  `<canvas>`; everywhere else — plain-http LAN, no helper built, an old
  browser, a decoder error — it keeps the MJPEG `<img>` exactly as today. The
  header shows which path is live. Gesture detection and the normalized
  coordinate mapping must behave identically on both surfaces.

**Explicitly not.**

- **ScreenCaptureKit.** It captures a visible Simulator.app window; this host
  runs its simulators headless, so there is nothing to capture. It would also
  need a Screen Recording grant and bezel cropping. Its only gain is 60 fps
  over 30 — revisit as a lettered phase if 30 fps ever proves too little.
- **WebRTC.** Its media cannot cross the HTTP-only tunnels the `--remote`
  providers use (Funnel, Cloudflare, ngrok) without a hosted relay, and it
  brings a large library into a two-dependency project.
- **Removing MJPEG.** It stays as the zero-build, works-anywhere default.
- LiveKit, Supabase, or any hosted service (`DECISIONS.md § Build vs. adopt`).
- A required build step. `npm i && node server.js` must still reach a first
  frame with no helper built; the helper is an upgrade, not a prerequisite.

**Watch for.**

- The raw stream is ~95 MB/s at the default scale and ~380 MB/s at full scale.
  Hand AXe's stdout to the helper as a file descriptor; never pump it through
  Node.
- Raw BGRA has no header, and the server knows logical points
  (`boundsForDeviceType`), not pixels. Take the device's pixel size from a
  screenshot's PNG header and apply the scale with AXe's rounding (measured:
  1206×2622 → 603×1311 at 0.5). Never hardcode it, and never derive it from
  the bounds table — a wrong size is garbled video.
- Scale 0.5 yields odd frame dimensions (603×1311). H.264 4:2:0 wants even
  ones — pad or crop in the helper, and make sure the client's coordinate
  mapping still covers exactly the device screen.
- `/video` is a new long-lived entry point. Without the auth check it is a
  hole; without `track()` it outlives its share link. Close codes keep their
  meaning: `1008` with `share expired` is final, other `1006`/`1008` are a bad
  credential.
- Two hubs can run two AXe capture processes at once if one viewer is on MJPEG
  and another on H.264. Acceptable; don't build a shared-capture layer for it.
- Taps measured 3.0–3.5 s with the 30 fps capture running, against a 5 s queue
  timeout. Re-measure in 7.3. Input correctness outranks smoothness (PRD
  principle 5): lower the capture rate before loosening the queue.
- A real-iPhone check of the H.264 path needs an https route; the Phase 6
  quick tunnel is the account-free one.

**Later idea, not scheduled.** Plain-http LAN links stay on ~8 fps MJPEG under
this plan. The same helper could emit JPEGs instead of H.264 and feed the
existing MJPEG path at 30 fps, closing that gap with no browser changes. It
costs roughly 25 Mbit/s, so it suits the LAN and nothing else. If LAN
smoothness turns out to matter, add it as a lettered phase.

---

## Phase 8 — Borrowed conveniences

Small, independent, additive. None of them changes the architecture; each can
land alone.

- **8.1 — Screenshot gallery.** Screenshots currently drop into
  `~/Desktop/sim-stream-<timestamp>.png` and are immediately hard to find. New
  ones land in `~/Desktop/sim-stream/`, and an authenticated `/gallery` page
  shows a newest-first thumbnail grid linking to the full images. Thumbnails
  come from macOS's built-in `sips`, cached beside the originals — no image
  library. The gallery answers only to the owner credential: a share link is
  for driving the simulator, not for browsing what was captured before it was
  issued. With `--auth false` there is no owner credential and the gallery is
  open, like every other route. File serving takes a bare filename matched against the directory
  listing, never a path. Read-only — no delete or rename endpoint. The listing
  and filename rules live in an import-safe module with `node:test` coverage.
  SimCast's `pending → ready/failed` persistence lifecycle is overkill here —
  stay on the filesystem.
- **8.2 — Tap by accessibility label.** AXe (1.8.0 on this host) resolves
  labels itself: `axe tap --label`. So this is a new `tap-label` input event
  that goes through the same FIFO command queue as every other input, plus a
  text field in the controls panel. A leading `#` targets an accessibility
  identifier (`--id`) instead. When a label is missing or matches more than
  one element, AXe says so; that message reaches the viewer as the normal
  error toast — the server never guesses which element was meant. Directly
  useful for verifying agent-built UI without hunting for pixel positions.

**Open question carried from the evaluation.** If the gallery ever wants to
sync across devices it reproduces exactly the persistence problem that made
SimCast unattractive. Keep it local.

---

## Phase 8b — `ngrok` provider

**Parked behind an owner prerequisite, deliberately** — see `DECISIONS.md §
ngrok provider parked as Phase 8b`. Same provider shape as Phase 6: `prepare`
binds `127.0.0.1`, `start` spawns the tunnel and returns the token-free base
URL, and `stop` is mandatory.

**Prerequisite before this phase can start:** `ngrok` installed and an ngrok
account. Every ngrok tunnel now needs an authtoken; it lives in the login
Keychain and reaches the provider as `NGROK_AUTHTOKEN`, never through a repo
file or ngrok's own config file written by this tool.

**Why it isn't in Phase 8.** It cannot be verified without that account, and
its original reason — a one-off share without a Cloudflare account — is
already met by the Phase 6 quick tunnel, which needs no account at all. Note
too that ngrok's free tier puts a warning page in front of the first load.
