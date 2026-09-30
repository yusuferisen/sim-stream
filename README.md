# sim-stream

Stream an iOS Simulator running on your Mac to any web browser, with
interactive input (tap, swipe, long-press, tap by accessibility label,
keyboard, hardware buttons).

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
  (a version whose `axe tap` knows `--tap-style`; 1.8.0 does)
- Node.js 18+ (uses ESM, top-level `crypto.timingSafeEqual`, `EventEmitter`)
- Device mode only (`--device`, see [Real devices](#real-devices-qa-bench)):
  [go-ios](https://github.com/danielpaulus/go-ios) (`npm i -g go-ios`) and a
  running WebDriverAgent on the device — AXe is not needed then
- Optional: the Swift toolchain that ships with Xcode, to build the H.264
  encoder helper (30 fps video in the page on https/`localhost`, and on
  `/video`). Without it the page shows MJPEG and everything else works.

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
./scripts/start.sh --device primary         # a QA-bench iPhone instead (see Real devices)
./scripts/start.sh --port 9090              # custom port
./scripts/start.sh --remote lan             # expose on the LAN
./scripts/start.sh --remote tailscale-serve # private HTTPS over your tailnet
./scripts/start.sh --remote cloudflared     # public HTTPS, no account (quick tunnel)
./scripts/start.sh --share demo=2h          # also mint a link that expires in 2h
./scripts/start.sh --no-auth                # disable token auth (local only!)
```

See [Remote access](#remote-access) for the full list of `--remote`
providers (LAN, Tailscale Serve, and two public routes: Tailscale Funnel and
an account-free Cloudflare quick tunnel).

The script will boot the selected simulator if it isn't running, then start
the web server. It prints a URL including a random auth token. Opening it
trades the token for an httpOnly cookie and redirects to the same URL without
it, so the token leaves the address bar and browser history:

```
sim-stream running
  local:     http://127.0.0.1:8080/?token=a3f9…
  token:     a3f94c...  (yours — never expires; restart to revoke)
  simulator: iPhone 17 Pro Max (3B76...)
  stream:    15fps scale=0.5 quality=75
  video:     H.264 660x1434 @30fps on /video (MJPEG on /stream)
```

The `video:` line reads `MJPEG only — …` when the optional encoder helper is
not built. `start.sh` builds it for you when `swift` is available; running
`node server.js` directly, build it once with `npm run build:helper`.

Open the URL in any browser. You should see the live simulator screen.

### Real devices (QA bench)

`--device <udid|role>` drives a real, USB-tethered iPhone or iPad instead of
a simulator, through the WebDriverAgent (WDA) already running on it. Only
prepared **QA-bench** devices — never a personal phone: the tool cannot tell
them apart, and a share link to a device exposes whatever is signed in on it.

```sh
qa-device up primary                        # bench tooling: tunnel + WDA (the tool never starts WDA)
./scripts/start.sh --device primary         # role → UDID and WDA port via qa-device
node server.js --device <UDID> --wda http://localhost:8100   # without qa-device
```

The page, links, shares and tunnels work exactly as with a simulator. The
picture is WDA's own MJPEG stream (~28 fps at the defaults), reached through
an `ios forward` the server owns and removes on exit; `--fps`/`--scale`/
`--quality` become WDA's stream settings, and `--fps` defaults to 30 here.
**For now the device is view-only** — input answers "not supported yet", and
the page shows MJPEG (H.264 from a device comes later). A WDA that does not
answer stops the server at startup with the command that fixes it.

### Share links that expire

The token above is **yours**: it works until the server process exits. To hand
someone else access, mint a separate link with a lifetime instead of sharing
your own:

```sh
./scripts/start.sh --remote tailscale-funnel --share demo=2h --share qa=30m
```

```
  share:     demo — valid 2h, until 9/30/2026, 5:42:10 PM
             https://<host>.<tailnet>.ts.net/?token=91c0…
  share:     qa — valid 30m, until 9/30/2026, 4:12:10 PM
             https://<host>.<tailnet>.ts.net/?token=5be2…
```

- `--share [label=]<ttl>` is repeatable. The TTL is a whole number plus a unit
  — `45s`, `30m`, `2h`, `1d` (max `365d`); a bare number is rejected rather
  than guessed at. Without a label the share is named `share-1`, `share-2`, ….
- Each share gets its own random token. Share links are printed on the
  `--remote` URL when there is one, otherwise on the local URL.
- The clock starts when the server process starts; the printed "until" time is
  the exact deadline.
- When a share expires it stops working on every channel at once — the link,
  the cookie it left in a browser, and the `x-token` header — and the server
  **closes the connections it had open**: the video stream ends and the page
  shows "This share link has expired". An already-open tab does not keep
  working.
- Shares live in memory only. There is no way to extend one or mint a new one
  while the server runs; **restarting the server revokes every link**, yours
  included.

### Remote access

The server binds to `127.0.0.1` by default. To reach it from another
device, pass `--remote <provider>`:

| `--remote …`        | Reachable from                              | URL shape                                |
|---------------------|---------------------------------------------|------------------------------------------|
| `lan`               | Same Wi-Fi / LAN                            | `http://<mac-ip>:8080/?token=…`          |
| `tailscale-serve`   | Any device signed in to your tailnet        | `https://<host>.<tailnet>.ts.net/?token=…` |
| `tailscale-funnel`  | **Anyone on the internet** with the URL     | `https://<host>.<tailnet>.ts.net/?token=…` |
| `cloudflared`       | **Anyone on the internet** with the URL     | `https://<random-words>.trycloudflare.com/?token=…` |

Examples:

```sh
./scripts/start.sh --remote lan
./scripts/start.sh --remote tailscale-serve
./scripts/start.sh --remote tailscale-funnel    # public — for sharing demos
./scripts/start.sh --remote cloudflared         # public — no account, no setup
```

`cloudflared` opens an anonymous Cloudflare [quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
the only prerequisite is the binary (`brew install cloudflared` — the server
exits with that command if it's missing; it never downloads anything). Each
run gets a new random hostname, printed only once the tunnel answers, and
the tunnel process is stopped with the server. Both video paths work through
it: the MJPEG stream is not buffered at Cloudflare's edge (same frame rate as
`localhost`, first frame in under a second), and since the link is https,
iPhone Safari plays the 30 fps H.264 stream. Quick tunnels come with no
uptime guarantee — if every viewer drops at once, the server logs
cloudflared's error line; restart for a fresh link.

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
For `tailscale-funnel` and `cloudflared` especially: the URL is publicly reachable; the
token is your only auth. The printed link still carries it, so share it
deliberately — and prefer handing out a [`--share`](#share-links-that-expire)
link, which dies on its own, over your own token, which doesn't. Once opened,
the browser holds the token only in an httpOnly cookie (scoped to the port;
cleared when the browser session ends, or when the share expires).

### Adding new remote providers

`remote.js` exposes a tiny provider interface — `prepare` (advise a bind
host), `start` (bring the tunnel up, return the token-free base URL; the
server appends `?token=…` itself, once per link it prints), and `stop`
(tear it down). All three are optional: implement only what you need, but a
provider that spawns a long-lived process needs `stop` or it leaks past exit
(`cloudflared` is the worked example). To add one, drop a new entry into the
`PROVIDERS` map and it becomes selectable as `--remote <name>`. No other code
changes.

## Using the UI

- **Tap** — click/tap anywhere on the simulator view
- **Swipe** — click-drag / touch-drag across the view
- **Long-press** — hold for ≥500ms without moving
- **Keyboard** — focus the text input in the controls panel, then type.
  `Enter`, `Backspace`, `Tab`, `Esc`, arrows are recognized.
- **Paste text** — use the "Paste Text" textarea to send long strings
  without keystroke-by-keystroke lag
- **Tap by label** — type an accessibility label (`Sign In`) or `#` plus an
  accessibility identifier (`#login.submit`) and press Enter or **Tap**.
  AXe finds the element; if nothing matches, or several elements do, nothing
  is tapped and AXe's message appears in the error toast. Handy for
  checking UI without hunting for pixel positions
- **Hardware buttons** — Home, Lock, Siri
- **Quick swipes** — the ▲/▼/←/→ buttons send preset swipes from the
  center of the screen
- **Screenshot** — saved to `~/Desktop/sim-stream/`, with a toast
  confirmation. **Screenshot gallery ↗** (in the same panel) opens `/gallery`,
  a newest-first thumbnail grid of that folder; click one for the full image.
  Only your own token opens it — a `--share` link can take screenshots but
  gets `403` on the gallery. Thumbnails are made with macOS's `sips` and
  cached in `~/Desktop/sim-stream/.thumbs/`. Screenshots saved by older
  versions (`~/Desktop/sim-stream-*.png`) stay where they are.

On narrow viewports (≤720px wide), the controls panel collapses into a
bottom sheet opened by a corner ⋯ button. Tap a backdrop or drag the
handle down to dismiss; Hardware/Gesture/Send-text/Tap-by-label actions
auto-close the sheet, keyboard quick-keys (Return/Back/Space/Tab) do not, so they can be
chained.

## Configuration flags

All flags can be passed to `scripts/start.sh` or to `node server.js` directly:

| Flag             | Default     | Description                                   |
|------------------|-------------|-----------------------------------------------|
| `--port <N>`     | `8080`      | HTTP port                                     |
| `--host <addr>`  | `127.0.0.1` | Bind address. Use `0.0.0.0` for LAN           |
| `--fps <N>`      | `15` / `30` | Target capture FPS, 1–30. MJPEG defaults to 15 (AXe delivers ~7–10 whatever you ask); the H.264 stream, and a device's MJPEG, default to 30. Giving the flag sets both |
| `--quality <N>`  | `75`        | JPEG quality (1–100)                          |
| `--scale <N>`    | `0.5`       | Frame size multiplier (0.1–1.0), for both video paths |
| `--udid <UDID>`  | auto        | Specific simulator UDID                       |
| `--device <udid\|role>` | —    | Drive a real bench device over WebDriverAgent instead of a simulator; `primary`/`secondary`/`tablet` resolve through `qa-device`. Excludes `--udid` |
| `--wda <url>`    | `http://localhost:8100` | WDA's URL in device mode (a role's own port when `--device` is a role) |
| `--token <str>`  | random hex  | Your own auth token — valid until the process exits. Every route and the WebSocket accept a token as `?token=…`, an `x-token` header (scripts), or the httpOnly cookie set when the page is opened. One credential is checked per request: the query if present, else the header, else the cookie |
| `--share [label=]<ttl>` | —    | Mint an extra link that expires after `<ttl>` (`45s`, `30m`, `2h`, `1d`). Repeatable. See [Share links that expire](#share-links-that-expire) |
| `--auth false`   | on          | Disable auth (local only)                     |
| `--no-auth`      | —           | Same as `--auth false` (start.sh shorthand)   |
| `--remote <p>`   | —           | Remote-access provider: `lan`, `tailscale-serve`, `tailscale-funnel`, `cloudflared` |
| `--list`         | —           | Print available simulators and exit           |

Boolean flags without values (e.g. `--foo`) are treated as `"true"`. Value
flags (listed in `VALUE_FLAGS` in `server.js`) will raise an error if the
value is missing — so `--token --port 9090` fails loudly instead of silently
treating `token` as a boolean.

## How it works

There are two independent channels between the browser and the server, plus
a third for scripts:

1. **MJPEG video stream** — `GET /stream` returns `multipart/x-mixed-replace`.
   The simulator backend spawns `axe stream-video --format mjpeg …` and the
   hub pipes its output (after stripping the leading HTTP headers AXe emits)
   to all connected clients. Browsers natively decode MJPEG inside `<img>`
   tags.

2. **WebSocket input** — `/ws` carries JSON messages from browser to
   server for every input event. The backend translates them into AXe
   commands (`tap`, `swipe`, `touch`, `type`, `key`, `button`) serialized
   through a FIFO queue. Acks come back as `{type: "ack", id}`. A
   `{type: "tap-label", text: "Sign In"}` message taps an element by its
   accessibility label (`"#login.submit"`: by identifier) — AXe finds it;
   no match or several matches come back as `{type: "error", message}`.

3. **H.264 video stream (optional)** — `/video` is a WebSocket that sends
   30 fps H.264, one frame per binary message, when the encoder helper is
   built: the server pipes `axe stream-video --format bgra` into
   `sim-stream-encoder` (VideoToolbox) and fans the result out. It uses the
   same token / cookie / header as everything else. The page plays it with
   WebCodecs into a `<canvas>` on secure contexts (https, `localhost`) and
   falls back to the MJPEG `<img>` everywhere else or on any failure; the
   header says which is live. From a script:
   `node scripts/video-probe.js --token <TOKEN> --seconds 5 --out clip.h264`.
   The message format is in `docs/architecture.md` § H.264 video path.

Server also broadcasts hub state changes (`idle` / `live` / `dead`) for both
video paths to all WS clients so the status indicator reflects reality, not
just the initial load.

Coordinates travel as normalized `(0..1, 0..1)` from the browser; the
backend maps them to simulator logical points using bounds it computes once
at startup from the device type (e.g. iPhone 17 Pro Max → 440×956).

Everything that knows what the target is — discovery, capture, input,
screenshots — lives behind one interface (`docs/architecture.md` § Backends):
`backends/simulator.js` for a simulator, `backends/device.js` for a real
device (`--device`); `server.js` is target-agnostic.

### Key files

| Path                      | Purpose                                                              |
|---------------------------|----------------------------------------------------------------------|
| `server.js`               | Node.js server: HTTP, WS endpoints, auth, wiring the hubs to the backend |
| `backends/simulator.js`   | The simulator backend: discovery/boot, bounds, AXe capture + input, `simctl` screenshots |
| `backends/device.js`      | The device backend: WDA session + settings, `ios forward` of WDA's MJPEG, bounds and screenshots from WDA |
| `test/device-backend.test.js` | Unit tests for it against a fake WDA and `test/fixtures/fake-ios` (`npm test`; no device needed) |
| `backends/queue.js`       | `SerialQueue`: the input FIFO every backend runs commands through   |
| `test/simulator-backend.test.js`, `test/queue.test.js` | Unit tests for their pure parts (`npm test`; no simulator needed) |
| `mjpeg.js`                | The MJPEG hub: refcount, grace window, generation guard, fan-out     |
| `test/mjpeg.test.js`      | Unit tests for it (`npm test`; no simulator needed)                  |
| `h264.js`                 | H.264 path logic: record parser, keyframe cache, the `/video` hub    |
| `test/h264.test.js`       | Unit tests for it (`npm test`; no simulator needed)                  |
| `scripts/video-probe.js`  | Scripted `/video` client: frame rate, close code, saves the stream   |
| `shares.js`               | The token registry: your token plus expiring share tokens            |
| `tap-label.js`            | Tap by accessibility label: `axe tap` arguments, AXe's error → one line |
| `test/tap-label.test.js`  | Unit tests for it (`npm test`; no simulator needed)                  |
| `gallery.js`              | Screenshot gallery: file names, which files may be served, thumbnails, the page |
| `test/gallery.test.js`    | Unit tests for it (`npm test`; no simulator needed)                  |
| `test/shares.test.js`     | Unit tests for the registry (`npm test`; no simulator needed)        |
| `remote.js`               | Pluggable remote-access providers (LAN / Tailscale Serve / Funnel / Cloudflare quick tunnel) |
| `test/remote.test.js`     | Unit tests for the `cloudflared` provider against a fake binary (`npm test`) |
| `public/index.html`       | Single-page client: H.264 `<canvas>` player / MJPEG `<img>`, pointer/gesture detection, toolbar |
| `scripts/start.sh`        | Dev launcher: checks AXe (not with `--device`), installs deps, builds the encoder helper, boots simulator, runs server |
| `helper/`                 | Optional Swift encoder (`npm run build:helper`): AXe raw frames → H.264; contract in `docs/architecture.md` |

## Limitations

- **MJPEG runs at ~7–10 fps.** That is the ceiling of AXe's MJPEG mode,
  whatever `--fps` asks for. The page gets 30 fps only on the H.264 path,
  which needs the encoder helper and an https or `localhost` URL — a
  plain-http `--remote lan` link always shows MJPEG.
- **`--scale 1.0` is very heavy.** At full scale AXe's MJPEG mode sends
  ~3.6 MB PNG frames — roughly 30 MB/s. Stay at the default `0.5` unless
  you're on the same machine.
- **US keyboard only.** AXe's `type` command uses HID keycodes, so
  accented / non-ASCII characters aren't supported.
- **Single-touch.** Multi-finger gestures (pinch, rotate) aren't wired up.
- **No stream heartbeat beyond start/stop.** If the AXe process hangs
  (vs. exits), the UI may stay green until something eventually throws.

## Troubleshooting

**"axe CLI not found"** — install it: `brew install cameroncooke/axe/axe`.

**"WebDriverAgent is not answering at …"** (device mode) — WDA or the bench
tunnel is down: run the printed `qa-device up <role>`. **"ios forward could
not forward port …"** — go-ios could not open the stream port; the message
carries go-ios's own words.

**Start script crashes with `EXTRA[@]: unbound variable`** — this was a
bash 3.2 bug that was fixed; make sure you're on the latest `scripts/start.sh`.

**Tap lands in the wrong place** — check that `/api/info` returns the
correct `bounds` for your device. The bounds table in
`boundsForDeviceType()` (`backends/simulator.js`) may need a new entry for a newer
device model.

**Browser shows the screen but input does nothing** — the "input" dot in
the header should be green. If it's red, the WebSocket couldn't
authenticate — reopen the printed `?token=…` link. The page itself relies
on a cookie, so a browser that blocks cookies for the host gets `401` after
the redirect.

**"This share link has expired" / a link answers `Unauthorized`** — the
`--share` lifetime ran out, or the server was restarted (every restart mints
new tokens). A link with a dead `?token=` is refused even in a browser that
still holds a valid cookie, so an expired link looks expired to you too.
Restart with a fresh `--share` to issue a new one.

**Startup says `video: MJPEG only`** — the H.264 encoder helper isn't built
(`npm run build:helper`; needs the Swift toolchain from Xcode), or the server
could not take the startup screenshot it measures the screen with. The reason
is on that line. Everything except `/video` works without it.

**Header says `MJPEG` although the helper is built** — hover it for the
reason. Plain http other than `localhost` (e.g. `--remote lan`) cannot decode
H.264 in the browser; otherwise the H.264 stream failed once (decoder error,
capture ended, no frames) and the page switched for the rest of its life —
reload to try H.264 again.

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

**`--remote cloudflared` exits with "cloudflared exited … before the tunnel
was up"** — the lines after it are cloudflared's own output. The usual causes
are no internet access, or a `~/.cloudflared/config.yml` left from a
named-tunnel setup, which can stop cloudflared from starting a quick tunnel
(move it aside for the run).
