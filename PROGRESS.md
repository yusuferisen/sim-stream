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
- [ ] **Phase 7 — Capture pipeline (30 fps H.264)**
  - [x] 7.1 Swift encoder helper → AXe's raw rows are 64-byte padded; the helper derives the layout from `--source` + `--scale`
  - [ ] 7.2 H.264 hub + authenticated `/video` WebSocket — refcount/grace/generation like `MjpegHub`, keyframe-on-join, slow-client drop, share-expiry `track()`; MJPEG untouched [model: fable]
  - [ ] 7.3 Browser player — WebCodecs → canvas on secure contexts, automatic MJPEG fallback elsewhere; taps still land and ack inside the queue timeout
- [ ] **Phase 8 — Borrowed conveniences**
  - [ ] 8.1 Screenshot gallery — screenshots land in `~/Desktop/sim-stream/`; owner-only `/gallery` index with `sips` thumbnails
  - [ ] 8.2 Tap by accessibility label — a `tap-label` input event passed to `axe tap --label` through the command queue
- [ ] **Phase 8b — `ngrok` provider (needs the owner's ngrok account)**
  - [ ] 8b.1 `ngrok` provider — same provider shape as 6.1; authtoken from the environment, never a repo file

---

## Current Status

- **Current phase / sub-phase:** 7.2 — H.264 hub + authenticated `/video` WebSocket
- **State:** not-started
- **Last completed:** 7.1 (Swift encoder helper — `helper/`, `npm run build:helper`; server not wired yet)
- **Build:** green (`node --check` ×3, `swift build -c release`) · **Tests:** 21/21 `npm test` + 11 `swift test` (helper) · **Simulator-verified:** yes (sandbox clone: AXe → helper at 30.3 fps scale 0.5, 30.7 fps scale 1.0, `ffprobe` decodes every frame)

---

## Next Concrete Action

> Implement 7.2 (H.264 hub + authenticated `/video` WebSocket) from
> `docs/architecture.md` § H.264 encoder helper — the helper's command line,
> AXe's padded frame layout, and the 16-byte framed output are written there.
> Spawn `axe stream-video --format bgra --fps <FPS> --scale <SCALE>` and pipe
> its stdout straight into `helper/.build/release/sim-stream-encoder --source
> <W>x<H> --scale <SCALE> --fps <FPS>` (fd hand-off, never through Node),
> where `<W>x<H>` is the device's pixel size from a screenshot's PNG header.
> Clamp or reject `--scale`/`--fps` outside the helper's ranges (exit 2).
> Rest of the scope, including `start.sh` building the helper and the done
> check: `docs/ROADMAP.md` § Phase 7.
> 7.2 is tagged `[model: fable]`: a non-Fable session halts at the tag gate; `/pilot` routes it to Fable.

---

## Open Decisions (reversible — defaults chosen, proceeding)

- **Missing `cloudflared` binary in 6.1** → chose **fail immediately with the install command**, mirroring `start.sh`'s `axe` check → DECISIONS.md § Phase 6.2 deferred (phase 6)
- **Encoder for 7.1 (Swift encoder helper)** → chose **Swift/VideoToolbox, not `ffmpeg`** → DECISIONS.md § Phase 7–8 defaults (phase 7)
- **Helper not built, or no `swift`** → chose **serve MJPEG as today, one log line; `start.sh` builds it when it can** → DECISIONS.md § Phase 7–8 defaults (phase 7)
- **H.264 stream shape (7.1)** → chose **30 fps, size follows `--scale`, keyframe every second, no B-frames** → DECISIONS.md § Phase 7–8 defaults (phase 7)
- **Who may open the screenshot gallery (8.1)** → chose **owner credential only; share links refused** → DECISIONS.md § Phase 7–8 defaults (phase 8)
- **Gallery thumbnails (8.1)** → chose **`sips`, cached in `~/Desktop/sim-stream/.thumbs/`; old Desktop screenshots not migrated** → DECISIONS.md § Phase 7–8 defaults (phase 8)
- **Tap-by-label matching (8.2)** → chose **label text, `#name` for an identifier; AXe's own error on no/multiple matches, never a guess** → DECISIONS.md § Phase 7–8 defaults (phase 8)
- **Does a screenshot gallery stay local or sync across devices?** → chose **local filesystem only** → DECISIONS.md § Build vs. adopt (phase 8)
- **Multi-simulator support** → chose **out of scope; one simulator per server** → DECISIONS.md § Build vs. adopt

---

## Needs You (irreversible / load-bearing — halts the run)

- _none_

---

## Assumptions & Risks

- **Automated tests cover only `shares.js`** (`npm test`, the token registry). Every other path needs a booted simulator plus the AXe binary on macOS, so nothing runs in CI. The phase gate is still the manual browser checklist in `docs/architecture.md` § Testing strategy.
- **Host prerequisites:** macOS with Xcode simulators, `axe` (`brew install cameroncooke/axe/axe`), Node 18+.
- **`boundsForDeviceType()` is a hand-maintained table.** A simulator model missing from it mis-maps taps silently — check `/api/info` bounds first when taps land wrong.
- **The operator's own token still never expires** within a run, and it is the one on the `local:` / `--remote` banner lines. Only `--share` links die on their own — hand those out, not the top link.
- **Tailscale providers were not re-run after 5.2 (expiring share links) changed the provider contract** (`start` now returns a token-free URL). `lan` was verified from a real phone and the Tailscale edit is the same one-line shape, but check the printed links on the next `tailscale-serve`/`-funnel` use.
- **An iOS 27 sandbox clone was slow while streaming** in Phase 5 verification (`axe tap` ~10 s, screenshot past 10 s); not reproduced on a fresh clone on 2026-09-30 (1.6–2.0 s, 0.5 s). Environmental — recheck before blaming the queue.
- **30 fps holds through the encoder while scrolling** (7.1: 30.3 fps at scale 0.5, 30.7 at 1.0, headless clone) — still one host. AXe caps `--fps` at 30 — this design's ceiling → DECISIONS.md § Phase 7 capture source.
- **AXe's raw frame layout is reverse-engineered** (64-byte row padding; row count padded to 16 at scale 1.0 only), measured on one device size (1206×2622). Another model or AXe version could differ — a garbled/sheared H.264 picture means `FrameLayout.axe` needs a new measurement.
- **30 fps capture slows taps:** 3.0–3.5 s vs. 1.6–2.0 s, against the queue's 5 s timeout. 7.3 (browser player) must re-measure; input wins over smoothness (PRD principle 5).
- **The H.264 path only runs on https or `localhost`**, so plain-http `--remote lan` stays on MJPEG by design. Phase 7 runs before 6.1 (the account-free https tunnel), so 7.3 verifies H.264 in desktop Chrome on `localhost` and the MJPEG fallback from a phone over `lan`; the real-iPhone H.264 check waits for 6.1 (not blocking — record it as outstanding, don't halt on it).
- **Phase 8b needs the owner's ngrok account** (`ngrok` not installed; authtoken in the Keychain as `NGROK_AUTHTOKEN`). A run reaching 8b should halt.
- **Cloudflare's edge may buffer `multipart/x-mixed-replace`.** Test an actual tunnel before recommending either Phase 6 provider over Tailscale. `cloudflared` is not installed on this host yet (`brew install cloudflared`; no account needed).
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
