<!--
  PROGRESS.md — the CURSOR. Lives at the REPO ROOT, injected into every session.
  Sections are OVERWRITTEN, never appended. No history here — per-phase narrative
  goes to docs/JOURNAL.md. ROADMAP = future · OVERVIEW = present · JOURNAL = past.
  Contract: ~/.dotfiles/docs/autopilot/doc-contract.md
-->

# Project Progress

- **Project:** sim-stream
- **Target milestone:** Safe public sharing — stop here for review
- **Status:** `milestone-reached`
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
- [x] **Phase 9 — Real-device backend (WebDriverAgent)**
  - [x] 9.1 Backend seam → `backends/simulator.js` + `mjpeg.js`; checklist passed on a clone [model: fable]
  - [x] 9.2 Device video → `backends/device.js`; ~28 fps from the primary bench iPhone
  - [x] 9.3 Device input → Home via `/wda/homescreen`, Siri refused (WDA has no working equivalent on the bench)
  - [x] 9.4 H.264 for devices → 26 fps at 1.7 Mbit/s from the primary bench iPhone

---

## Current Status

- **Current phase / sub-phase:** none in progress — Phase 9 (real-device backend) is complete; the 🏁 Safe public sharing milestone awaits the owner's review
- **State:** done
- **Last completed:** 9.4 (H.264 for devices) — the primary bench iPhone plays as H.264 in Chrome (~26 fps under motion, 1.7 Mbit/s vs 30 Mbit/s MJPEG); MJPEG fallback without the helper confirmed
- **Build:** green (`node --check` ×10) · **Tests:** 156/156 `npm test` + 22 `swift test` · **Device-verified:** yes (9.4: primary bench iPhone 16e — `/video` probe while swiping, Chrome header `H.264` at 25 fps decoded, MJPEG viewer alongside, helper moved aside → `MJPEG`; simulator H.264 re-checked on a clone)

---

## Next Concrete Action

> Owner: review the 🏁 Safe public sharing milestone (safe link sharing — cookie handoff, expiring shares, Cloudflare quick tunnel) and tick its box when satisfied.
> The remaining phases need the owner's accounts first: 6b (Cloudflare Access — a domain on a Cloudflare account) and 8b (ngrok — an authtoken in the Keychain as `NGROK_AUTHTOKEN`).

---

## Open Decisions (reversible — defaults chosen, proceeding)

- _none_

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

---

## Assumptions & Risks

- **Automated tests cover only the import-safe modules** (`npm test`: shares, both hubs, gallery, tap-label, the `cloudflared` provider, the queue, the simulator backend's pure parts, the device backend against a fake WDA and `ios`). Process plumbing (AXe, `simctl`, the encoder, a real WDA) needs a simulator or bench device, so nothing runs in CI; the phase gate is the manual checklist in `docs/architecture.md` § Testing strategy.
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
- **Device input is slow (9.3):** ~1 s per touch (WDA waits for idle); Home on the home screen answers ~10 s late, holding the queue; Lock times out without locking on the iOS 26.6 bench.
- **The QuickTime-mirror capture route is unavailable on this Mac** (macOS 27 / iOS 26.6: no AVFoundation muxed device appears even when enabled), so 60 fps over USB is not on the table; WDA's 29 fps MJPEG is the ceiling for devices, H.264 included (~26 fps under motion, 9.4).
- **Device H.264 after a rotation is stretched**, not re-laid out: the helper scales a landscape image into the portrait picture measured at startup (DECISIONS.md § Device H.264 mechanics).
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
