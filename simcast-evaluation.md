# SimCast Evaluation: Build vs. Adopt

> Evaluation of [github.com/simcast-dev/simcast](https://github.com/simcast-dev/simcast) against this project (`sim-stream`) — does an off-the-shelf alternative justify retiring our home-rolled simulator-streaming stack? Also captures the practical recipe for reaching `sim-stream` from an iPhone on the same Wi-Fi, since that came up first and is the workflow being preserved. **Recommendation: keep `sim-stream`.** Reasoning, trade-offs, and conditions under which to revisit are documented below.

## Table of Contents
- [Recommendation](#recommendation)
- [Reaching sim-stream from a phone on the LAN](#reaching-sim-stream-from-a-phone-on-the-lan)
- [What SimCast actually is](#what-simcast-actually-is)
- [Side-by-side comparison](#side-by-side-comparison)
- [Why we keep our own](#why-we-keep-our-own)
- [What's worth stealing from SimCast](#whats-worth-stealing-from-simcast)
- [When to revisit](#when-to-revisit)
- [Repo health snapshot](#repo-health-snapshot)
- [Open Questions](#open-questions)

## Recommendation

Keep `sim-stream`. The user's wedge — "open a URL on an iPhone or laptop and verify what an agent just built" — is served better by a single 550-line Node server with token-URL sharing than by SimCast's two-app, four-cloud-service architecture. The one genuinely better thing in SimCast (60 fps WebRTC vs. our ~7–10 fps MJPEG) is a discrete upgrade we can borrow from later if framerate becomes a blocker; it does not require re-platforming onto Supabase + LiveKit.

## Reaching sim-stream from a phone on the LAN

`sim-stream` defaults to binding to `127.0.0.1`. To reach it from another device on the same Wi-Fi, bind to all interfaces.

```sh
HOST=0.0.0.0 node /Users/ysf/Developer/sim-stream/server.js --token sim-stream-lan
# or, equivalently
./scripts/start.sh --remote lan
```

On startup it prints the URL and the token. The phone hits the Mac's LAN IP, not `localhost`:

```
http://<mac-lan-ip>:8080/?token=<token>
```

The Mac's LAN IP can be read via `ipconfig getifaddr en0` (Wi-Fi) or `en1`. The token is always required unless `--no-auth` is passed.

**Failure modes seen:**
- macOS firewall can drop inbound `:8080`. Check **System Settings → Network → Firewall**; either disable it or allow inbound for `node`.
- `[ws] connected / disconnected` pairs in the server log are normal — the page reconnects on focus changes and on reload.
- If the server received a SIGINT/SIGTERM from the parent shell, it logs `[shutdown] cleaning up...` and exits. Run it detached (`nohup ... &` + `disown`) if it must survive the launching shell.

## What SimCast actually is

Two-process system bridged through cloud services. Reads as a "platform" architecture rather than a "tool" architecture.

### Capture pipeline
- **ScreenCaptureKit** captures individual Simulator windows (not the whole display).
- **VideoToolbox** hardware-encodes to H.264 at **8 Mbps / 60 fps target**.
- **LiveKit** transports video over WebRTC. The web dashboard is a LiveKit viewer.

### Control plane
- Per-user **Supabase Realtime** channel `user:{userId}`.
- Web → mac: `command` broadcast envelope.
- Mac → web: `command_ack` (received/rejected), `command_result` (success/failure), `log` (per-UDID).
- **Presence** is the source of truth for simulator inventory and `streaming_udids[]`. Web never treats "command sent" as success; it waits for presence to confirm.

### Persistence
- **Supabase Postgres + Storage** is used *only* for screenshot and recording gallery.
- Each capture inserts a row as `pending`, uploads to Storage, then updates to `ready` or `failed`.
- Web subscribes to `INSERT` + `UPDATE` and renders placeholders during pending state.

### Input layer
- **Same** `axe` CLI we use, plus `simctl`. Input parity is a wash — they don't have something we don't.
- They additionally expose **tap-by-accessibility-label** (a UI feature on top of axe), push notifications, and deep-link opening.

### Components
| Path | Purpose |
|---|---|
| `apps/macos/simcast/` | SwiftUI macOS app (publisher + operator console) |
| `apps/macos/simcast/Stream/` | `Managers`, `Models`, `Receivers`, `Services`, `Views` |
| `apps/macos/simcast/Sync/` | Realtime/presence wiring |
| `apps/web/` | Next.js 16 dashboard + LiveKit viewer |
| `apps/supabase/migrations/` | 2 SQL migrations (media tables + storage/realtime policies) |
| `apps/supabase/functions/livekit-token/` | Edge function that derives LiveKit room from `user + udid` |

### Required cloud setup (before first frame)
1. Create a Supabase project; note URL + anon key.
2. Create a LiveKit Cloud project; note URL + API key + API secret.
3. Create a shared Supabase user used by both macOS and web.
4. Run two SQL migrations in the Supabase SQL editor.
5. Deploy the `livekit-token` edge function with three secrets.
6. Disable "Verify JWT with legacy secret" on the function.
7. Deploy `apps/web` to Vercel (or self-host) with two env vars.
8. Add the deployed app URL to Supabase Auth → Redirect URLs.
9. Sign into the macOS app and the web dashboard with the same account.

## Side-by-side comparison

| | `sim-stream` (this repo) | `simcast` |
|---|---|---|
| Video transport | MJPEG over HTTP `multipart/x-mixed-replace` | WebRTC (LiveKit) |
| Codec | JPEG, scaled | H.264, VideoToolbox, ~8 Mbps |
| Framerate (real) | ~7–10 fps (axe screenshot loop) | 60 fps target |
| Footprint | ~550-line `server.js` + static HTML + `remote.js` | SwiftUI app + Next.js app + edge function + 2 SQL migrations |
| Cloud deps | None | Supabase + LiveKit Cloud (free tiers, but required) |
| Auth model | Random token in URL | Supabase auth; mac and web must share a user |
| Sharing with external viewer | Tailscale Funnel + token URL | Not designed for it — auth is per-Supabase-user |
| Multi-simulator | No | Yes |
| Multi-touch | No (single touch) | Not explicitly advertised |
| Screenshot output | Saves to `~/Desktop/sim-stream-<ts>.png` | Persisted gallery with `pending → ready/failed` lifecycle |
| Recording | No | Yes (gallery) |
| Tap by a11y label | No | Yes |
| Push notifications / deep links | No | Yes |
| Input backend | `axe` CLI | `axe` CLI + `simctl` |
| Time to first frame from clean clone | `npm i && brew install axe && node server.js` | Multi-hour cloud bring-up (see list above) |
| Offline / air-gapped | Yes | No |
| Repo age | Older, working | Created 2026-03-03, last push 2026-04-21 |
| Stars / watchers / forks | n/a | 3 / 0 / 2 |

## Why we keep our own

Ordered by weight.

### 1. The auth model doesn't fit the workflow.
The product loop is "open a URL on a phone, agent built X, verify X." We already had this working five minutes into the conversation by binding to `0.0.0.0` and pasting `http://<lan-ip>:8080/?token=…` into Mobile Safari. SimCast's `user:{userId}` realtime channel is keyed to a single Supabase auth user — both ends must sign in with the same account. There is **no token-URL share story**. The previously-built Tailscale Funnel flow (send a public URL to someone outside your tailnet) has no equivalent in their model without inviting that person into your Supabase project.

### 2. Bring-up cost is multi-hour, vs. seconds.
Even to demo SimCast locally you need a Supabase project, two SQL migrations applied by hand, an edge function deployed with three secrets, a LiveKit Cloud project, a Vercel deploy (or local Next dev), and matching auth on both ends. `sim-stream` is `npm i && node server.js`.

### 3. Vendor coupling.
SimCast hard-binds to Supabase (auth + realtime + Postgres + storage + edge functions) and LiveKit Cloud (video transport + room model + token edge function). Both have free tiers, but the architecture is built on their primitives — you can't trivially swap either out. `sim-stream` has zero external services.

### 4. Repo health signal is weak.
3 ⭐ / 0 watchers / 2 forks / ~7 weeks old. Actively maintained (last push a week before evaluation), but tiny audience and clearly still iterating: their own CLAUDE.md flags "compatibility fallback" because the schema is still moving. Adopting now means eating their breaking changes for the foreseeable future without much community to share the load.

### 5. The genuine advantage is severable.
Their one real win is video quality (ScreenCaptureKit → H.264 → WebRTC instead of axe screenshots → JPEG → MJPEG). That is exactly the upgrade path our own README's *Limitations* section already calls out. If framerate becomes a blocker, the move is "write a small Swift helper that does SCK + VideoToolbox, plug it into our pipeline" — not "re-platform onto Supabase + LiveKit."

## What's worth stealing from SimCast

Three discrete ideas that could land in `sim-stream` without taking on their architecture:

1. **WebRTC / ScreenCaptureKit pipeline.** The real framerate fix. Material effort (Swift helper + WebRTC signalling) but unblocks animation/scroll testing. Already in our roadmap.
2. **Screenshot gallery with persistence.** Trivial to add: a `~/Desktop/sim-stream/` directory with an index page, or even just a small SQLite + static thumbnail grid. SimCast's `pending → ready/failed` lifecycle is overkill for our use case but the gallery itself is nice.
3. **Tap-by-accessibility-label.** Useful for testing — axe already exposes the simulator's accessibility tree. Small UI: type a label, the server resolves coordinates via axe and dispatches a tap.

## When to revisit

Switch to (or re-evaluate) SimCast if requirements move toward:

- **Multi-simulator dashboards** — running multiple simulators on the same Mac and watching them side-by-side.
- **Team-shared recording library** — durable storage of screenshot/recording artifacts shared across collaborators.
- **High-framerate capture for animation/scroll testing** — and we don't want to build the SCK + WebRTC pipeline ourselves.
- **Operator console with command lifecycle logs** — if our workflow grows past one user / one session.

Until any of those bite, the simpler tool wins on bring-up cost, share-ability, and offline operation.

## Repo health snapshot

Captured at evaluation time for future reference. Re-check before re-evaluating — these change.

| Field | Value |
|---|---|
| Repository | `simcast-dev/simcast` |
| Created | 2026-03-03 |
| Last push | 2026-04-21 |
| Stars | 3 |
| Watchers | 0 |
| Forks | 2 |
| License | MIT |
| Primary language | TypeScript (also Swift in `apps/macos`) |

## Open Questions

- **Framerate threshold.** At what point does our ~7–10 fps stop being good enough? Worth defining the trigger before sinking time into a SCK pipeline. Animation review and scroll-feel verification are the obvious candidates.
- **Multi-simulator demand.** Is there a realistic scenario where we'd want two simulators side-by-side, or is "one at a time" fine indefinitely?
- **Gallery scope creep.** If we add a screenshot gallery, does it stay local (filesystem) or does it want sync across devices? The local version is hours of work; the synced version reproduces SimCast's persistence problem.

---
*Generated from a Claude Code session on 2026-05-12. Working directory: `/Users/ysf/Developer/sim-stream`.*
