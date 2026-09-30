<!--
  PROGRESS.md — the CURSOR. Lives at the REPO ROOT, injected into every session.
  Sections are OVERWRITTEN, never appended. No history here — per-phase narrative
  goes to docs/JOURNAL.md. ROADMAP = future · OVERVIEW = present · JOURNAL = past.
  Contract: ~/.dotfiles/docs/autopilot/doc-contract.md
-->

# Project Progress

- **Project:** sim-stream
- **Target milestone:** Safe public sharing — stop here for review
- **Status:** `continue`
- **Updated:** 2026-09-30

---

## Reference docs (the router — `docs/` files don't auto-load)

- **PRD (intent):** `docs/PRD.md` <!-- inferred by /adopt 2026-07-31 — verify -->
- **Roadmap (future — plan prose for unshipped phases):** `docs/ROADMAP.md`
- **Overview (present — diagrams + current user stories):** `docs/OVERVIEW.md`
- **Journal (past — append-only per-phase narrative):** `docs/JOURNAL.md`
- **Architecture (engineering contract):** `docs/architecture.md`
- **Decisions log:** `docs/DECISIONS.md`
- **Research:** `docs/research/` (dated evidence reports)
- **Active surface:** repo root — single Node surface; `CLAUDE.md` carries the build/run/test contract

---

## Roadmap

- [x] **Phase 1 — Core streaming + input**
  - [x] 1.1 MJPEG hub over `axe stream-video`
  - [x] 1.2 WebSocket input dispatch (tap/swipe/long-press/type/key/button)
  - [x] 1.3 Simulator discovery, boot, and device bounds
  - [x] 1.4 Token auth on HTTP routes and the WS upgrade
  - [x] 1.5 Browser client — MJPEG view, gesture detection, controls panel
- [x] **Phase 2 — Mobile UI**
  - [x] 2.1 Fullscreen layout with FAB + bottom sheet at ≤720px
- [x] **Phase 3 — Remote access**
  - [x] 3.1 Pluggable provider interface in `remote.js`
  - [x] 3.2 `lan`, `tailscale-serve`, and `tailscale-funnel` providers
- [x] **Phase 4 — Build-vs-adopt evaluation**
  - [x] 4.1 SimCast evaluation — verdict: keep `sim-stream`
- [x] **Phase 5 — Token & session hardening**
  - [x] 5.1 Cookie handoff → both check sites share one `requestAuthorized()`; the WS upgrade now also accepts `x-token`
  - [x] 5.2 Expiring per-share tokens → `--share [label=]<ttl>`; expiry also closes open connections, and one credential decides per request [model: fable]
- [x] **Phase 6 — Cloudflare quick tunnel**
  - [x] 6.1 `cloudflared` provider — anonymous quick tunnel → edge does not buffer MJPEG; link waits for DNS
- [ ] 🏁 **MILESTONE: Safe public sharing** ← default stop point
- [ ] **Phase 6b — Gated public sharing (Cloudflare Access)**
  - [ ] 6b.1 `cloudflare-access` named-tunnel provider — Access policy in front of the tunnel
- [x] **Phase 7 — Capture pipeline (30 fps H.264)**
  - [x] 7.1 Swift encoder helper → AXe's raw rows are 64-byte padded; the helper derives the layout from `--source` + `--scale`
  - [x] 7.2 H.264 hub + authenticated `/video` WebSocket → the hub lives in the pure `h264.js`; two crash paths in the shared WebSocket entry were closed on the way [model: fable]
  - [x] 7.3 Browser player → also fixed taps that acked but never landed on iOS 27 (`--tap-style physical`)
- [x] **Phase 8 — Borrowed conveniences**
  - [x] 8.1 Screenshot gallery
  - [x] 8.2 Tap by accessibility label
- [ ] **Phase 8b — `ngrok` provider (needs the owner's ngrok account)**
  - [ ] 8b.1 `ngrok` provider — same provider shape as 6.1; authtoken from the environment, never a repo file
- [ ] **Phase 9 — Real-device backend (WebDriverAgent)**
  - [x] 9.1 Backend seam → `backends/simulator.js` + `mjpeg.js`; checklist passed on a clone [model: fable]
  - [x] 9.2 Device video → `backends/device.js`; ~28 fps from the primary bench iPhone
  - [ ] 9.3 Device input — tap/long-press/swipe as W3C actions, `type` via `/wda/keys`, buttons via WDA, `tap-label` via accessibility lookup; unlock before dispatch
  - [ ] 9.4 H.264 for devices — helper `--input mjpeg`; `/video` from the device at ≥25 fps and a few Mbit/s

---

## Current Status

- **Current phase / sub-phase:** 9.3 — device input (real-device backend, Phase 9)
- **State:** not-started
- **Last completed:** 9.2 (device video) — `--device primary` streams the bench iPhone 16e to Chrome at 27–28 fps, view-only; the 🏁 Safe public sharing milestone still awaits the owner's review before its box is ticked
- **Build:** green (`node --check` ×10) · **Tests:** 140/140 `npm test` + 11 `swift test` · **Device-verified:** yes (9.2: primary bench iPhone — Chrome playback, reload in the grace window, input error ack, screenshot, a 40 s share expiring, no forward left after Ctrl-C, dead WDA → startup exit with `qa-device up primary`)

---

## Next Concrete Action

> Implement 9.3 (device input) in `backends/device.js`: replace the
> "not supported yet" `input()` with a `SerialQueue` that maps tap /
> long-press / swipe to W3C pointer actions (`POST /session/:id/actions`,
> points = normalized × `bounds`, clamped like `axeInputArgs`), `type` via
> `/wda/keys`, keys and buttons per `DECISIONS.md` § Phase 9 pre-flight
> defaults (refuse the rest with an error ack), and `tap-label` via an
> accessibility lookup (`/elements` by label, `#id` by identifier; no match /
> several matches → error ack). Before each command check `/wda/locked` and
> wake: `/wda/unlock` timed out on the locked 16e in 9.2 while
> `/wda/homescreen` unlocked it. Use `WdaClient.session()` (one-retry
> recovery). Tests against the fake WDA in `test/device-backend.test.js`.
> Done when the browser checklist (tap, swipe, long-press, typed text, a key,
> a button, a label tap, a screenshot) passes from Chrome on the primary bench
> iPhone. Scope: `docs/ROADMAP.md` § Phase 9. 9.3 is untagged.
> Separately, the owner still owes a review of the 🏁 Safe public sharing
> milestone (tick its box when satisfied).

---

## Open Decisions (reversible — defaults chosen, proceeding)

- **Device MJPEG default rate, forward proof, no forward respawn (9.2)** → chose **30 fps; prove WDA's MJPEG answers before listening; a dead forward means restart** → DECISIONS.md § Device video mechanics (phase 9)
- **Special keys and hardware buttons on a device (9.3)** → chose **map what WDA has (return/delete/tab/space; home, lock=side-button, siri), refuse the rest with an error ack** → DECISIONS.md § Phase 9 pre-flight defaults (phase 9)
- **Helper JPEG input (9.4)** → chose **ImageIO decode, frames found by SOI/EOI scan, size from the first SOF; the server fetches the MJPEG and pipes it to the helper's stdin** → DECISIONS.md § Phase 9 pre-flight defaults (phase 9)

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

---

## Assumptions & Risks

- **Automated tests cover only the import-safe modules** (`npm test`: `shares.js`, the token registry; `h264.js` and `mjpeg.js`, the two hubs' logic; `gallery.js`, the gallery's serving rules; `tap-label.js`, tap-by-label arguments and error text; `remote.js`'s `cloudflared` provider, against a fake binary; `backends/queue.js` and the pure parts of `backends/simulator.js` — selection, bounds, input → `axe` argv, the preamble stripper; `backends/device.js` against a fake WDA and a fake `ios`). The process plumbing the backend spawns (AXe, `simctl`, the encoder) needs a booted simulator plus the AXe binary on macOS, so nothing runs in CI. The phase gate is still the manual checklist in `docs/architecture.md` § Testing strategy.
- **`boundsForDeviceType()` (in `backends/simulator.js`) is a hand-maintained table.** A simulator model missing from it mis-maps taps silently — check `/api/info` bounds first when taps land wrong.
- **H.264 can silently turn off on a cold boot.** The startup probe screenshot has a 10 s timeout; a freshly booted clone exceeded it once in 9.1 (the backend seam) and the run said `MJPEG only — … screenshot timed out`. Restart once the simulator settles (a probe retry would fix it; pre-existing, seen once).
- **The operator's own token never expires** within a run (the `local:` / `--remote` banner links). Hand out `--share` links, not the top one.
- **Tailscale providers were not re-run after 5.2 (expiring share links) changed the provider contract** — check the printed links on the next `tailscale-serve`/`-funnel` use.
- **AXe's default tap style does nothing on iOS 27 simulators** — taps pass `--tap-style physical` (7.3, the browser player); an AXe without that flag fails every tap.
- **`axe button home` has no effect on iOS 27 sandbox clones** (seen in 7.3 and again in 9.1, from the CLI too). Check hardware buttons before relying on them.
- **30 fps is the simulator ceiling** — AXe caps `--fps` at 30 (DECISIONS.md § Phase 7 capture source).
- **AXe's raw frame layout is reverse-engineered** on one device size — a sheared H.264 picture on another model or AXe version means `FrameLayout.axe` needs a new measurement (`docs/architecture.md` § H.264 encoder helper).
- **Taps take 1.0–2.0 s with the page playing H.264** against the queue's 5 s timeout (7.3, the browser player); on a simulator's first minute after boot, ~5 s (9.1). Input wins over smoothness: lower the capture rate before loosening the queue.
- **H.264 in iPhone Safari was checked once** (6.1, the Cloudflare tunnel); the MJPEG fallback has only been seen in Chrome.
- **Neither hub has a heartbeat** — a hung capture stays `live`. The page copes (falls back after 4 s without frames); a script client must do the same.
- **go-ios binds the device's MJPEG forward on all interfaces** (no bind-address option) — anyone on the LAN who finds the port sees the device's screen without a token while a device server runs, as the bench's WDA forwards already allow full control. Keep device runs on trusted networks.
- **Device mode (Phase 9) is bench-only:** WDA must already be running (`qa-device up <role>`), `ios` (go-ios) is required for the port-forward, and the tool cannot tell a bench device from a personal one — the bench rule is the guard. Keep device shares short.
- **The QuickTime-mirror capture route is unavailable on this Mac** (macOS 27 / iOS 26.6: no AVFoundation muxed device appears even when enabled), so 60 fps over USB is not on the table; WDA's 29 fps MJPEG is the ceiling for devices.
- **Phase 8b needs the owner's ngrok account** (authtoken in the Keychain as `NGROK_AUTHTOKEN`). A run reaching it should halt.
- **Quick tunnels have no uptime guarantee** (one 6.1 run lost every tunnel connection at ~111 s, unexplained). A share meant to last hours may be better on Tailscale Funnel.
- **Phase 6b needs a domain on a Cloudflare account** (named tunnel + Access policy). A run reaching it should halt.

---

## How to Resume

Read this file top-to-bottom → do **Next Concrete Action** → on completion,
check off the roadmap item, **overwrite** **Current Status** + **Next Concrete
Action** (outgoing narrative goes into a new `docs/JOURNAL.md` entry), add any
new **Open Decisions** one-liners (full rationale → `docs/DECISIONS.md`),
commit, then continue or stop at the milestone. If **Needs You** is non-empty,
STOP and surface those items.
