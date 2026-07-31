# Architecture — the engineering contract

> Inferred by /adopt from the codebase — verify.
>
> Timeless. Describes what **is**: modules, data flow, invariants, seams, and
> how to test. No dates, no status, no step plans — those live in
> `docs/JOURNAL.md`, `PROGRESS.md`, and `docs/ROADMAP.md` respectively.

## Shape

A single-process ESM Node server that translates browser events into AXe CLI
invocations and pipes AXe's MJPEG output back out. There is no build step, no
database, no framework beyond Express + `ws`, and no state that outlives the
process.

| Module | Responsibility |
|---|---|
| `server.js` | Everything server-side: arg parsing, simulator discovery/boot, auth, HTTP routes, WebSocket, the MJPEG hub, the AXe command queue, input translation, shutdown. |
| `remote.js` | Remote-access providers only. Exports `getRemoteProvider(name)` and `listRemoteProviders()`. Knows nothing about streaming or input. |
| `public/index.html` | The entire client — markup, styles, and script in one file. Served with one templated substitution. |
| `scripts/start.sh` | Dev launcher: verifies AXe is present, installs node deps if absent, handles `--list`, translates `--no-auth` → `--auth false`, `exec`s the server. |

## Dependencies

- **Runtime:** Node 18+ (ESM, `crypto.timingSafeEqual`, `EventEmitter`).
  Production deps are `express` and `ws` — nothing else.
- **External binaries:** `axe` (capture + HID injection) and `xcrun simctl`
  (device enumeration, boot, screenshots). Both must exist on the host; neither
  is installable in CI, which is why there is no CI.
- **Zero network services.** No cloud, no auth provider, no storage. This is a
  load-bearing property, not an accident — see `docs/DECISIONS.md`.

## Data flow

Two independent channels, deliberately not multiplexed:

1. **Video, server → browser.** `GET /stream` responds
   `multipart/x-mixed-replace; boundary=--mjpegstream` and registers the
   response with the `MjpegHub`. The hub spawns
   `axe stream-video --format mjpeg`, strips the leading HTTP headers AXe
   emits before the first part, and writes every subsequent chunk to all
   registered responses. The browser decodes it natively in an `<img>`.
2. **Input, browser → server.** `WS /ws` carries JSON events. Each is parsed,
   passed to `dispatchInput()`, and acked as `{type:"ack", id}` or
   `{type:"error", id, message}`.

Out-of-band on the same WebSocket: a `{type:"hello", simulator, bounds, stream}`
frame on connect, and `{type:"stream", status}` broadcasts whenever the hub's
status changes.

## Invariants

These are the properties the code maintains; breaking one is a regression even
if nothing throws.

- **One AXe input command at a time.** `CommandQueue` is a strict FIFO with a
  `running` flag. Concurrent taps must never reach AXe in parallel — ordering
  is the whole point.
- **The capture process is refcounted, with a grace window.** `MjpegHub` spawns
  on the first client and stops 5 s (`graceMs`) after the last one leaves.
  Page reloads are a leave-then-join inside that window and must not restart
  AXe.
- **Only the current generation may act on exit.** Each spawn bumps
  `generation`; the exit handler compares before reacting. Without this, a
  dying old process tears down its replacement.
- **Status is broadcast, never inferred.** `idle | live | dead` transitions
  emit to every WebSocket client, so a viewer that connected while the stream
  was dead learns when it recovers. The client must not derive status from
  page-load state.
- **Coordinates are normalized on the wire.** The browser sends `(0..1, 0..1)`;
  only the server knows logical points. `dispatchInput`'s `pt()` clamps to
  `[0,1]` before scaling by `bounds`, so a malformed or out-of-range event
  cannot produce an off-screen coordinate.
- **Auth is checked on all three entry paths.** HTTP routes via the `authCheck`
  middleware, the WebSocket at `server.on("upgrade")` before
  `handleUpgrade`, and `/stream` through the same middleware. A new entry point
  without a check is a hole.
- **Token comparison is constant-time.** `tokenMatches()` uses
  `crypto.timingSafeEqual` on equal-length buffers. Never replace it with `===`.
- **Value flags fail loudly.** Flags in `VALUE_FLAGS` raise if their value is
  missing, so `--token --port 9090` errors instead of silently treating
  `token` as the boolean `true`.

## Seams

Places designed to be extended, and the contract each one implies.

- **Remote providers** (`remote.js`, the `PROVIDERS` map). A provider is an
  object with `prepare` / `start` / `stop` and may advise a bind host — `lan`
  advises `0.0.0.0`, the Tailscale providers advise `127.0.0.1` and tunnel to
  it. An explicit `--host` always wins over a provider's advice. Adding a
  provider is one map entry; no other file changes.
- **Input events** (`dispatchInput`'s switch). Cases: `tap`, `long-press`,
  `swipe`, `type`, `key`, `button`. Unknown types throw, which surfaces as a
  `{type:"error"}` ack rather than a silent no-op. Adding an event type means
  adding a case and a client sender.
- **Hardware buttons.** Gated by an explicit `allowed` list
  (`home`, `lock`, `side-button`, `siri`, `apple-pay`, `screenshot`) — not
  passed through to AXe unvalidated.
- **Keycodes** (`KEYCODES`). Name → HID code map for the recognized special
  keys.
- **Device bounds** (`boundsForDeviceType`). Hand-maintained table mapping a
  simulator device type to logical points. **A new device model needs a new
  entry** — a miss here is the single most likely cause of "taps land in the
  wrong place," and it degrades silently.

## Notable asymmetries

Deliberate, and worth knowing before "fixing" them:

- **Screenshot bypasses the AXe queue.** It's `xcrun simctl io … screenshot`,
  spawned directly (with a timeout) rather than queued — the queue is reserved
  for HID input, and a screenshot must not sit behind a swipe. It is still
  async; never make it `execFileSync`.
- **The HTML is templated exactly once.** `__ASPECT__` is replaced with the
  real aspect ratio at startup so the `<img>` reserves correct dimensions
  before `/api/info` returns, avoiding a layout flash. This is the only
  templating; don't grow it into a template engine.
- **The MJPEG response sets `X-Accel-Buffering: no` and `Connection: close`.**
  Proxies that buffer a `multipart/x-mixed-replace` body break the stream —
  relevant to any future CDN-fronted provider.

## Testing strategy

There is **no automated test suite**, and the reason is structural: every
meaningful path requires a booted iOS Simulator plus the AXe binary on macOS,
so nothing here runs in CI. Verification is therefore manual and the phase gate
is a browser session:

1. `./scripts/start.sh` — confirm it selects/boots a simulator and prints a URL.
2. Open the URL — confirm the stream goes live and the header status dot is
   green.
3. Exercise each input path — tap, drag-swipe, long-press, typed text, a
   special key, a hardware button, a screenshot.
4. Reload the page — confirm the AXe process is *not* restarted (grace window)
   and status recovers.
5. Narrow the viewport below 720 px — confirm the bottom sheet behaves.
6. If touching `remote.js`, verify at least the `lan` provider end-to-end from
   a second device.

Anything that *can* be unit-tested without a simulator — `parseArgs`,
`tokenMatches`, `pt()` clamping, `boundsForDeviceType`, provider selection — is
worth covering the moment a test runner is introduced, and a phase that changes
those is a reasonable place to introduce one.
