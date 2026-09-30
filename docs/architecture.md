# Architecture — the engineering contract

> Inferred by /adopt from the codebase — verify.
>
> Timeless. Describes what **is**: modules, data flow, invariants, seams, and
> how to test. No dates, no status, no step plans — those live in
> `docs/JOURNAL.md`, `PROGRESS.md`, and `docs/ROADMAP.md` respectively.

## Shape

A single-process ESM Node server that translates browser events into commands
against one **backend** — the iOS Simulator through the AXe CLI, or a real
bench device through WebDriverAgent — and
pipes the backend's video back out: as MJPEG always, and as H.264 when the
optional encoder helper is built. There is no required build step, no
database, no framework beyond Express + `ws`, and no state that outlives the
process.

| Module | Responsibility |
|---|---|
| `server.js` | The target-agnostic server: arg parsing, the auth check sites, HTTP routes, both WebSocket endpoints, wiring the hubs to the backend, the screenshot control's destination, the banner, shutdown. Spawns nothing but `sips`. |
| `backends/simulator.js` | The simulator backend (§ Backends): simulator discovery and boot, `axe` resolution, the bounds table, the `axe stream-video` MJPEG source (AXe's HTTP preamble stripped), the H.264 capture pipeline (AXe piped into the helper), input event → `axe` argv, `simctl` screenshots. Import-safe; its pure pieces (`pickSimulator`, `boundsForDeviceType`, `axeInputArgs`, `axeTimeoutMs`, `stripHttpPreamble`) are unit-tested. |
| `backends/device.js` | The device backend (§ Backends, *Device backend*): `--device` resolution (a UDID, or a bench role through `qa-device`), the WDA client and its one-retry session recovery, WDA's MJPEG settings, the `ios forward` child it owns, bounds, screenshots and input through WDA (wake, W3C touches, keys, buttons, tap by label). Import-safe; its pure pieces (`wdaSettings`, `deviceTarget`, `parseBoundary`, `resolveDeviceSpec`, `wdaInputRequest`, `labelPredicate`, `pickLabelTarget`) and the whole startup and input path are tested against a fake WDA and `test/fixtures/fake-ios`. |
| `backends/queue.js` | `SerialQueue`: the strict FIFO every backend runs its input commands through. Pure. |
| `mjpeg.js` | `MjpegHub`: refcount, grace window, generation guard and fan-out for the MJPEG source, source-agnostic. Pure, like `h264.js`: the source and the timers are handed in, so it is unit-testable without a simulator. |
| `h264.js` | The H.264 path's logic (§ H.264 video path): the capture plan, the helper-record parser, the group-of-pictures cache, and `H264Hub` — refcount, grace window, generation guard and per-viewer delivery. Pure, like `shares.js`: the pipeline, the sockets, the clock and the timers are handed in, so it is unit-testable without a simulator. |
| `shares.js` | The credential registry (`ShareRegistry`): the owner token plus expiring share tokens, constant-time matching, the definition of expiry, and the tracking that ends long-lived connections when a share dies. Pure — no I/O, no side effects at import, clocks injectable — so it is unit-testable without a simulator. Also exports `parseTtl` / `parseShareSpec`. |
| `tap-label.js` | Tap by accessibility label: the viewer's text → a `{by, target}` both backends use (`parseTapTarget`), → `axe tap --label=…` / `--id=…` arguments, and AXe's failure output → the one line the error toast shows. Pure; `parseTapTarget` / `tapLabelArgs` / `axeErrorLine`. |
| `gallery.js` | The screenshot gallery's rules (§ Screenshot gallery): the folder and file names, which names may be served (matched against the directory listing), the `sips` thumbnail cache, and the `/gallery` page. Import-safe; `sips` is handed in. |
| `remote.js` | Remote-access providers only. Exports `getRemoteProvider(name)` and `listRemoteProviders()`, plus the `cloudflared` provider's pieces for tests (`cloudflaredProvider` factory, output parsers, `waitForAuthoritativeDns`). Knows nothing about streaming or input. Import-safe: nothing runs until a provider's hook is called. |
| `public/index.html` | The entire client — markup, styles, and script in one file: the H.264 player (WebCodecs → `<canvas>`), the MJPEG `<img>` it falls back to, the input layer. Served with one templated substitution. |
| `helper/` | **Optional** SwiftPM package: `sim-stream-encoder`, raw BGRA frames (or, `--input mjpeg`, a device's MJPEG body) on stdin → VideoToolbox H.264 on stdout. Built by `npm run build:helper` (or by `start.sh`); nothing requires it (§ H.264 encoder helper). Its pure logic (`EncoderCore`: arguments, AXe's frame layout, the JPEG scanner and SOF reader, output framing) has a `swift test` target. |
| `scripts/start.sh` | Dev launcher: verifies AXe is present (skipped with `--device`), installs node deps if absent, builds the encoder helper when `swift` is on PATH and the binary is missing or older than its sources (a failed build is reported and skipped, never fatal), handles `--list`, translates `--no-auth` → `--auth false`, `exec`s the server. |
| `scripts/video-probe.js` | Verification tool: a scripted `/video` client that reports what arrived (record and keyframe counts, frame rate, close code) and can save the stream for `ffprobe`. Not used by the server. |

## Dependencies

- **Runtime:** Node 18+ (ESM, `crypto.timingSafeEqual`, `EventEmitter`).
  Production deps are `express` and `ws` — nothing else. Tests use the
  built-in `node:test` runner; there are no dev dependencies.
- **External binaries:** `axe` (capture + HID injection) and `xcrun simctl`
  (device enumeration, boot, screenshots). Both must exist on the host; neither
  is installable in CI, which is why there is no CI. `swift` (the Xcode
  toolchain) is needed only to build the optional encoder helper. `sips`
  (built into macOS) makes the gallery's thumbnails; without it the gallery
  shows full images. **Device mode only:** `ios` (go-ios) for the
  port-forward, and a WebDriverAgent already running on the device (the bench's
  `qa-device up <role>`); `qa-device` itself only when `--device` names a role.
  AXe and `simctl` are not used then.
- **No network service on the default path.** Running the tool requires no
  account, no hosted backend, no auth provider, and no storage — it works
  offline and air-gapped. The shipped Tailscale and `cloudflared` providers
  are hosted services, but they are **opt-in per run** via `--remote`
  and nothing depends on them otherwise. That asymmetry is load-bearing, not
  accidental — see `docs/PRD.md` § Principles and `docs/DECISIONS.md`.

## Data flow

Independent channels, deliberately not multiplexed:

1. **Video (MJPEG), server → browser.** `GET /stream` responds
   `multipart/x-mixed-replace; boundary=<the backend's>` and registers the
   response with the `MjpegHub`. The hub opens the backend's MJPEG source —
   for the simulator, `axe stream-video --format mjpeg` with the leading HTTP
   headers AXe emits stripped off; for a device, WDA's MJPEG server through
   the backend's `ios forward` — and writes every chunk of the body to all
   registered responses. The browser decodes it natively in an `<img>`.
2. **Video (H.264), server → viewer.** `WS /video`, present only when the
   encoder helper is built. `H264Hub` opens the backend's H.264 pipeline —
   `axe stream-video --format bgra` with its stdout handed straight to
   `sim-stream-encoder` — parses the helper's records, and sends each as one
   binary message (§ H.264 video path). The page plays it when it can (§ Browser player); scripts use it
   too.
3. **Input, browser → server.** `WS /ws` carries JSON events. Each is parsed,
   handed to the backend's `input()` (the screenshot control to its
   `screenshot()`), and acked as `{type:"ack", id}` or
   `{type:"error", id, message}`.

Out-of-band on the input WebSocket: a `{type:"hello", simulator, bounds,
stream, h264}` frame on connect, `{type:"stream", status}` broadcasts whenever
the MJPEG hub's status changes, and `{type:"h264", status}` whenever the H.264
hub's does.

## Invariants

These are the properties the code maintains; breaking one is a regression even
if nothing throws.

- **One input command at a time.** Every backend runs its commands through a
  `SerialQueue` (`backends/queue.js`), a strict FIFO with a `running` flag.
  Concurrent taps must never reach the target in parallel — ordering is the
  whole point. Screenshots do not queue (§ Notable asymmetries).
- **The capture process is refcounted, with a grace window.** `MjpegHub` opens
  the backend's source for the first client and closes it 5 s (`graceMs`)
  after the last one leaves. Page reloads are a leave-then-join inside that
  window and must not restart the capture. `H264Hub` keeps the same rule for
  its own pipeline; the two hubs are independent, so one MJPEG viewer plus one
  H.264 viewer means two capture processes — accepted, not shared.
- **Only the current generation may act.** Each open bumps `generation`; the
  data handler *and* the exit handler each capture it and compare before doing
  anything. Without it, a dying old process tears down its replacement and its
  trailing output bleeds into the new stream. Both hubs also bump it on every
  deliberate stop and on a death, so the exit of a source they stopped is
  never mistaken for a failure; a source that ends on its own — whatever its
  exit code — is `dead`, which is what makes the page reconnect.
- **Status is broadcast, never inferred.** `idle | live | dead` transitions
  emit to every WebSocket client, so a viewer that connected while the stream
  was dead learns when it recovers. The client must not derive status from
  page-load state.
- **Coordinates are normalized on the wire.** The browser sends `(0..1, 0..1)`;
  only the backend knows logical points. `axeInputArgs`'s `pt()` clamps to
  `[0,1]` before scaling by `bounds`, so a malformed or out-of-range event
  cannot produce an off-screen coordinate.
- **The gallery answers only to the owner.** `/gallery` and its file and
  thumbnail routes pass `authCheck` and then `ownerOnly`: a share link is `403`
  there, and `/api/info`'s `gallery` flag (which shows the page's link) is
  false for it. With `--auth false` there is no owner to tell apart, so it is
  open like every other route.
- **A gallery request names a file, never a path.** The bare name must be a
  plain `.png` name *and* one of the regular files (not symlinks) in the
  directory listing; the path is built from the listed name. Anything else —
  `..`, an encoded `/`, a dot-file, `.thumbs/…`, a symlink — is `404`.
- **No stack trace leaves the server.** A final Express error handler answers
  plain `Bad request` / `Internal error`: route parameters are decoded before
  `authCheck` runs, so Express's default error page would show a malformed one
  (`/gallery/file/%E0%A4%A.png`) with server paths to anyone.
- **Auth is checked at two sites through one function.** Every HTTP route
  (`/`, `/api/info`, `/stream`, `/gallery…`) goes through the `authCheck` middleware; both
  WebSocket endpoints (`/ws`, `/video`) are checked in the single
  `server.on("upgrade")` handler before `handleUpgrade` — path, then
  credential (`401`), then whether `/video` exists at all (`404` without the
  helper). Both sites call `requestAuthorized(req, queryToken)`, which
  returns the registry entry the request is authorized as (or `null`) from one
  of three channels: `?token=`, an `x-token` request header (scripted access),
  or the `sim_stream_<PORT>` cookie. Credential channels are added or removed
  **there**, never at a call site, so the two sites cannot drift apart. A new
  entry point without a check is a hole.
- **One credential decides each request.** `?token=` if the request carries
  one (even empty or malformed), otherwise `x-token`, otherwise the cookie —
  with no falling through to a lower channel. A link therefore behaves the
  same in every browser: a dead `?token=` is `401` even when the browser holds
  a valid cookie, so an expired share link looks expired to the operator too.
- **Every accepted token lives in one registry.** `ShareRegistry` holds the
  owner token (entry 0, never expires) and one entry per `--share`, each
  `{label, value, expiresAt}`. It is in-memory, populated once at startup, and
  has no mint-over-HTTP path; restarting the process revokes everything. With
  `--auth false` there is no registry, and `--share` is refused rather than
  ignored.
- **Expiry has a single definition: `ShareRegistry.remaining(entry)`.**
  `match()`, the cookie's `Max-Age`, per-message WebSocket checks, and the
  expiry sweep all go through it, so they cannot disagree about the boundary
  (live at `expiresAt − 1 ms`, dead at `expiresAt`). A share is dead as soon
  as **either** clock says so — the wall clock (the deadline printed at
  startup; keeps counting through machine sleep) or the monotonic clock
  (cannot be set back) — and expiry **latches**: once observed dead, an entry
  stays dead whatever the clocks do. Every failure direction is "dies early,"
  never "lives longer."
- **Expiry ends open connections, not just new requests.** `/stream`, `/ws`
  and `/video` authorize once, at connect, so each registers with
  `ShareRegistry.track()` against the share that admitted it. `watch()` sweeps
  at each deadline (and at least once a second, which also keeps every delay under `setTimeout`'s
  2³¹−1 ms ceiling): MJPEG responses are destroyed — which fires `close`, the
  same path the hub's refcount uses — and WebSockets are closed with `1008`
  and the reason `share expired`. Input is additionally checked per message,
  because `close()` only starts a handshake and a client may never answer it;
  for the same reason a `/video` viewer is taken out of the hub *before* its
  socket is closed, so not one more frame is sent to it.
  A new long-lived entry point must `track()` its connection or it outlives
  its link.
- **Nothing a client sends may throw out of a handler.** The upgrade handler
  parses the request target against a fixed base — never the `Host` header,
  which is attacker-controlled and need not be a valid hostname — and every
  accepted WebSocket has an `error` listener, because `ws` reports a malformed
  frame as an `error` event and an unhandled one is an uncaught exception.
  Either omission lets a single request take the process down.
- **A `/video` viewer only ever receives a decodable stream.** Its first frame
  is a keyframe, preceded by one `config` message, and it is never sent a delta
  frame after a gap. A viewer whose socket holds more than about two seconds of
  unsent video is sent nothing until a keyframe arrives with that backlog
  mostly drained — skipped forward, never queued for without bound — and one
  that stays behind for 10 s is closed, so a vanished peer cannot keep the
  capture pipeline running.
- **The token leaves the URL on page load.** An authorized `GET /` (or
  `GET /gallery`, through the same `cookieHandoff` middleware) whose URL
  still carries `token` responds `302` to the same URL minus that parameter,
  with `Set-Cookie: sim_stream_<PORT>=…; HttpOnly; SameSite=Lax; Path=/`
  (`Secure` when the request arrived over https, directly or via
  `X-Forwarded-Proto`). The cookie holds the token that was presented, and for
  a share carries `Max-Age` equal to its remaining lifetime (rounded up — the
  server stays the authority); the owner's is a session cookie. The browser
  client never reads or forwards the token — `/api/info`, `/stream`, and `/ws`
  are same-origin and ride the cookie. The cookie name carries the port
  because cookies are host-scoped, not port-scoped.
- **Token comparison is constant-time.** `ShareRegistry.match()` uses
  `crypto.timingSafeEqual` on equal-length buffers and compares against every
  entry with no early exit. Never replace it with `===`.
- **Value flags fail loudly.** Flags in `VALUE_FLAGS` raise if their value is
  missing, so `--token --port 9090` errors instead of silently treating
  `token` as the boolean `true`. Flags in `REPEATABLE_FLAGS` (`--share`)
  accumulate into an array instead of last-one-wins. A `--share` TTL needs an
  explicit unit and a unique label, or the server refuses to start.

## Seams

Places designed to be extended, and the contract each one implies.

- **Backends** (`backends/`). Everything that knows what is being driven —
  which target, its bounds, the video source, the H.264 pipeline, input and
  screenshots — is one object behind this interface; `server.js`, `MjpegHub`
  and `H264Hub` call nothing else. Auth, shares, tunnels, the player, the
  gallery and the wire formats are target-agnostic and never change for a new
  backend. Two implementations, selected by flag in `server.js`:
  `createSimulatorBackend({udid, mjpeg:{fps,quality,scale},
  h264:{encoder,fps,scale}, log})` (the default) and
  `createDeviceBackend({device, wda, mjpeg:{fps,quality,scale},
  h264:{encoder,fps}, log})`
  (`--device`). Both are `async` — they boot or connect and measure the screen
  — and a creation failure exits the server with the message, before it
  listens.

  | Member | Contract |
  |---|---|
  | `kind` | `"simulator"` (a device backend says `"device"`). |
  | `target` | What `/api/info`'s `simulator` field and the `hello` frame show: `{udid, name, state, runtime, deviceType}`. |
  | `bounds` | `{w, h}` in logical points, portrait — what normalized coordinates scale by and what the page's aspect ratio comes from. |
  | `h264` | The capture plan, decided once at creation: `planCapture()`'s result (`ok`, `width`, `height`, `fps`, `scale`, `bitrate`, `notes`) or `{ok: false, reason}`. The server builds `/api/info`'s `h264` and the `H264Hub` from it and never asks again. |
  | `mjpegBoundary` | The multipart boundary as it appears in the body (AXe: `--mjpegstream`); `/stream`'s `Content-Type` carries it. |
  | `openMjpeg()` | Returns a **source**: an emitter with `data` (chunks of the bare multipart body — the backend strips any HTTP preamble; the hub parses nothing), `exit` (once, with a detail string) and `kill()`. Throws if it cannot start; the hub reports `dead`. |
  | `h264Pipeline()` | The same shape, emitting the encoder helper's records (§ H.264 encoder helper, *Output*). Throws when `h264.ok` is false. |
  | `input(evt)` | Runs one input event (§ Input events) through the backend's `SerialQueue`; resolves to `undefined` or `{detail}` for the ack, rejects with the message the error toast shows. `button: screenshot` is **not** an input — the server routes it to `screenshot()` (the destination and the toast are the server's). |
  | `screenshot(dest)` | Writes a PNG of the screen to `dest`. Never queued behind input. |
  | `stop()` | Tears down anything the backend itself owns (the simulator backend owns nothing: capture processes belong to the hubs, commands are one-shot). Called at shutdown after the hubs stop. |

  Log lines the checklist looks for come from the backend through `log`:
  `[sim] selected:`, `[mjpeg] spawn:`, `[h264] spawn:`; in device mode
  `[device] selected:`, `[device] forward ready:`, `[mjpeg] open:`. Adding a
  backend means another module with this shape and the flag that selects it;
  the hubs and the routes do not change.

  **Device backend** (`backends/device.js`). `--device <udid|role>` and
  `--wda <url>` (default `http://localhost:8100`); `primary|secondary|tablet`
  ask `qa-device udid|port <role>`, and an explicit `--wda` wins over the
  role's port. `--device` with `--udid`, or `--wda` without `--device`, is
  refused at startup. Creation, in order, each step failing with its fix:
  go-ios present (`npm i -g go-ios`) → WDA `/status` answers (else `Start it
  with: qa-device up <role>`) → identity from `ios info` (`DeviceName`,
  `ProductType`, `ProductVersion`; WDA's `/wda/device/info` only as a
  fallback) → a WDA session, with `--fps`/`--scale`/`--quality` applied as
  `mjpegServerFramerate` / `mjpegScalingFactor` (percent) /
  `mjpegServerScreenshotQuality`, clamped to WDA's ranges → `bounds` from
  `/window/size` (points, made portrait) → the forward. The MJPEG rate
  defaults to 30 in device mode (15 for a simulator).

  *The forward.* A host port the OS reports free, then `ios forward
  --udid=<U> <port> 9100` as a child the backend owns. Startup waits (10 s)
  until a GET through it answers `200 multipart/x-mixed-replace`; the
  boundary is taken verbatim from that header (WDA: `--BoundaryString`). Any
  other answer fails at once, and the child is judged *after* an answer — if
  go-ios reported a bind failure or exited, startup fails with its words
  rather than streaming from whatever holds the port. `stop()` sends SIGTERM
  then SIGKILL after 1 s; a synchronous `process.on("exit")` hook SIGKILLs it
  on any exit that skipped `stop()`. go-ios binds the port on all interfaces
  (it has no bind-address option), as the bench's WDA forwards already are.

  *Members.* `kind: "device"`; `target` = `{udid, name, state: "Connected",
  runtime: "iOS <ver>", deviceType: <ProductType>}`; `openMjpeg()` is an HTTP
  GET through the forward — WDA speaks real HTTP, so the body arrives bare —
  and throws if the forward has exited (nothing respawns it: restart the
  server); `h264` and `h264Pipeline()` are *H.264* below;
  `screenshot()` writes WDA's `/screenshot` (base64 PNG, sessionless) after
  checking the PNG signature.

  *H.264.* Decided at creation, after the forward is up (and after its exit
  hook, so a server stopped mid-measurement leaves no forward): the helper
  must be executable, then a GET through the forward is read until
  `parseJpegSize()` (`h264.js`) finds the first JPEG's SOF — the pixel size
  WDA sends at the current `mjpegScalingFactor`, which no table can know
  (585×1266 on the 16e at scale 0.5). `h264` is then `planCapture({source,
  scale: 1, fps})` (WDA's images arrive scaled) — 584×1266. No helper, or no
  JPEG header within the ready timeout, is `{ok: false, reason}` and MJPEG
  only, never a startup failure. `h264Pipeline()` is a second GET of the
  forwarded stream piped (Node `pipe`, so backpressure reaches WDA's socket)
  into `sim-stream-encoder --input mjpeg --source <W>x<H> --fps <N>`. The
  JPEG stream is a few MB/s, so it passes through Node (DECISIONS.md § Phase 9
  pre-flight defaults) — unlike the simulator's raw frames. The stream's end
  ends the helper's stdin and the helper exits 0; the helper's exit is the
  pipeline's one `exit`; `kill()` aborts the GET and SIGTERMs the helper
  (SIGKILL after 2 s). Throws when the plan is off or the forward has
  exited. WDA serves an MJPEG viewer and the H.264 pipeline at once.

  *Input.* `input()` runs every command through its own `SerialQueue`, like
  the simulator's. `wdaInputRequest(evt, bounds)` (pure) maps an event to one
  WDA request: `tap` / `long-press` / `swipe` → `POST /actions`, one W3C
  touch pointer in **points** (normalized × `bounds`, clamped; hold and move
  durations capped at 10 s); `type` → `/wda/keys` with the text as one value;
  `key` → `/wda/keys` with `DEVICE_KEYS` (`return`/`enter` `\n`,
  `backspace` `\b`, `tab`, `space`) — any other key, and numeric HID codes,
  throw; `button` → `DEVICE_BUTTONS` (`home` → the **sessionless**
  `/wda/homescreen`, since `pressButton home` is a silent no-op on the iOS 26
  bench; `lock`/`side-button` → `/wda/lock`), `siri` and `apple-pay` throw.
  Each request carries its own timeout: WDA answers an action only once the
  app is idle, and answers Home ~10 s late when the home screen is already in
  front (15 s allowed). `tap-label` parses the text with `tap-label.js`'s
  `parseTapTarget`, finds elements with a `predicate string` (`label == "…"`,
  or `name == "…"` for `#id` — WDA has no identifier-only attribute),
  measures each match's `/element/:id/rect` (at most 20), and
  `pickLabelTarget` keeps the on-screen ones (WDA reports an off-screen
  element — an icon on another home-screen page — with a zero rect, and its
  element click "succeeds" there): none → error, several → error unless one
  rect contains all the others, then a pointer tap at that rect's centre.
  **Wake:** before every command `GET /wda/locked`; if locked, `POST
  /wda/homescreen` (≈0.25 s; `/wda/unlock` times out on the bench) and check
  again — still locked is an error. A coordinate gesture that found the device
  locked is not dispatched (it was aimed at the lock screen) and acks
  `{detail: "unlocked"}`; text, keys, buttons and tap-by-label run after the
  wake.

  *WDA sessions.* Session-scoped calls that answer `404` / `invalid session
  id` re-create the session (re-applying the settings, which a restarted WDA
  lost) and retry once; a second failure is an error. Never a loop.
- **Remote providers** (`remote.js`, the `PROVIDERS` map). **Every hook is
  optional** — the server calls each through optional chaining, so a provider
  implements only what it needs. `lan` has just `prepare` + `start`; the
  Tailscale providers and `cloudflared` implement `stop`.
  - `prepare() → {host}` — advises a bind address before `listen`. `lan`
    advises `0.0.0.0`; the Tailscale providers and `cloudflared` advise
    `127.0.0.1` and tunnel to it (so an explicit `--host` that is not
    loopback leaves the tunnel pointing at nothing). An explicit `--host` always wins over the advice.
  - `start({port}) → {url, note}` — establishes the tunnel and returns what to
    print. `url` is the **token-free base URL** (ending in `/`): providers know
    nothing about auth, and the server appends `?token=…` itself — once for the
    owner link and once per share. Throwing here exits the process with the
    provider's message, so failures should carry an actionable one (the
    Tailscale providers parse the admin-console URL out of the CLI error and
    put it here).
  - `stop()` — teardown on shutdown. **A provider that spawns a long-lived
    process must implement it** or leak that process past exit.

  **`cloudflared`** is the worked example of a process-owning provider.
  `start` spawns `cloudflared tunnel --no-autoupdate --grace-period 1s --url
  http://127.0.0.1:<port>` and resolves only when three things have happened:
  the random `*.trycloudflare.com` hostname appeared in its output (never
  `api.trycloudflare.com`, which the same output mentions), a `Registered
  tunnel connection` line followed, and the hostname answers at
  trycloudflare.com's own nameservers. That last wait exists because the name
  reaches DNS ~2 s after registration, and a lookup that lands first is
  cached as NXDOMAIN for the zone's 60 s negative TTL; authoritative answers
  are never cached, so polling them poisons no resolver. The DNS wait is
  bounded (15 s) and never fatal — on timeout the note says to retry in a
  minute. A missing binary, an early exit or 45 s without a registered
  connection reject with an actionable message (the install command, or
  cloudflared's last output lines), and kill the child first. After start,
  both pipes are drained for the tunnel's life (a full pipe stalls it); only
  tunnel-level `ERR` lines are echoed as `[remote:cloudflared]` — per-request
  ones (`dest=` / `originService=`) fire on every closed tab and expired
  share. `stop` sends SIGTERM and escalates to SIGKILL after 1 s
  (`--grace-period` alone is not trusted: without it cloudflared waits 30 s
  for the never-ending MJPEG response). A synchronous `process.on("exit")`
  hook SIGKILLs the child on any exit that skipped `stop` — a failed start's
  `process.exit(1)`, the shutdown timer. A server killed by a signal it does
  not handle still leaks the tunnel; nothing in-process can prevent that.

  Adding a provider is one map entry; no other file changes.
- **Simulator selection** (`pickSimulator`, `backends/simulator.js`). Also
  hand-maintained: with no `--udid` it takes any already-booted device,
  otherwise walks a hardcoded preference ladder (iPhone 17 Pro non-Max → any
  iPhone 17 → any iPhone) and **throws `No iPhone simulator available`** when
  nothing matches — an iPad-only host cannot start the server at all.
  Widening platform support starts here, not in the bounds table.
- **Input events** (`axeInputArgs`'s switch, `backends/simulator.js`; the
  server's `dispatchInput` only peels off the screenshot control). Cases:
  `tap`, `tap-label`, `long-press`, `swipe`, `type`, `key`, `button`. A
  coordinate `tap` is sent to AXe with `--tap-style physical` (a touch
  down/up pair): its default style acks but lands nowhere on iOS 27
  simulators.
  `tap-label` (`{type:"tap-label", text}`) goes through the same FIFO queue as
  `axe tap --label=<text>`, or `--id=<name>` for a leading `#`, also
  `physical`. AXe does the lookup and refuses no-match and multiple-match
  itself; the server never resolves a label to coordinates, so it never
  guesses. Values are passed as `--flag=value` so a label starting with `-`
  is not parsed as a flag. The `{type:"error"}` message is AXe's `Error:`
  line minus its generic advice (`axeErrorLine`); the ack's `detail` echoes
  the target. Its queue timeout (`axeTimeoutMs`) is 15 s, not 5 s — the
  accessibility-tree read can take ~7 s while a screen is mid-transition.
  `runAxe` rejections carry AXe's raw output as `err.stderr`; a timeout or
  spawn failure has none. Unknown types throw, which surfaces as a
  `{type:"error"}` ack rather than a silent no-op — and the page toasts every
  error ack, not only those of the controls that wait for one. The device
  backend's mapping is in § Backends (*Input*). Adding an event type means
  adding a case (in every backend) and a client sender.
- **Hardware buttons.** Gated by an explicit list (`BUTTONS`: `home`, `lock`,
  `side-button`, `siri`, `apple-pay`) — not passed through to AXe
  unvalidated. `screenshot` is the server's, not the backend's.
- **Keycodes** (`KEYCODES`, `backends/simulator.js`). Name → HID code map for
  the recognized special keys.
- **Device bounds** (`boundsForDeviceType`, `backends/simulator.js`).
  Hand-maintained table mapping a simulator device type to logical points.
  **A new device model needs a new entry** — a miss here is the single most
  likely cause of "taps land in the wrong place," and it degrades silently.
  Simulator-only: the device backend measures its bounds instead.

## H.264 encoder helper (`helper/`) — the contract the server builds on

`sim-stream-encoder` is a standalone process with a written contract: the
server (both backends' `h264Pipeline()`, the parser in `h264.js`) is
built on this section, not on the Swift. § H.264 video path is what the server does
with it.

**Build.** `npm run build:helper` (= `swift build -c release --package-path
helper`) → `helper/.build/release/sim-stream-encoder`. Tests: `swift test` in
`helper/`. The binary is optional: without it, MJPEG is the whole video path.

**Command line.**

```
axe stream-video --udid <UDID> --format bgra --fps <N> --scale <S> \
  | sim-stream-encoder --source <W>x<H> [--scale <S>] [--fps <N>] [--bitrate <bps>] [--output framed|annexb]
curl -sN http://127.0.0.1:<forwarded WDA MJPEG port>/ \
  | sim-stream-encoder --input mjpeg [--source <W>x<H>] [--fps <N>] [--bitrate <bps>] [--output framed|annexb]
```

| Flag | Meaning | Default |
|---|---|---|
| `--input` | `bgra`: AXe's raw frames (below). `mjpeg`: an MJPEG body (below). | `bgra` |
| `--source WxH` | `bgra`: the simulator screen in **pixels** — read it from a screenshot's PNG header. Never from `boundsForDeviceType` (points), never hardcoded. `mjpeg`: the picture to encode at (made even); absent → the first image's size. | required for `bgra` |
| `--scale S` | `bgra` only: the **same value** passed to `axe stream-video --scale`, 0.1–1.0. Refused with `--input mjpeg` (exit 2): the images arrive scaled. | `1.0` |
| `--fps N` | The same value passed to AXe's `--fps`, 1–30. Sets the keyframe interval (one per second) and rate-control hints. | `30` |
| `--bitrate bps` | Average bit rate, ≥ 50000. | ≈ 0.08 bit/pixel/frame (≈1.9 Mbit/s at scale 0.5, ≈7.6 at 1.0) |
| `--output` | `framed` (below) for the server; `annexb` is a bare elementary stream for `ffprobe`/`ffplay`. | `framed` |

**Input: AXe's raw frames are padded, not `w×h×4`.** Frames arrive back to
back with no header. From `--source` and `--scale` the helper derives the
layout (`FrameLayout.axe`, measured on AXe 1.8.0): picture = `floor(pixels ×
scale)` per axis; each row padded to a multiple of **64 bytes**; at scale 1.0
only, the row count is padded to a multiple of 16. 1206×2622 at 0.5 → 603×1311
picture, 2432 B/row × 1311 rows = 3 188 352 B/frame; at 1.0 → 4864 B/row ×
2624 rows. A wrong `--source` or `--scale` does not error — it garbles the
picture (every row shifts), so pass exactly what AXe was given.

**Input `--input mjpeg`: JPEGs anywhere in the byte stream.** The helper
never parses multipart headers: `JpegScanner` finds an SOI (`FF D8 FF`),
walks the marker segments by their lengths to the start of scan — so an EXIF
thumbnail's own SOI/EOI inside APP1 is skipped — and scans the entropy data
for EOI (`FF D9`; stuffed `FF 00` and restart markers are skipped, any other
marker is walked as a segment). Bytes between images are discarded; an image
cut short (a new SOI where a marker belongs, a bad length, over 32 MB) is
dropped and scanning resumes. Each image is decoded with ImageIO and drawn
into the encoder's buffer: 1:1 when its size (made even) matches, losing only
an odd last column/row; scaled to fill otherwise (a rotation). An image
ImageIO cannot decode is skipped, with a stderr line on the first and every
100th.

**Encoded picture: even dimensions.** H.264 4:2:0 cannot code odd sizes, so an
odd last column/row is dropped: 603×1311 → **602×1310** (1206×2622 is already
even). Map the decoded picture onto the full device bounds; the error is under
one source pixel.

**Stream shape.** Hardware H.264, Main profile, no B-frames (decode order =
display order), real-time rate control, a keyframe (IDR) at least once a
second, and **SPS + PPS in front of every keyframe** — any keyframe is a join
point. No VUI timing: the frame rate lives in the timestamps, not the bitstream.

**Output, `--output framed`:** one record per frame —

| Offset | Size | Field |
|---|---|---|
| 0 | u32 BE | payload length N |
| 4 | u8 | flags — bit 0: keyframe (payload starts with SPS, PPS, then the IDR slice) |
| 5 | 3 | reserved, zero |
| 8 | u64 BE | presentation timestamp, µs since the first frame (arrival time — a stalled capture shows as a gap, never a speed-up) |
| 16 | N | one access unit, Annex B (`00 00 00 01` start codes) |

Records are written whole and in order; the first record is always a
keyframe. A WebCodecs `VideoDecoder` takes the payload as-is (Annex B needs
no `description`); the codec string comes from the SPS (`avc1.` + profile,
constraint, level bytes).

**stderr and exit.** One geometry line at start (`602x1310 @30fps … B/frame`),
then diagnostics only — never parse it (with `--input mjpeg` and no
`--source`, the line comes with the first image). Exit **0** on end of input (a trailing
partial frame or image is dropped) or when stdout's reader goes
away (`EPIPE`, no `SIGPIPE` death); **2** on bad arguments; **1** when
VideoToolbox cannot start or fails mid-stream. Closing its stdin — or killing
AXe — is how to stop it.

**Measured** (AXe 1.8.0, iOS 27 headless clone, scrolling Settings, framed
output): 30.3 fps at scale 0.5 (541 frames, keyframes ≤ 1.05 s apart), 30.7 fps
at 1.0; `ffprobe` decodes every frame of the unframed payload. `--input mjpeg` from the primary bench iPhone 16e (WDA
at 30 fps, scale 0.5, quality 75; 585×1266 → 584×1266): 26 fps and 1.7 Mbit/s
while swiping home-screen pages (30 fps when still), against 30 Mbit/s for the
same MJPEG; Chrome decoded 25 fps.

## H.264 video path (`h264.js`, `/video`)

**Availability is decided once, at startup.** The path exists for a run only
if the helper binary is present and the picture's pixel size could be
measured — from a screenshot on a simulator, from the first JPEG on a device
(the backend's `h264` plan). Otherwise there is no hub, `/video` answers
`404` to an authorized upgrade, and MJPEG is the whole video path — one log
line and the `video:` banner line say which. `/api/info` and the `hello` frame
carry the outcome:

```
h264: { available: true, path: "/video", width, height, fps }   // hello adds status
h264: { available: false, reason }
```

`width × height` is the decoded picture (even dimensions, § H.264 encoder
helper); it maps onto the whole screen, i.e. onto `bounds`.

**The capture plan (`planCapture`).** Size follows `--scale`; the rate is 30
fps unless `--fps` was given, in which case it is that. Values outside the
helper's ranges (fps 1–30, scale 0.1–1.0) are clamped with a log line; a value
that is not a number turns the H.264 path off rather than being guessed at.
AXe and the helper are always given the same fps and scale — the helper
derives AXe's frame layout from them.

**The pipeline (the simulator backend's `h264Pipeline()`).** Two children: AXe, and the helper with
AXe's stdout as its stdin. The descriptor is handed over and the server closes
its own copy — raw frames never pass through Node (~95 MB/s at the default
scale), and with no third holder of the pipe a dead helper gives AXe `EPIPE`
instead of a full pipe. When either child ends, the other is terminated
(`SIGTERM`, then `SIGKILL` after 2 s) and the hub is told once both are gone.

**Wire format on `/video`.** Server → viewer only; the endpoint accepts no
messages (anything over 1 KiB closes the socket with `1009`).

1. One **text** message first: `{"type":"config","codec":"avc1.4d001f",
   "width":602,"height":1310,"fps":30}`. `codec` is read from the stream's SPS
   and is what `VideoDecoder.configure()` takes; no `description` is needed.
2. Then **binary** messages, each exactly one helper record — the 16-byte
   header and its Annex B access unit, byte for byte (§ H.264 encoder helper,
   *Output*). Bit 0 of byte 4 says key or delta; bytes 8–15 are the timestamp
   in µs. The first binary message is always a keyframe.

A viewer that joins mid-stream is sent the cached group of pictures (the
latest keyframe and everything since) at once, so it decodes to the live frame
immediately instead of waiting up to a second.

**Close codes.** `1008 share expired` — final, as on `/ws`. `1011 capture
ended` — the pipeline died; reconnecting respawns it. `1013 viewer too slow` —
the viewer stopped draining. None of the hub's own closes is `1006`/`1008`, so
those keep meaning "your credential is bad". A client should treat `1011` and
`1013` as "fall back to MJPEG or retry with backoff", not as a reason to
reconnect in a tight loop: each reconnect after a death spawns a pipeline.

**Status.** `idle | live | dead`, broadcast on `/ws` as `{type:"h264",
status}`. `live` means the pipeline is running, not that a frame has arrived —
like MJPEG, there is no heartbeat: a pipeline that hangs without exiting stays
`live`.

**Bounds that hold by construction.** The parser refuses a record header that
cannot be right (length over 16 MiB, reserved bytes set) and the hub restarts
nothing on its own — the stream is marked `dead` and viewers are closed, since
a byte stream with no markers cannot be resynchronised. The group-of-pictures
cache empties itself if keyframes stop coming (150 frames / 32 MiB) rather
than grow.

## Screenshot gallery (`gallery.js`, `/gallery`)

**Where screenshots go.** The screenshot control writes
`~/Desktop/sim-stream/sim-stream-YYYY-MM-DD-HHMMSS-mmm.png` (local time; the
folder is created on first use). Screenshots from before the gallery existed
(`~/Desktop/sim-stream-*.png`) are not moved.

**Routes** (all `authCheck` + `ownerOnly`, read-only — there is no delete or
rename):

| Route | Answers |
|---|---|
| `GET /gallery` | The page: the listing newest first (mtime, then name), each a thumbnail linking to the full image. `no-store`. |
| `GET /gallery/file/:name` | The PNG, if `name` is listed; `404` otherwise. |
| `GET /gallery/thumb/:name` | A JPEG thumbnail (longest edge 360 px) from `sips`, cached as `.thumbs/<name>.jpg` and reused while newer than the original. If `sips` fails, the full PNG instead. |

**Thumbnail cache (`ThumbCache`).** Generated on first request into a temp
name and renamed into place, so a half-written file is never served;
concurrent requests for one name share one `sips` run. Thumbnails of deleted
screenshots are left behind — the folder is the owner's to tidy.

## Browser player (`public/index.html`)

**Which surface.** The page picks once, after `/api/info`: H.264 when
`h264.available`, `window.isSecureContext` and WebCodecs' `VideoDecoder` are
all present; the MJPEG `<img>` otherwise. The header label says which
(`H.264` / `MJPEG`), with the reason as its tooltip.

**One attempt, then MJPEG for good.** Every H.264 failure switches the page to
MJPEG for the rest of its life: `configure()` or `decode()` throwing, the
decoder's error callback, a record whose length disagrees with its message,
the `/video` socket closing for any reason (a refused upgrade, `1011`,
`1013`), no decoded frame within 8 s of connecting or for 4 s after the first.
There is no H.264 reconnect loop — each connect after a pipeline death
respawns AXe and the encoder. The one exception is `1008 share expired`, on
`/video` or `/ws`: final, so neither path is tried again.

**A hidden tab lets go of `/video`** and reconnects when shown (inside the
server's grace window this reuses the running pipeline and starts on its
cached keyframe). A page opened in a background tab waits until shown. This
also keeps browsers from reclaiming a background decoder, which would read as
a failure.

**Decoding.** The `config` message configures the decoder (`codec`,
`codedWidth/Height`, `optimizeForLatency`; no `description` — Annex B carries
SPS/PPS in-band). Each binary message becomes one `EncodedVideoChunk` (key
flag and µs timestamp from the header, the payload after byte 16). Deltas are
dropped until a keyframe whenever one is owed — at the start, or when the
decoder has fallen more than ~1 s behind. Frames are drawn as they are
decoded, with no pacing buffer.

**Same input on both surfaces.** The canvas and the `<img>` both fill
`#screen-wrap` (the device's aspect ratio) beneath the same `#overlay`, which
alone takes pointer events and normalizes coordinates against its own box.
The canvas is stretched (`object-fit: fill`) rather than letterboxed, so the
decoded picture — even-sized, at most a source pixel short — covers exactly
the screen the coordinates describe.

## Notable asymmetries

Deliberate, and worth knowing before "fixing" them:

- **Screenshot bypasses the input queue.** `backend.screenshot()` is `xcrun
  simctl io … screenshot`, spawned directly (with a timeout) rather than
  queued — the queue is reserved for HID input, and a screenshot must not sit
  behind a swipe. It is still async; never make it `execFileSync`. The
  screenshot *control* is also the one input event the server handles
  itself, because the gallery folder is the server's.
- **The HTML is templated exactly once.** `__ASPECT__` is replaced with the
  real aspect ratio at startup so the `<img>` reserves correct dimensions
  before `/api/info` returns, avoiding a layout flash. This is the only
  templating; don't grow it into a template engine.
- **The MJPEG response sets `X-Accel-Buffering: no` and `Connection: close`.**
  Proxies that buffer a `multipart/x-mixed-replace` body break the stream.
  Cloudflare's edge does not buffer it (measured through a quick tunnel:
  same ~7 fps and inter-frame gaps as `localhost`, first frame ~0.4–0.8 s),
  and the `/video` and `/ws` WebSockets pass through unchanged.
- **The client recovers on its own.** The WebSocket retries with exponential
  backoff from 1500 ms; close codes `1006` and `1008` are read as auth failure
  and surface a single toast rather than a retry storm. The MJPEG `<img>` is
  kicked to force a reconnect, which is what makes the server respawn AXe.
  The H.264 player is the deliberate opposite: it never reconnects after a
  failure, it falls back to MJPEG (§ Browser player). The upgrade handler rejects with a raw `401` and destroys the socket, which
  the browser surfaces as `1006`. Anything that changes how credentials are
  carried must keep `1006`/`1008` meaning
  "your credential is bad" — it is the client's only auth feedback channel.
  The one case the client does **not** retry is `1008` with the reason
  `share expired`: the cookie is dead too, so it shows "This share link has
  expired" once and stops.
- **The share clock starts at process start, not at the banner.** Tokens are
  minted while arguments are validated — before simulator boot and tunnel
  setup — so a slow boot eats into a share's lifetime. That is the safe
  direction, and the banner prints the absolute deadline, which is exact.

## Testing strategy

**`swift test`** in `helper/` covers the encoder helper's pure logic — argument
parsing, AXe's frame layout (pinned to measured frame sizes), and the output
framing. The VideoToolbox path itself is verified by piping a live AXe stream
through the binary (§ H.264 encoder helper, *Measured*).

**`npm test`** (`node --test`, no dependencies) covers the modules that need
no simulator. `mjpeg.js` — the MJPEG hub on a fake source, fake responses and
a hand-cranked timer: refcount and grace window, the generation guard against
a stopped or dead source's trailing data, what a death does to attached
clients, an `open()` that throws. `backends/queue.js` — ordering, and that a
rejected task neither stalls the queue nor leaks. `backends/simulator.js` —
the selection ladder, the bounds table, every input event's `axe` argv
(clamping, defaults, the refused names), the per-command timeouts, and the
HTTP-preamble stripper at every chunk boundary; the process plumbing around
them is checklist-only. `shares.js` — TTL and `--share` parsing, token matching,
the expiry boundary, the two-clock and latch rules, session tracking, and the
expiry timer. Anything that changes how a token is accepted or when it dies
belongs there first; expiry bugs are silent, and these tests are the only
thing that would surface one. `h264.js` — the capture plan (pinned to the
measured picture sizes), the JPEG SOF reader (past multipart headers and an
EXIF thumbnail, and at every cut before the SOF), record parsing at every possible chunk boundary, the
group-of-pictures cache, and the hub on a fake pipeline, fake viewers and a
hand-cranked clock: refcount and grace window, the generation guard, what a
joining or lagging viewer is sent, and what happens when the pipeline dies.
The hub's rules fail silently too, so a change to them belongs there first.
`gallery.js` — screenshot names, the listing (order, symlinks and dot-files
excluded), what a requested name may resolve to (traversal, encoded
separators, the thumbnail folder), the thumbnail cache (reuse, staleness,
one generation for concurrent requests, clean failure) and the page's
escaping. Serving rules fail open silently, so a change to them belongs there
first. `tap-label.js` — `#` → `--id`, trimming, dash-leading labels kept as
one `--flag=value` argument, empty/over-long input, and AXe's real no-match
and multiple-match output reduced to the toast line. `remote.js`'s
`cloudflared` provider — driven against `test/fixtures/fake-cloudflared`
(extensionless, so `node --test` never runs it), which replays cloudflared's
real banner, splits the hostname across writes and checks the exact argv:
hostname parsing (not `api.`, not a suffix match), resolving only after
registration, the ready timeout, an early exit, the missing-binary message,
SIGKILL escalation, the dead-tunnel log line and the `ERR` filter. No
network: the DNS wait is injected. `backends/device.js` — against an
in-process fake WDA (JSON API + an MJPEG server) and
`test/fixtures/fake-ios`, which checks the exact `info` / `forward` argv and
pipes its port to the fake stream: the settings mapping and clamping, role
resolution and its refusals, the one-retry session recovery (request count
pinned), identity/bounds/boundary, a bare multipart body through the forward,
screenshot, the input mapping (points, clamping, duration caps, the keys and
buttons a device has and the ones it refuses), FIFO order through the fake
WDA, the wake (a gesture spent on it, text typed after it, a device that stays
locked), tap by label (off-screen and nested matches, ambiguity, the NSPredicate
escaping), `stop()` killing the forward, a missing WDA
failing before any forward, go-ios's bind failure, a non-MJPEG listener
refused at once with the child killed, the `ios info` fallback, a
missing `ios`, and H.264 against `test/fixtures/fake-encoder` (which echoes
its argv and stdin): the plan from the first JPEG (not its thumbnail), off
without a helper or a measurable stream, the forwarded body reaching the
helper's stdin, one `exit` on `kill()` and on the stream's end, and a refusal
once the forward is gone. The helper's `swift test` covers `--input` parsing,
`JpegScanner` (a multipart body, every chunk split, byte-at-a-time, a
cut-short and an oversized image, leading garbage) and `JpegInfo.size`.

Everything else has **no automated coverage**, and the reason is structural:
every other meaningful path requires a booted iOS Simulator plus the AXe binary
on macOS (or a bench device with WDA running), so nothing here runs in CI. Verification is therefore manual and the
phase gate is a browser session:

1. `./scripts/start.sh` — confirm it selects/boots a simulator and prints a URL.
2. Open the URL — confirm the stream goes live and the header status dot is
   green.
   The address bar must show the URL **without** `token` (cookie handoff), and
   `curl -i` on the printed link must answer `302` with an `HttpOnly` cookie.
3. Exercise each input path — tap, drag-swipe, long-press, typed text, a
   special key, a hardware button, a screenshot, a tap by label (one that
   matches, and one that doesn't — AXe's message in the error toast).
4. Reload the page — confirm the AXe process is *not* restarted (grace window)
   and status recovers.
5. Narrow the viewport below 720 px — confirm the bottom sheet behaves.
6. If touching `remote.js`, verify at least the `lan` provider end-to-end from
   a second device. If touching `cloudflared`: start with `--remote
   cloudflared --share short=2m`, open the printed link at once (it must
   load — no DNS failure), confirm `/stream` runs at the `localhost` frame
   rate and `/video` at ~30 fps through the tunnel, that the share's streams
   end at its deadline (`1008 share expired`) and its link then answers
   `401`, and after Ctrl-C that `pgrep cloudflared` finds nothing.
7. If touching auth, start with a short share (`--share 30s`), open its link,
   and wait: at the deadline the page must show "This share link has expired",
   the server must log the share's expiry with the number of connections it
   closed, and reopening the link must answer `401` — including in a browser
   that still holds your own cookie.
8. If touching the H.264 path, with the helper built:
   `node scripts/video-probe.js --token <T> --seconds 5 --out /tmp/v.h264`
   must report a keyframe first, ≥25 fps and keyframes ≤ ~1 s apart, and
   `ffprobe -count_frames /tmp/v.h264` must decode every record. Without
   `--token` the probe must report `refused: 401`; with a `--share 30s` token
   and `--seconds 0` it must end with close `1008 share expired`. Two probes
   inside 5 s must log a single `[h264] spawn`. Then move the helper binary
   aside and confirm the server starts MJPEG-only and `/video` answers `404`.
9. If touching the browser player: on `localhost` the header must read
   `H.264` and taps must land and ack well inside the 5 s queue timeout; kill
   the encoder (`pkill -f 'sim-stream-encoder --source'`) and the page must
   switch to `MJPEG` once, with a single `[video] connected` in the log;
   freeze it (`pkill -STOP …`) and it must switch within ~5 s. Open the
   `--remote lan` URL (plain http) and it must show `MJPEG` from the start.
10. If touching the gallery: take a screenshot, then open **Screenshot
    gallery ↗** — the new shot is first, with a thumbnail. With a `--share`
    link the gallery link is absent and `/gallery` answers `403`;
    `curl -H 'x-token: <owner>' …/gallery/file/..%2F..%2Fx.png` must be `404`
    and an unauthenticated `…/gallery/file/%E0%A4%A.png` a plain-text `400`.
11. If touching `backends/device.js` (bench device, `qa-device up primary`
    first): `node server.js --device primary --share short=40s` — the log
    shows `[device] selected:` with the device's name and `forward ready`;
    Chrome shows the live screen with a green dot and `MJPEG`;
    `curl -H 'x-token: <T>' …/stream` for 5 s counts ≥25 fps × 5 boundaries;
    a reload logs no second `[mjpeg] open:`; from Chrome a tap, a drag-swipe
    (or ▲/▼/←/→), a long-press on a home-screen icon (context menu), pasted
    Unicode text, Backspace and Return, Home (from an app and from an open
    context menu), a tap by label that matches (`Search` on the home screen)
    and one that does not (an icon on another page → "No on-screen element
    matched"), and Siri / Esc (refused with a red toast) all behave; an
    auto-locked device logs `locked — pressing home to unlock` on the next
    input; the screenshot control saves a device-sized PNG; the share's stream
    ends at its deadline and its link is then `401`; after Ctrl-C
    `pgrep -f 'ios forward --udid='` finds nothing; and `--wda
    http://localhost:<unused>` exits at startup with `qa-device up primary`.
    With the helper built the startup log says `/video serves H.264 <W>x<H>`
    and Chrome's header reads `H.264`; `video-probe` while swiping reports
    ≥25 fps at a few Mbit/s; a `/stream` viewer beside it still runs; with
    the helper moved aside the page reads `MJPEG`.

What remains uncovered in `server.js` — `parseArgs`, the cookie handoff, the
upgrade handler — runs side effects at import. Covering it means moving it
behind an import-safe module first, as `shares.js` and `mjpeg.js` were.
