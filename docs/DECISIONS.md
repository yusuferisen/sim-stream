# Decisions

> Choices and their rationale, append-only, dated. What we chose, why, and what
> we rejected. Not how a phase went (that's `JOURNAL.md`) and not step plans
> (that's `ROADMAP.md`).
>
> Entries dated before 2026-07-31 were reconstructed by `/adopt` from the code,
> the README, and the SimCast evaluation — the rationale is the one the
> artifacts demonstrate, not a contemporaneous record.

---

## 2026-04-24 — AXe CLI as the capture *and* input backend

**Chose:** `axe` (`brew install cameroncooke/axe/axe`) for both video capture
(`axe stream-video`) and HID injection (`tap`, `swipe`, `touch`, `type`, `key`,
`button`).

**Why:** `simctl` alone cannot inject touch or stream video. AXe covers both
gaps behind one dependency, so the server stays a thin translator with no
native code of its own.

**Cost accepted:** AXe's capture is a screenshot loop, which caps real
throughput at ~7–10fps regardless of the `--fps` flag. Its `type` uses US HID
keycodes, so non-ASCII input is unsupported. Both are documented limitations
rather than bugs.

**Rejected:** a ScreenCaptureKit + VideoToolbox pipeline. Correct for
framerate, but it means shipping and maintaining a Swift helper — deferred, see
Phase 7.

---

## 2026-04-24 — MJPEG over `multipart/x-mixed-replace` as the video transport

**Chose:** `GET /stream` returns `multipart/x-mixed-replace`; the browser
decodes it natively inside an `<img>` tag.

**Why:** zero client-side decoding code, zero signalling, zero dependencies. It
works in every browser including Mobile Safari, which is the primary viewer.
Given AXe already caps at ~7–10fps, a better transport would not have produced
a better picture.

**Rejected:** WebRTC. Strictly better video, but it needs signalling, ICE, and
a real encoder upstream — none of which pay off while the *source* is a
screenshot loop. Revisit together with Phase 7, not before.

---

## 2026-04-24 — Random token in the URL as the entire auth model

**Chose:** a random 12-byte hex token generated at startup (or supplied via
`--token`), compared with `crypto.timingSafeEqual`, accepted as `?token=…` on
every HTTP route and on the WebSocket upgrade. `--auth false` disables it.

**Why:** the workflow is "paste a URL into a phone browser and look at it." A
login form, an account, or an identity provider would each break that in one
step. A capability URL is the cheapest thing that survives being exposed.

**Cost accepted:** the token is visible in the URL bar, in browser history, and
in anything that syncs history or screen-shares the page. It never expires.
This is the weakest part of the design and is the reason Phase 5 exists.

---

## 2026-04-25 — Pluggable remote-access providers (`prepare` / `start` / `stop`)

**Chose:** a `PROVIDERS` map in `remote.js`, each entry implementing three
lifecycle hooks, selected by `--remote <name>`. Adding a provider is one map
entry and no changes anywhere else.

**Why:** LAN, Tailscale Serve, and Tailscale Funnel differ only in how the
tunnel is established and what URL comes back. Encoding that as a small
interface keeps `server.js` unaware of tunnelling entirely, and makes
`cloudflared` / `ngrok` (Phases 6, 8) additive rather than invasive.

**Rejected:** hardcoding a `--tailscale` boolean. Would have needed reopening
for every subsequent provider.

---

## 2026-05-12 — Build vs. adopt: keep `sim-stream` over SimCast

**Chose:** keep the home-rolled stack. Full report:
`docs/research/2026-05-12-simcast-evaluation.md`.

**Why, in order of weight:**
1. **Auth model mismatch.** SimCast keys its realtime channel to one Supabase
   user that both the macOS app and the web dashboard must sign into. There is
   no token-URL share story, and no equivalent of the Funnel flow that sends a
   working URL to someone outside your tailnet.
2. **Bring-up cost.** A Supabase project, two hand-applied SQL migrations, an
   edge function with three secrets, a LiveKit Cloud project, and a Vercel
   deploy — versus `npm i && node server.js`.
3. **Vendor coupling.** Hard-bound to Supabase (auth + realtime + Postgres +
   storage + functions) and LiveKit Cloud. Neither is swappable.
4. **Repo health.** 3 stars / 0 watchers / 2 forks, ~7 weeks old at evaluation,
   schema still moving by their own admission.
5. **Their advantage is severable.** 60fps WebRTC is a discrete upgrade we can
   build ourselves without adopting their architecture.

**Revisit if** requirements move toward multi-simulator dashboards, a
team-shared recording library, high-framerate capture we don't want to build,
or an operator console with command-lifecycle logs.

**Worth stealing regardless** (now Phases 7–8): the SCK/WebRTC capture
pipeline, a screenshot gallery, and tap-by-accessibility-label.

---

## 2026-07-31 — Milestone placed after security hardening, not after the framerate rewrite

**Chose:** `🏁 MILESTONE: Safe public sharing` sits after Phase 6, so the
autopilot stop point is token/session hardening plus the SSO-gated Cloudflare
providers. The ScreenCaptureKit/WebRTC rewrite (Phase 7) and the borrowed
conveniences (Phase 8) are post-milestone.

**Why:** `--remote tailscale-funnel` already puts a publicly reachable URL on
the internet where a non-expiring token in the URL bar is the only gate. That's
the one open item with a real downside if left alone. Framerate is a
capability gap; token exposure is a live risk.

**Alternatives considered:** framerate-first (biggest single win, but weeks of
Swift + signalling work and no risk reduction), quick-wins-first (days of work,
purely additive), and no-milestone-it's-finished.

---

## 2026-07-31 — Doc-contract adoption: relocations and merges

**Chose:** `simcast-evaluation.md` moves to `docs/research/` with a date prefix
rather than being merged into this file. Its verdict is indexed above as the
2026-05-12 entry; the full report stays a dated evidence artifact.

**Why:** the contract reserves `docs/research/` for dated evidence reports and
this file for decisions plus rationale. Folding an 11 KB comparison into a
decision log would have made the log unreadable and lost the report's identity
as a point-in-time snapshot (its repo-health numbers are explicitly
re-check-before-reuse).

Also decided during the same pass: the README's `### Roadmap` section became
plan prose in `docs/ROADMAP.md` plus checklist items in `PROGRESS.md`, since
the contract permits exactly one live checklist and bans planning state in the
human front door.
