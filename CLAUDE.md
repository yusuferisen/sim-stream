# sim-stream — repo conventions

Node server that streams a running iOS Simulator to a browser with interactive
input, via the AXe CLI. Single surface at the repo root (no surface folders).

## Layout

```
server.js            HTTP + WebSocket + MJPEG hub + AXe command queue + auth
shares.js            Token registry — owner token + expiring --share tokens (pure, unit-tested)
h264.js              H.264 path logic — record parser, GOP cache, the /video hub (pure, unit-tested)
tap-label.js         Tap by accessibility label — axe tap args + AXe error → toast line (pure, unit-tested)
gallery.js           Screenshot gallery rules — names, listing-matched serving, thumbnail cache, page (unit-tested)
test/                node:test suites for the import-safe modules (shares.js, h264.js, gallery.js, tap-label.js)
remote.js            Remote-access providers (prepare/start/stop), --remote <name>
public/index.html    The entire client — markup, styles, script in one file
scripts/start.sh     Dev launcher: checks AXe, installs deps, builds the helper, boots the sim
scripts/video-probe.js  Scripted /video client — the H.264 path's verification tool
helper/              Optional SwiftPM encoder: AXe raw BGRA → H.264 (contract: docs/architecture.md)
PROGRESS.md          The cursor — injected every session
docs/                PRD · ROADMAP · OVERVIEW · JOURNAL · DECISIONS · architecture · research/
```

## Build / run / test contract

There is no required build step. `npm test` covers only the import-safe modules —
`shares.js` (the token registry), `h264.js` (the H.264 hub's logic),
`gallery.js` (the screenshot gallery's serving rules) and `tap-label.js`
(tap-by-label arguments and error text); the
optional encoder helper has its own `swift test`; everything else is verified
by hand — see below.

```sh
npm install                                  # deps: express, ws
./scripts/start.sh                           # auto-pick a simulator, serve on :8080
./scripts/start.sh --list                    # list simulators, exit
./scripts/start.sh --udid <UDID>             # pin to one simulator
./scripts/start.sh --remote lan              # reachable on the LAN
./scripts/start.sh --share demo=2h           # also mint an expiring link
node server.js --port 9090                   # server directly; same flags
for f in server.js remote.js shares.js h264.js gallery.js tap-label.js; do node --check $f; done   # syntax gate
npm run build:helper                         # optional: build helper/ (needs swift)
(cd helper && swift test)                    # helper's argument/layout/framing tests
npm test                                     # node --test — shares/h264/gallery/tap-label unit tests, no simulator
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
(`h264.js`, the pipeline in `server.js`, `helper/`), run that section's
`video-probe` step too.

Prerequisites: macOS with Xcode simulators, Node 18+ (ESM),
`brew install cameroncooke/axe/axe`.

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
- A new simulator model needs an entry in `boundsForDeviceType()`; without one,
  taps mis-map silently.
