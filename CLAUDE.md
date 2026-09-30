# sim-stream — repo conventions

Node server that streams a running iOS Simulator to a browser with interactive
input, via the AXe CLI. Single surface at the repo root (no surface folders).

## Layout

```
server.js            HTTP + WebSocket + MJPEG hub + AXe command queue + auth
shares.js            Token registry — owner token + expiring --share tokens (pure, unit-tested)
test/                node:test suite (shares.js only)
remote.js            Remote-access providers (prepare/start/stop), --remote <name>
public/index.html    The entire client — markup, styles, script in one file
scripts/start.sh     Dev launcher: checks AXe, installs deps, boots the sim
helper/              Optional SwiftPM encoder: AXe raw BGRA → H.264 (contract: docs/architecture.md)
PROGRESS.md          The cursor — injected every session
docs/                PRD · ROADMAP · OVERVIEW · JOURNAL · DECISIONS · architecture · research/
```

## Build / run / test contract

There is no required build step. `npm test` covers only `shares.js` (the token
registry); the optional encoder helper has its own `swift test`; everything
else is verified by hand — see below.

```sh
npm install                                  # deps: express, ws
./scripts/start.sh                           # auto-pick a simulator, serve on :8080
./scripts/start.sh --list                    # list simulators, exit
./scripts/start.sh --udid <UDID>             # pin to one simulator
./scripts/start.sh --remote lan              # reachable on the LAN
./scripts/start.sh --share demo=2h           # also mint an expiring link
node server.js --port 9090                   # server directly; same flags
node --check server.js && node --check remote.js && node --check shares.js   # syntax gate
npm run build:helper                         # optional: build helper/ (needs swift)
(cd helper && swift test)                    # helper's argument/layout/framing tests
npm test                                     # node --test — shares.js unit tests, no simulator
```

**Beyond `npm test`, verification is manual and requires a booted simulator
plus `axe` on the host** — nothing here runs in CI. The phase gate is the browser checklist in
`docs/architecture.md` § Testing strategy: start the server, open the URL,
exercise tap / swipe / long-press / typing / a hardware button / screenshot,
reload to confirm the 5 s grace window doesn't respawn AXe, and narrow the
viewport below 720 px for the bottom sheet. If you touch `remote.js`, verify
at least the `lan` provider from a second device.

Prerequisites: macOS with Xcode simulators, Node 18+ (ESM),
`brew install cameroncooke/axe/axe`.

## Working rules

- **Before implementing:** read `docs/architecture.md` (invariants and seams —
  the FIFO command queue, the hub's refcount/generation guards, the auth checks
  on all three entry paths) and `docs/ROADMAP.md` for the phase's scope.
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
