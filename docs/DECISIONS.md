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

**`docs/JOURNAL.md` keeps its commit shas.** The doc contract says "no commit
sha," but its stated rationale is that a commit cannot contain its own sha —
which doesn't reach the *prior* shas cited in the reconstructed Phase 1–4
entries. They're the fastest route from a phase entry to the code that landed
it. Recorded here so a later conformance pass doesn't strip them and start a
loop.

---

## 2026-07-31 — PRD verified and amended (principle 2, hosted-infrastructure scope)

**Chose:** accept the reconstructed `docs/PRD.md` as intent of record, with two
corrections; the file is frozen from here.

**Why the correction was needed:** the inferred principle 2 contradicted itself
("access control may get stronger — *an SSO check in front of the tunnel* — but
must never become a login the viewer has to complete") and, read strictly,
banned the `cloudflare-access` provider outright. So did the out-of-scope line
"hosted infrastructure of any kind — auth providers." That provider was **the
author's own roadmap item**, carried over from the README — so the inference
was wrong, not the plan. Between a principle I derived from code and a feature
the author wrote down, the principle yields.

**Settled position:** a gate in front of a tunnel is legitimate as an *opt-in,
per-share* choice. What stays banned is a login being the *only* way in, or any
hosted service standing between the operator and a simulator on their own
machine or LAN. `sim-stream` must always run and be usable with nothing but
`npm i && node server.js`.

**Note:** this also keeps the SimCast rejection coherent. That verdict turned on
sign-in being **mandatory and mutual** (both ends into one Supabase account,
with no token-URL path at all) — not on the mere existence of an auth option.

---

## 2026-07-31 — `x-token` header retained through the cookie migration (5.1)

**Chose:** keep the `x-token` request header as an accepted credential on HTTP
routes when Phase 5.1 introduces the cookie. Document it; don't remove it.

**Why:** Phase 5 exists because a query-string token leaks — into the URL bar,
browser history, history sync, and screen-shares. A **header leaks through none
of those**, so it is the *safest* of the three channels, not a weakness. It uses
the same constant-time comparison as every other path, and it's the only
practical way to hit `/api/info` from a script.

**Rejected:** removing it (would break scripted access to buy nothing —
the browser client never sends it, so it isn't part of the leak surface) and
hiding it behind an opt-in flag (a thirteenth flag guarding a non-risk).

**Carries an obligation:** the two check sites are asymmetric — `authCheck`
takes query-or-header, the WS upgrade takes query only. Any future change to
credential handling must touch both and account for the header.

---

## 2026-07-31 — Share tokens: in-memory registry, minted at startup (5.2)

**Chose:** replace the single `TOKEN` constant with a small in-process registry
of `{value, expiry, label}`, populated at startup from repeatable flags. No
persistence, no mint-over-HTTP.

**Why:**
- **Dying with the process is the feature.** Restarting the server revokes every
  outstanding link, which gives a guaranteed kill switch with no revocation
  machinery to build or trust.
- **No durable state.** The tool has none today; adding a token file would make
  a leaked link outlive the process you'd kill to stop it.
- **A mint endpoint would defeat expiry.** If a valid token can create fresh
  tokens, a leaked link renews itself indefinitely and the expiry boundary is
  decorative.

**Rejected:** an authenticated HTTP mint endpoint (convenient — mint a share
from the browser — but self-defeating per above) and a persisted JSON registry
(shares survive restarts, at the cost of the revoke-by-restart guarantee).

---

## 2026-07-31 — Phase 6.2 deferred past the milestone; Phase 6 narrowed to quick tunnels

**Chose:** the `cloudflare-access` provider moves out of the milestone into a
new **Phase 6b**, labelled with a letter rather than renumbering (shipped and
referenced labels are identifiers). Phase 6 keeps only the `cloudflared`
anonymous quick tunnel.

**Why:** Access needs a named tunnel on a domain the author owns, and no such
domain exists. The phase could be *written* but not *verified* — and an
unverifiable item must not gate a stop point. Quick tunnels need no account at
all, so 6.1 is unblocked and still delivers a second exit route.

**Consequence for the milestone:** "Safe public sharing" now means cookie
handoff + expiring links + a second tunnel provider. The strongest guarantee (a
leaked URL *and* a leaked token still don't get in) arrives in 6b, later.

**Also settled (reversible, logged for completeness):** a missing `cloudflared`
binary fails immediately with the install command, mirroring how `start.sh`
already handles a missing `axe`. No auto-download.

---

## 2026-07-31 — 5.2 tagged `[model: fable]`; 5.1 left untagged

**Chose:** tag only sub-phase 5.2 with `[model: fable]`.

**Why:** the two halves of Phase 5 fail differently. 5.1 fails **loudly** — the
token either leaves the URL or it doesn't, auth either works or it doesn't, and
a browser reload shows you which. 5.2 fails **silently**: an off-by-one on
expiry means links you believe are dead still work, and nothing surfaces it.
Silent-failure work is what the stronger model is for.

**Cost accepted:** Fable is billed at API pricing, outside the subscription, so
a session on another model halts at 5.2 by design.

**Rejected:** tagging both (roughly double the spend for work whose failures are
self-announcing) and tagging neither (defensible — this is ~100 lines of Node in
a personal tool with no accounts or user data — but expiry is precisely the
piece worth paying for).
