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

---

## Current Status

- **Current phase / sub-phase:** 🏁 milestone (safe public sharing) reached — awaiting owner review
- **State:** milestone-reached
- **Last completed:** 6.1 (`cloudflared` quick-tunnel provider — `--remote cloudflared`)
- **Build:** green (`node --check` ×6) · **Tests:** 99/99 `npm test` + 11 `swift test` (helper; untouched) · **Simulator-verified:** yes (sandbox clone through real quick tunnels: MJPEG + H.264, share expiry at the edge; QA bench iPhone Safari showed `H.264` and taps landed)

---

## Next Concrete Action

> Owner review of the 🏁 Safe public sharing milestone (cookie handoff,
> expiring `--share` links, the `cloudflared` quick tunnel), then tick the
> milestone box. Past it, every remaining phase needs an owner prerequisite:
> 6b (Cloudflare Access gate) needs a domain on a Cloudflare account; 8b
> (ngrok provider) needs an ngrok account and authtoken.

---

## Open Decisions (reversible — defaults chosen, proceeding)

- **Multi-simulator support** → chose **out of scope; one simulator per server** → DECISIONS.md § Build vs. adopt

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

---

## Assumptions & Risks

- **Automated tests cover only the import-safe modules** (`npm test`: `shares.js`, the token registry; `h264.js`, the `/video` hub's logic; `gallery.js`, the gallery's serving rules; `tap-label.js`, tap-by-label arguments and error text; `remote.js`'s `cloudflared` provider, against a fake binary). Every other path — including the process plumbing that spawns AXe and the encoder — needs a booted simulator plus the AXe binary on macOS, so nothing runs in CI. The phase gate is still the manual checklist in `docs/architecture.md` § Testing strategy.
- **`boundsForDeviceType()` is a hand-maintained table.** A simulator model missing from it mis-maps taps silently — check `/api/info` bounds first when taps land wrong.
- **The operator's own token still never expires** within a run, and it is the one on the `local:` / `--remote` banner lines. Only `--share` links die on their own — hand those out, not the top link.
- **Tailscale providers were not re-run after 5.2 (expiring share links) changed the provider contract** (`start` now returns a token-free URL). `lan` was verified from a real phone and the Tailscale edit is the same one-line shape, but check the printed links on the next `tailscale-serve`/`-funnel` use.
- **AXe's default tap style does nothing on iOS 27 simulators** (it acks; found in 7.3, the browser player). Coordinate and label taps pass `--tap-style physical` → DECISIONS.md § Browser player mechanics (7.3). An AXe without that flag fails every tap.
- **`axe button home` showed no effect on iOS 27 sandbox clones during 7.3** — seen from the CLI, not investigated. Check hardware buttons before relying on them.
- **30 fps is this design's ceiling** — AXe caps `--fps` at 30 → DECISIONS.md § Phase 7 capture source. Measured on one host only.
- **AXe's raw frame layout is reverse-engineered** (64-byte row padding; row count padded to 16 at scale 1.0 only), measured on one device size (1206×2622). Another model or AXe version could differ — a garbled/sheared H.264 picture means `FrameLayout.axe` needs a new measurement.
- **Taps take 1.0–2.0 s with the page playing H.264** (7.3, measured in Chrome on a sandbox clone; MJPEG alone: 1.0–1.5 s) against the queue's 5 s timeout. Input wins over smoothness (PRD principle 5): lower the capture rate before loosening the queue.
- **H.264 in iPhone Safari was checked once** (6.1, the Cloudflare tunnel, QA bench iPhone 16e): header `H.264`, taps land. The MJPEG fallback has still only been seen in Chrome, not on a phone.
- **The server's H.264 pipeline still has no heartbeat or reconnect limit** — a hung encoder stays `live`. The page copes (falls back after 4 s without frames, never reconnects); a script client must do the same.
- **Phase 8b needs the owner's ngrok account** (`ngrok` not installed; authtoken in the Keychain as `NGROK_AUTHTOKEN`). A run reaching 8b should halt.
- **Quick tunnels have no uptime guarantee.** One 6.1 run dropped every tunnel connection at once after ~111 s (unexplained; tunnel-level `ERR` lines are now logged as `[remote:cloudflared]`). A share meant to last hours may be better on Tailscale Funnel.
- **Phase 6b needs a domain on a Cloudflare account** (plus a named tunnel and an Access policy) before it can be built or verified. It sits past the milestone for exactly this reason; a run reaching it should halt.

---

## How to Resume

Read this file top-to-bottom → do **Next Concrete Action** → on completion,
check off the roadmap item, **overwrite** **Current Status** + **Next Concrete
Action** (outgoing narrative goes into a new `docs/JOURNAL.md` entry), add any
new **Open Decisions** one-liners (full rationale → `docs/DECISIONS.md`),
commit, then continue or stop at the milestone. If **Needs You** is non-empty,
STOP and surface those items.
