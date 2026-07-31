# sim-stream

Stream an iOS Simulator running on your Mac to any web browser, with
interactive input (tap, swipe, long-press, keyboard, hardware buttons).

Built for one use case: you run the simulator on a Mac (e.g. a Mac Mini at
your desk), and you want to test iOS apps remotely from a laptop, phone, or
tablet — especially handy when an agent just built a feature and you don't
have an iPhone nearby.

```
┌─────────────┐      HTTPS + WebSocket       ┌──────────────────────┐
│  Browser    │ ◀──────────────────────────▶ │  Mac Mini            │
│  (any dev)  │                              │  ┌────────────────┐  │
└─────────────┘                              │  │ Node server    │  │
                                             │  │ (this repo)    │  │
                                             │  └───────┬────────┘  │
                                             │          │ spawn     │
                                             │          ▼           │
                                             │  ┌────────────────┐  │
                                             │  │ AXe CLI        │  │
                                             │  │ (stream + HID) │  │
                                             │  └───────┬────────┘  │
                                             │          ▼           │
                                             │  ┌────────────────┐  │
                                             │  │ iOS Simulator  │  │
                                             │  └────────────────┘  │
                                             └──────────────────────┘
```

Status and what's planned: see [`PROGRESS.md`](PROGRESS.md). Architecture,
decisions, and history live in [`docs/`](docs/).

## Requirements

- macOS with Xcode + iOS Simulator installed (`xcrun simctl` available)
- [AXe CLI](https://github.com/cameroncooke/AXe) — `brew install cameroncooke/axe/axe`
- Node.js 18+ (uses ESM, top-level `crypto.timingSafeEqual`, `EventEmitter`)

## Install

```sh
git clone <this-repo> sim-stream
cd sim-stream
npm install
```

## Run

```sh
./scripts/start.sh                          # auto-pick a simulator, start on :8080
./scripts/start.sh --list                   # list available simulators
./scripts/start.sh --udid <UDID>            # pin to a specific simulator
./scripts/start.sh --port 9090              # custom port
./scripts/start.sh --remote lan             # expose on the LAN
./scripts/start.sh --remote tailscale-serve # private HTTPS over your tailnet
./scripts/start.sh --no-auth                # disable token auth (local only!)
```

See [Remote access](#remote-access) for the full list of `--remote`
providers (LAN, Tailscale Serve, Tailscale Funnel for public sharing).

The script will boot the selected simulator if it isn't running, then start
the web server. It prints a URL including a random auth token:

```
sim-stream running
  local:     http://127.0.0.1:8080/?token=a3f9…
  token:     a3f94c...
  simulator: iPhone 17 Pro Max (3B76...)
  stream:    15fps scale=0.5 quality=75
```

Open the URL in any browser. You should see the live simulator screen.

### Remote access

The server binds to `127.0.0.1` by default. To reach it from another
device, pass `--remote <provider>`:

| `--remote …`        | Reachable from                              | URL shape                                |
|---------------------|---------------------------------------------|------------------------------------------|
| `lan`               | Same Wi-Fi / LAN                            | `http://<mac-ip>:8080/?token=…`          |
| `tailscale-serve`   | Any device signed in to your tailnet        | `https://<host>.<tailnet>.ts.net/?token=…` |
| `tailscale-funnel`  | **Anyone on the internet** with the URL     | `https://<host>.<tailnet>.ts.net/?token=…` |

Examples:

```sh
./scripts/start.sh --remote lan
./scripts/start.sh --remote tailscale-serve
./scripts/start.sh --remote tailscale-funnel    # public — for sharing demos
```

Tailscale prerequisites (one-time, in the [admin
console](https://login.tailscale.com/admin)):

- **HTTPS Certificates** must be enabled (DNS → HTTPS Certificates).
- **Serve** must be enabled for your tailnet. The first failed call
  prints an admin-console URL — clicking it enables Serve in one step.
- For `tailscale-funnel`: Funnel must also be enabled the same way, and
  the device needs the `funnel` node attribute in your ACL (Access
  Controls → `nodeAttrs`).

On macOS, the App Store and standalone-installer Tailscale builds route
serve/funnel through the GUI app. If you're running headless on a Mac
Mini, `brew install tailscale` (which ships a non-sandboxed `tailscaled`)
is more reliable for scripted use.

The `lan` provider is just a convenience for `--host 0.0.0.0`. You can
still pass `--host` directly if you need full control.

Keep the token secret — it's the only thing gating access when exposed.
For `tailscale-funnel` especially: the URL is publicly reachable; the
token is your only auth.

### Adding new remote providers

`remote.js` exposes a tiny provider interface (`prepare` / `start` /
`stop`). To add e.g. a Cloudflare quick tunnel, drop a new entry into the
`PROVIDERS` map and it becomes selectable as `--remote <name>`. No other
code changes.

## Using the UI

- **Tap** — click/tap anywhere on the simulator view
- **Swipe** — click-drag / touch-drag across the view
- **Long-press** — hold for ≥500ms without moving
- **Keyboard** — focus the text input in the controls panel, then type.
  `Enter`, `Backspace`, `Tab`, `Esc`, arrows are recognized.
- **Paste text** — use the "Paste Text" textarea to send long strings
  without keystroke-by-keystroke lag
- **Hardware buttons** — Home, Lock, Siri
- **Quick swipes** — the ▲/▼/←/→ buttons send preset swipes from the
  center of the screen
- **Screenshot** — saved to `~/Desktop/sim-stream-<timestamp>.png`, with a
  toast confirmation

On narrow viewports (≤720px wide), the controls panel collapses into a
bottom sheet opened by a corner ⋯ button. Tap a backdrop or drag the
handle down to dismiss; Hardware/Gesture/Send-text actions auto-close the
sheet, keyboard quick-keys (Return/Back/Space/Tab) do not, so they can be
chained.

## Configuration flags

All flags can be passed to `scripts/start.sh` or to `node server.js` directly:

| Flag             | Default     | Description                                   |
|------------------|-------------|-----------------------------------------------|
| `--port <N>`     | `8080`      | HTTP port                                     |
| `--host <addr>`  | `127.0.0.1` | Bind address. Use `0.0.0.0` for LAN           |
| `--fps <N>`      | `15`        | Target capture FPS (1–30; AXe caps ~7–10)     |
| `--quality <N>`  | `75`        | JPEG quality (1–100)                          |
| `--scale <N>`    | `0.5`       | Frame size multiplier (0.1–1.0)               |
| `--udid <UDID>`  | auto        | Specific simulator UDID                       |
| `--token <str>`  | random hex  | Auth token (also accepted as `?token=…`)      |
| `--auth false`   | on          | Disable auth (local only)                     |
| `--no-auth`      | —           | Same as `--auth false` (start.sh shorthand)   |
| `--remote <p>`   | —           | Remote-access provider: `lan`, `tailscale-serve`, `tailscale-funnel` |
| `--list`         | —           | Print available simulators and exit           |

Boolean flags without values (e.g. `--foo`) are treated as `"true"`. Value
flags (listed in `VALUE_FLAGS` in `server.js`) will raise an error if the
value is missing — so `--token --port 9090` fails loudly instead of silently
treating `token` as a boolean.

## How it works

There are two independent channels between the browser and the server:

1. **MJPEG video stream** — `GET /stream` returns `multipart/x-mixed-replace`.
   The server spawns `axe stream-video --format mjpeg …` and pipes its
   stdout (after stripping the leading HTTP headers AXe emits) to all
   connected clients. Browsers natively decode MJPEG inside `<img>` tags.

2. **WebSocket input** — `/ws` carries JSON messages from browser to
   server for every input event. The server translates them into AXe
   commands (`tap`, `swipe`, `touch`, `type`, `key`, `button`) serialized
   through a FIFO queue. Acks come back as `{type: "ack", id}`.

Server also broadcasts MJPEG hub state changes (`idle` / `live` / `dead`)
to all WS clients so the status indicator reflects reality, not just the
initial load.

Coordinates travel as normalized `(0..1, 0..1)` from the browser; the
server maps them to simulator logical points using bounds it computes once
at startup from the device type (e.g. iPhone 17 Pro Max → 440×956).

### Key files

| Path                      | Purpose                                                              |
|---------------------------|----------------------------------------------------------------------|
| `server.js`               | Node.js server: HTTP, WS, MJPEG hub, AXe command queue, auth         |
| `remote.js`               | Pluggable remote-access providers (LAN / Tailscale Serve / Funnel)   |
| `public/index.html`       | Single-page client: MJPEG `<img>`, pointer/gesture detection, toolbar |
| `scripts/start.sh`        | Dev launcher: checks AXe, installs deps, boots simulator, runs server |

## Limitations

- **Capture rate caps at ~7–10 fps.** AXe's `stream-video` is
  screenshot-based. For smoother video you'd need a ScreenCaptureKit +
  VideoToolbox pipeline feeding WebRTC — out of scope here.
- **US keyboard only.** AXe's `type` command uses HID keycodes, so
  accented / non-ASCII characters aren't supported.
- **Single-touch.** Multi-finger gestures (pinch, rotate) aren't wired up.
- **No stream heartbeat beyond start/stop.** If the AXe process hangs
  (vs. exits), the UI may stay green until something eventually throws.

## Troubleshooting

**"axe CLI not found"** — install it: `brew install cameroncooke/axe/axe`.

**Start script crashes with `EXTRA[@]: unbound variable`** — this was a
bash 3.2 bug that was fixed; make sure you're on the latest `scripts/start.sh`.

**Tap lands in the wrong place** — check that `/api/info` returns the
correct `bounds` for your device. The bounds table in
`boundsForDeviceType()` (server.js) may need a new entry for a newer
device model.

**Browser shows the screen but input does nothing** — the "input" dot in
the header should be green. If it's red, the WebSocket couldn't
authenticate — check the token in your URL.

**Stream freezes after a while** — the underlying AXe process likely
crashed. Reload the page; the server will respawn it on the next connect.

**`--remote tailscale-*` exits with "Serve/Funnel is not enabled on your
tailnet"** — one-time setup. The error message includes a direct admin
link (`https://login.tailscale.com/f/serve?node=…` or `…/funnel?…`);
click it once to enable. For Funnel you also need to add the `funnel`
node attribute in Access Controls → `nodeAttrs`.

**`--remote tailscale-funnel` takes ~30s to fail then exits** — the App
Store / standalone-installer Tailscale CLI on macOS hangs talking to its
GUI agent in some cases. The 30s is our timeout firing; the captured
error message is still correct. For headless / scripted use, prefer
`brew install tailscale` (non-sandboxed `tailscaled`).
