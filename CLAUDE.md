# sim-stream — repo conventions

Node server that streams a running iOS Simulator (via the AXe CLI) — or, with
`--device`, a QA-bench iPhone/iPad (via WebDriverAgent) — to a browser with
interactive input. Single surface at the repo root (no surface folders).

## Layout

```
server.js            HTTP + WebSocket + auth — target-agnostic; talks to one backend
backends/simulator.js  The simulator backend: discovery/boot, bounds, AXe capture + input, simctl screenshots
backends/device.js   The device backend (--device): WDA session + settings, owned `ios forward` of WDA's MJPEG, WDA bounds/screenshots
backends/queue.js    SerialQueue — the input FIFO every backend runs commands through (pure, unit-tested)
mjpeg.js             The MJPEG hub — refcount, grace window, generation guard (pure, unit-tested)
shares.js            Token registry — owner token + expiring --share tokens (pure, unit-tested)
h264.js              H.264 path logic — record parser, GOP cache, the /video hub (pure, unit-tested)
tap-label.js         Tap by accessibility label — axe tap args + AXe error → toast line (pure, unit-tested)
gallery.js           Screenshot gallery rules — names, listing-matched serving, thumbnail cache, page (unit-tested)
test/                node:test suites for the import-safe modules (shares, h264, mjpeg, gallery, tap-label, remote, queue, simulator + device backends); fixtures/ holds fake cloudflared, fake ios + fake encoder
remote.js            Remote-access providers (prepare/start/stop), --remote <name>
public/index.html    The entire client — markup, styles, script in one file
scripts/start.sh     Dev launcher: checks AXe, installs deps, builds the helper, boots the sim
scripts/video-probe.js  Scripted /video client — the H.264 path's verification tool
helper/              Optional SwiftPM encoder: AXe raw BGRA or a device's MJPEG → H.264 (contract: docs/architecture.md)
PROGRESS.md          The cursor — injected every session
docs/                PRD · ROADMAP · OVERVIEW · JOURNAL · DECISIONS · architecture · research/
```

## Build / run / test contract

There is no required build step. `npm test` covers only the import-safe modules —
`shares.js` (the token registry), `h264.js` and `mjpeg.js` (the two hubs'
logic), `gallery.js` (the screenshot gallery's serving rules), `tap-label.js`
(tap-by-label arguments and error text), `backends/queue.js` and the pure
parts of `backends/simulator.js` (selection, bounds, input → `axe` argv),
`backends/device.js` against a fake WDA + fake `ios` (startup, forward,
session retry, refusals); the
optional encoder helper has its own `swift test`; everything else — every
process the backend spawns — is verified by hand — see below.

```sh
npm install                                  # deps: express, ws
./scripts/start.sh                           # auto-pick a simulator, serve on :8080
./scripts/start.sh --list                    # list simulators, exit
./scripts/start.sh --udid <UDID>             # pin to one simulator
./scripts/start.sh --remote lan              # reachable on the LAN
./scripts/start.sh --share demo=2h           # also mint an expiring link
./scripts/start.sh --device primary          # a QA-bench device over WDA (qa-device up primary first)
node server.js --port 9090                   # server directly; same flags
for f in server.js remote.js shares.js h264.js mjpeg.js gallery.js tap-label.js backends/*.js; do node --check $f; done   # syntax gate
npm run build:helper                         # optional: build helper/ (needs swift)
(cd helper && swift test)                    # helper's argument/layout/framing tests
npm test                                     # node --test — the import-safe modules' unit tests, no simulator
node scripts/video-probe.js --token <T>      # against a running server: 5 s of /video, fps + close code
```

**Beyond `npm test`, verification is manual and requires a booted simulator
plus `axe` on the host** — nothing here runs in CI. The phase gate is the browser checklist in
`docs/architecture.md` § Testing strategy: start the server, open the URL,
exercise tap / swipe / long-press / typing / a hardware button / screenshot /
tap by label,
reload to confirm the 5 s grace window doesn't respawn AXe, and narrow the
viewport below 720 px for the bottom sheet. If you touch `remote.js`, verify
at least the `lan` provider from a second device. If you touch the H.264 path
(`h264.js`, either backend's pipeline, `helper/`), run that
section's `video-probe` step too. If you touch `backends/device.js`, run the
checklist's device step against the **primary bench device** (never a
personal phone).

Prerequisites: macOS with Xcode simulators, Node 18+ (ESM),
`brew install cameroncooke/axe/axe`. Device mode: go-ios (`npm i -g go-ios`)
and the bench's WDA (`qa-device up <role>`).

## Working rules

- **Before implementing:** read `docs/architecture.md` (invariants and seams —
  the FIFO command queue, the hubs' refcount/generation guards, the auth checks
  on every entry path) and `docs/ROADMAP.md` for the phase's scope.
- **After implementing:** keep `docs/` in sync — behavior or module shape
  changes go to `docs/OVERVIEW.md` and the affected `docs/architecture.md`
  sections; per-phase narrative appends to `docs/JOURNAL.md`; new choices go to
  `docs/DECISIONS.md`.
- **No status or changelog sections in this file or `README.md`.** Completion
  truth lives only in `PROGRESS.md`; history only in `docs/JOURNAL.md`.
- Keep the dependency list tiny. Nothing hosted may be *required* to install,
  start, or use the tool — that's a product constraint, not an implementation
  detail. Opt-in `--remote` providers are the deliberate exception; the default
  path stays offline-capable. See `docs/PRD.md` § Principles.
- Adding a remote-access provider means one entry in `remote.js`'s `PROVIDERS`
  map and nothing else. All three hooks (`prepare` / `start` / `stop`) are
  optional — but a provider that spawns a tunnel process must implement `stop`
  or leak it past exit.
- A new simulator model needs an entry in `boundsForDeviceType()`
  (`backends/simulator.js`); without one, taps mis-map silently.
- Nothing outside `backends/` spawns `axe`, `simctl` or `ios`, or talks to WDA. `server.js`, the hubs
  and the routes see only the backend interface (`docs/architecture.md`
  § Backends); a new target is a new module with that shape plus its flag.
