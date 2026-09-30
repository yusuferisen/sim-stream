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

- **Current phase / sub-phase:** 6.1 — `cloudflared` quick-tunnel provider
- **State:** not-started
- **Last completed:** 5.2 (expiring share links — `--share demo=2h`; Phase 5, token & session hardening, is done)
- **Build:** green (`node --check` ×3) · **Tests:** 21/21 (`npm test` — covers `shares.js` only) · **Simulator-verified:** yes (sandbox clone: 55-check auth/expiry matrix, Chrome watching a share expire, `lan` link opened from a bench iPhone)

---

## Next Concrete Action

> Implement 6.1 (`cloudflared` anonymous quick tunnel) as one new entry in
> `remote.js`'s `PROVIDERS` map: `prepare` → `{host: "127.0.0.1"}`; `start({port})`
> spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, parses the
> `trycloudflare.com` hostname from its output, and returns the **token-free**
> base URL (`https://<host>/`) — the server appends `?token=…` per link;
> `stop` kills the child (mandatory). A missing binary fails at once with the
> install command. Then verify against a real tunnel that Cloudflare's edge
> does not buffer the MJPEG stream, and that a short `--share` still cuts the
> stream at its deadline through the tunnel.
> 6.1 carries no model tag: an autopilot run still on Fable halts here by design; `/pilot` routes it down to Opus.

---

## Open Decisions (reversible — defaults chosen, proceeding)

- **Missing `cloudflared` binary in 6.1** → chose **fail immediately with the install command**, mirroring `start.sh`'s `axe` check → DECISIONS.md § Phase 6.2 deferred (phase 6)
- **When is ~7–10 fps no longer good enough to justify Phase 7?** → chose **defer until animation or scroll review actually blocks a check** → DECISIONS.md § Build vs. adopt (phase 7)
- **Does a screenshot gallery stay local or sync across devices?** → chose **local filesystem only** → DECISIONS.md § Build vs. adopt (phase 8)
- **Multi-simulator support** → chose **out of scope; one simulator per server** → DECISIONS.md § Build vs. adopt
- **Share lifetime syntax (5.2, expiring share links)** → chose **`--share [label=]<ttl>` with a mandatory unit; a bare number is an error** → DECISIONS.md § Share-token mechanics (5.2)
- **A dead link token vs. a still-valid cookie (5.2)** → chose **the link decides: `401`, even in the operator's own browser** (amends 5.1, cookie handoff) → DECISIONS.md § Share-token mechanics (5.2)
- **Revoking or extending one share (5.2)** → chose **not supported; restart revokes everything, the operator's own never-expiring token included** → DECISIONS.md § Share-token mechanics (5.2)

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

`/clarify` resolved the PRD verification on 2026-07-31: principle 2 and the
hosted-infrastructure scope line were amended, and the PRD is now frozen.
Phase 6b's Cloudflare-domain prerequisite is tracked under Assumptions & Risks
rather than here — it blocks a post-milestone phase, not the run.

---

## Assumptions & Risks

- **Automated tests cover only `shares.js`** (`npm test`, the token registry). Every other path needs a booted simulator plus the AXe binary on macOS, so nothing runs in CI. The phase gate is still the manual browser checklist in `docs/architecture.md` § Testing strategy.
- **Host prerequisites:** macOS with Xcode simulators, `axe` (`brew install cameroncooke/axe/axe`), Node 18+.
- **`boundsForDeviceType()` is a hand-maintained table.** A simulator model missing from it mis-maps taps silently — check `/api/info` bounds first when taps land wrong.
- **The operator's own token still never expires** within a run, and it is the one on the `local:` / `--remote` banner lines. Only `--share` links die on their own — hand those out, not the top link.
- **Tailscale providers were not re-run after 5.2 (expiring share links) changed the provider contract** (`start` now returns a token-free URL). `lan` was verified from a real phone and the Tailscale edit is the same one-line shape, but check the printed links on the next `tailscale-serve`/`-funnel` use.
- **The iOS 27 sandbox clone is slow while streaming:** `axe tap` timed out there in 5.1 (cookie handoff) verification (~10 s vs. the queue's 5 s) and `simctl io screenshot` in 5.2 (expiring share links) verification (past its 10 s); hardware buttons ack fine. Environmental and older than both phases — recheck on the home phone before blaming the queue.
- **Cloudflare's edge may buffer `multipart/x-mixed-replace`.** Test an actual tunnel before recommending either Phase 6 provider over Tailscale.
- **`docs/OVERVIEW.md` and `docs/architecture.md` were inferred by `/adopt` on 2026-07-31** from the code — their claims were source-verified in review, but they describe intent they weren't written from.
- **Phase 6b needs a domain on a Cloudflare account** (plus a named tunnel and an Access policy) before it can be built or verified. It sits past the milestone for exactly this reason; a run reaching it should halt.

---

## How to Resume

Read this file top-to-bottom → do **Next Concrete Action** → on completion,
check off the roadmap item, **overwrite** **Current Status** + **Next Concrete
Action** (outgoing narrative goes into a new `docs/JOURNAL.md` entry), add any
new **Open Decisions** one-liners (full rationale → `docs/DECISIONS.md`),
commit, then continue or stop at the milestone. If **Needs You** is non-empty,
STOP and surface those items.
