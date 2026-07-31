# Journal

> Append-only per-phase narrative. Never auto-loaded. Newest entries at the
> bottom. Entries before 2026-07-31 were reconstructed from git history by
> `/adopt` — they record what the commits show, not a contemporaneous account.

---

## 2026-04-24 — Phase 1: Core streaming + input

Initial commit (`121cd6d`). Established the whole shape of the tool in one go:
a ~550-line ESM Node server (`server.js`), a single-page browser client
(`public/index.html`), and a dev launcher (`scripts/start.sh`).

- **MJPEG hub** — `MjpegHub extends EventEmitter` spawns
  `axe stream-video --format mjpeg`, strips the leading HTTP headers AXe emits,
  and fans the byte stream out to every `GET /stream` client. Refcounted: the
  AXe process is spawned on the first client and stopped after a 5s grace
  window (`graceMs`) once the last one drops. A `generation` counter guards
  against a stale exit handler killing a freshly respawned process.
- **Input path** — `WS /ws` carries JSON events; `dispatchInput()` translates
  them into AXe argv, serialized through a `CommandQueue` FIFO so two taps
  never race. Acks return as `{type:"ack", id}`.
- **Coordinates** — the browser sends normalized `(0..1, 0..1)`; the server
  maps to simulator logical points via `boundsForDeviceType()`, a hand-kept
  table (iPhone 17 Pro Max → 440×956).
- **Auth** — a random 12-byte hex token, compared with
  `crypto.timingSafeEqual`, accepted as `?token=…` on every route and on the
  WS upgrade. `--auth false` disables it for local-only use.

Gotcha fixed in the same period: `scripts/start.sh` hit bash 3.2's empty-array
pitfall (`EXTRA[@]: unbound variable`) — resolved by building the flag string
and re-splitting rather than using an array.

---

## 2026-04-24 — Phase 2: Mobile UI

Commit `bd893c5`. The client was desktop-shaped; on a phone the controls panel
ate the screen. Reworked to fullscreen at ≤720px: the panel collapses into a
bottom sheet opened by a corner ⋯ FAB, dismissed by backdrop tap or by dragging
the handle down.

Deliberate asymmetry in the auto-close behavior: Hardware / Gesture / Send-text
actions close the sheet (they're one-shot), keyboard quick-keys
(Return/Back/Space/Tab) do not — so they can be chained without reopening.

---

## 2026-04-25 — Phase 3: Remote access providers

Commit `1a2d2b6`. The server bound to `127.0.0.1` and reaching it from a phone
meant hand-passing `--host 0.0.0.0`. Introduced `remote.js`: a `PROVIDERS` map
where each entry implements `prepare` / `start` / `stop`, selected by
`--remote <name>`.

Shipped providers: `lan` (sugar for `--host 0.0.0.0` + LAN-IP discovery via
`primaryLanIp()`), `tailscale-serve` (private HTTPS across the tailnet), and
`tailscale-funnel` (publicly reachable HTTPS).

Gotchas that shaped the code:
- Tailnet Serve/Funnel are off by default. The failure path was opaque, so the
  provider now parses the admin-console URL out of the CLI error and prints it
  — one click enables it.
- The App Store / standalone-installer Tailscale builds on macOS route
  serve/funnel through the GUI agent and can hang indefinitely. A 30s timeout
  was added so the command fails loudly instead of appearing to work.
  Homebrew's non-sandboxed `tailscaled` is the recommendation for headless Macs.

---

## 2026-05-12 — Phase 4: Build-vs-adopt evaluation (SimCast)

Commit `82a3213`. Evaluated `simcast-dev/simcast` as a replacement for this
repo. **Verdict: keep `sim-stream`.**

The deciding factor was the auth model, not the feature list: SimCast keys its
realtime channel to a single Supabase user that both the macOS app and the web
dashboard must sign into, so there is no token-URL share story — which is
exactly this tool's workflow. Bring-up cost (Supabase project + 2 SQL
migrations + an edge function with 3 secrets + LiveKit Cloud + a Vercel deploy)
versus `npm i && node server.js` reinforced it, as did the repo health signal
(3 stars, ~7 weeks old, schema still moving).

SimCast's one real advantage — 60fps WebRTC via ScreenCaptureKit + VideoToolbox
against our ~7–10fps AXe screenshot loop — was judged **severable**: buildable
later as a Swift helper feeding our existing pipeline, no re-platforming
required. Full report: `docs/research/2026-05-12-simcast-evaluation.md`.

---

## 2026-07-31 — /adopt: converged onto the canonical doc contract

Structural only; no behavior changed. The repo was born outside the autopilot
pipeline and had no `PROGRESS.md`, so `autopilot-doctor.sh` exited 3.

- Relocated `simcast-evaluation.md` → `docs/research/2026-05-12-simcast-evaluation.md`
  (content untouched).
- Evicted the `### Roadmap` section from `README.md` — its five remote-access
  improvement items became plan prose in `docs/ROADMAP.md` and checklist items
  in `PROGRESS.md`. README keeps a pointer.
- Unioned the roadmap: the five README items plus the three "worth stealing
  from SimCast" items (WebRTC pipeline, screenshot gallery, tap-by-a11y-label)
  now live as one checklist in `PROGRESS.md`. Nothing was dropped.
- Stubbed `docs/PRD.md`, `docs/OVERVIEW.md`, `docs/architecture.md`,
  `docs/DECISIONS.md`, root `CLAUDE.md`, and this file from repo reality.
- Phases 1–4 above were reconstructed from git history so the checked boxes in
  `PROGRESS.md` could be trimmed to label + title without losing the narrative.

Milestone placed after Phase 6 (**Safe public sharing**) per an explicit
decision during adoption: the token in the URL bar is the only gate on a
Tailscale Funnel URL, so hardening ranks above the framerate rewrite.
