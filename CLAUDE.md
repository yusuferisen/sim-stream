# sim-stream — repo conventions

Node server that streams a running iOS Simulator to a browser with interactive
input, via the AXe CLI. Single surface at the repo root (no surface folders).

## Layout

```
server.js            HTTP + WebSocket + MJPEG hub + AXe command queue + auth
remote.js            Remote-access providers (prepare/start/stop), --remote <name>
public/index.html    The entire client — markup, styles, script in one file
scripts/start.sh     Dev launcher: checks AXe, installs deps, boots the sim
PROGRESS.md          The cursor — injected every session
docs/                PRD · ROADMAP · OVERVIEW · JOURNAL · DECISIONS · architecture · research/
```

## Build / run / test contract

There is no build step and no automated test suite — see below.

```sh
npm install                                  # deps: express, ws
./scripts/start.sh                           # auto-pick a simulator, serve on :8080
./scripts/start.sh --list                    # list simulators, exit
./scripts/start.sh --udid <UDID>             # pin to one simulator
./scripts/start.sh --remote lan              # reachable on the LAN
node server.js --port 9090                   # server directly; same flags
node --check server.js && node --check remote.js   # syntax gate
```

**Verification is manual and requires a booted simulator plus `axe` on the
host** — nothing here runs in CI. The phase gate is the browser checklist in
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
- Keep the dependency list tiny. Zero cloud services is a product constraint,
  not an implementation detail — see `docs/PRD.md` § Principles.
- Adding a remote-access provider means one entry in `remote.js`'s `PROVIDERS`
  map and nothing else.
- A new simulator model needs an entry in `boundsForDeviceType()`; without one,
  taps mis-map silently.
