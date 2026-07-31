<!--
  PROGRESS.md — the CURSOR. Lives at the REPO ROOT, injected into every session.
  Sections are OVERWRITTEN, never appended. No history here — per-phase narrative
  goes to docs/JOURNAL.md. ROADMAP = future · OVERVIEW = present · JOURNAL = past.
  Contract: ~/.dotfiles/docs/autopilot/doc-contract.md
-->

# Project Progress

- **Project:** sim-stream
- **Target milestone:** Safe public sharing — stop here for review
- **Status:** `in-progress`
- **Updated:** 2026-07-31

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
- [ ] **Phase 5 — Token & session hardening**
  - [ ] 5.1 Cookie handoff — authenticate once, set an httpOnly cookie, redirect to a clean URL; both check sites accept it, `x-token` retained
  - [ ] 5.2 Expiring per-share tokens — in-memory registry (value, expiry, label) minted at startup, replacing the single constant [model: fable]
- [ ] **Phase 6 — Cloudflare quick tunnel**
  - [ ] 6.1 `cloudflared` provider — anonymous quick tunnel, mandatory `stop`; verify the edge does not buffer MJPEG
- [ ] 🏁 **MILESTONE: Safe public sharing** ← default stop point
- [ ] **Phase 6b — Gated public sharing (Cloudflare Access)**
  - [ ] 6b.1 `cloudflare-access` named-tunnel provider — Access policy in front of the tunnel
- [ ] **Phase 7 — Capture pipeline**
  - [ ] 7.1 Swift helper — ScreenCaptureKit capture + VideoToolbox H.264 encode
  - [ ] 7.2 WebRTC transport replacing the MJPEG path
- [ ] **Phase 8 — Borrowed conveniences**
  - [ ] 8.1 Screenshot gallery — `~/Desktop/sim-stream/` plus a served thumbnail index
  - [ ] 8.2 Tap by accessibility label — resolve a label to coordinates via `axe`
  - [ ] 8.3 `ngrok` provider

---

## Current Status

- **Current phase / sub-phase:** 5.1 — cookie handoff
- **State:** not-started
- **Last completed:** 4.1 (SimCast evaluated; keeping `sim-stream` — the auth model and bring-up cost decided it)
- **Build:** green · **Tests:** n/a (no suite — see Assumptions & Risks) · **Simulator-verified:** n/a

---

## Next Concrete Action

> Implement 5.1: in `server.js`, have `authCheck` set an httpOnly cookie after a
> successful match on `GET /`, then redirect to the token-free URL. Both check
> sites need the cookie added, and they differ today: `authCheck` (used by `/`,
> `/api/info`, `/stream`) accepts `?token=` **or** the `x-token` header, while
> the `server.on("upgrade")` handler accepts `?token=` only. `x-token` is
> retained by decision — document it as the scripted path, don't remove it.
> Keep close code `1008` as the auth-failure signal; the client's error toast
> depends on it. Verify by loading the URL on a phone: the address bar no
> longer shows the token, and the stream plus WebSocket input still work.

---

## Open Decisions (reversible — defaults chosen, proceeding)

- **Missing `cloudflared` binary in 6.1** → chose **fail immediately with the install command**, mirroring `start.sh`'s `axe` check → DECISIONS.md § Phase 6.2 deferred (phase 6)
- **When is ~7–10 fps no longer good enough to justify Phase 7?** → chose **defer until animation or scroll review actually blocks a check** → DECISIONS.md § Build vs. adopt (phase 7)
- **Does a screenshot gallery stay local or sync across devices?** → chose **local filesystem only** → DECISIONS.md § Build vs. adopt (phase 8)
- **Multi-simulator support** → chose **out of scope; one simulator per server** → DECISIONS.md § Build vs. adopt

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

`/clarify` resolved the PRD verification on 2026-07-31: principle 2 and the
hosted-infrastructure scope line were amended, and the PRD is now frozen.
Phase 6b's Cloudflare-domain prerequisite is tracked under Assumptions & Risks
rather than here — it blocks a post-milestone phase, not the run.

---

## Assumptions & Risks

- **No automated test suite.** Every path needs a booted simulator plus the AXe binary on macOS, so nothing runs in CI. The phase gate is the manual browser checklist in `docs/architecture.md` § Testing strategy.
- **Host prerequisites:** macOS with Xcode simulators, `axe` (`brew install cameroncooke/axe/axe`), Node 18+.
- **`boundsForDeviceType()` is a hand-maintained table.** A simulator model missing from it mis-maps taps silently — check `/api/info` bounds first when taps land wrong.
- **The token never expires and rides in the URL.** On a `tailscale-funnel` URL it is the only gate. Phase 5 exists for this.
- **Cloudflare's edge may buffer `multipart/x-mixed-replace`.** Test an actual tunnel before recommending either Phase 6 provider over Tailscale.
- **`docs/OVERVIEW.md` and `docs/architecture.md` were inferred by `/adopt` on 2026-07-31** from the code — their claims were source-verified in review, but they describe intent they weren't written from.
- **Phase 6b needs a domain on a Cloudflare account** (plus a named tunnel and an Access policy) before it can be built or verified. It sits past the milestone for exactly this reason; a run reaching it should halt.
- **5.2 is tagged `[model: fable]`** — API-priced, outside the subscription. Expect **two** halts around it, both correct: a run on any other model halts *entering* 5.2 (mismatch), and a run continuing on Fable halts *leaving* it, because the reverse guard stops Fable rolling onto untagged 6.1. Neither is a malfunction.

---

## How to Resume

Read this file top-to-bottom → do **Next Concrete Action** → on completion,
check off the roadmap item, **overwrite** **Current Status** + **Next Concrete
Action** (outgoing narrative goes into a new `docs/JOURNAL.md` entry), add any
new **Open Decisions** one-liners (full rationale → `docs/DECISIONS.md`),
commit, then continue or stop at the milestone. If **Needs You** is non-empty,
STOP and surface those items.
