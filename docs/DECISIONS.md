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

---

## 2026-09-30 — Cookie handoff mechanics (5.1)

**Chose:** an authorized `GET /?token=…` sets `sim_stream_<PORT>` (the token
value itself; `HttpOnly; SameSite=Lax; Path=/`, `Secure` only over https) and
302s to the token-free URL. One `requestAuthorized()` serves both check sites
and accepts query, `x-token`, or cookie at each — so the WebSocket upgrade now
also takes `x-token`, and the asymmetry the `x-token` decision warned about is
gone.

**Why:**
- **`Lax`, not `Strict`.** The link is typically opened from another app
  (Messages, Slack); `Strict` withholds the cookie on that cross-site redirect
  and the first load would land on `401`.
- **Port in the name.** Cookies are host-scoped; two servers on one Mac would
  otherwise clobber each other's cookie and log each other out.
- **The token as the cookie value, not a session id.** No server-side session
  table to keep in sync; whatever validity rule governs the token (5.2's
  expiry) governs the cookie automatically.
- **Session cookie, no `Max-Age`.** The token never expires yet, so any
  lifetime would be arbitrary; 5.2 can align it with share expiry.
- **Conditional `Secure`.** A `Secure` cookie on plain http (LAN, localhost) is
  dropped, which would turn the redirect into a `401`.

**Rejected:** keeping `?token=` in the client's own requests (leaves it in the
page URL, the whole point is lost) and redirecting on every route (only the
page load is a navigation that lands in the address bar and history).

**Cost accepted:** a browser that blocks cookies for the host now gets `401`
after the redirect instead of working from the URL.

---

## 2026-09-30 — Share-token mechanics (5.2)

Builds on *Share tokens: in-memory registry, minted at startup (5.2)* above,
which fixed the shape; these are the choices made while building it.

**Chose:**

- **`--share [label=]<ttl>`, repeatable, unit mandatory** (`45s`, `30m`, `2h`,
  `1d`; max `365d`). A bare `30` is an error, not "30 hours": guessing the
  unit wrong in the long direction is the exact failure expiry exists to
  prevent. Labels default to `share-N`, must be unique, and `owner` is
  reserved.
- **The operator's own token stays process-lifetime.** It is registry entry 0
  with no expiry. Shares are for other people; the operator's link dying
  mid-session would be self-inflicted friction, and a restart already revokes
  it.
- **Expiry ends open connections.** `/stream` and `/ws` authorize once at
  connect, so without this an open tab keeps watching and driving the simulator
  indefinitely after its link "expired" — the link would be dead only for
  people who hadn't opened it yet. Each long-lived connection is tracked
  against its share and closed at the deadline (MJPEG destroyed, WebSocket
  `1008 "share expired"`), and input is re-checked per message.
- **Dead when either clock says so, and it latches.** Wall clock (what the
  banner promised; keeps counting through machine sleep) *or* monotonic clock
  (can't be set back). Once observed expired, an entry never revives. Every
  clock anomaly therefore shortens a share, never extends it.
- **One credential decides each request** — `?token=` if present, else
  `x-token`, else the cookie, no fall-through. This amends the 5.1 (cookie
  handoff) behaviour, where any matching channel was enough. With expiry that
  rule had a trap: the operator's browser holds the owner cookie, so an
  expired share link would still open *for the operator* — the one person
  checking whether it died. Now a dead `?token=` is `401` everywhere.
- **Providers return a token-free base URL.** `start({port}) → {url, note}`;
  the server appends `?token=…` per link. One link per share made "the
  provider formats the URL" untenable, and providers no longer see a secret at
  all.
- **The share clock starts at process start.** Tokens are minted during
  argument validation, before simulator boot. A slow boot shortens the share
  slightly (safe direction); the banner prints the absolute deadline.
- **A `node:test` suite for `shares.js`.** The registry was written as a pure,
  import-safe module so its boundary conditions can be tested without a
  simulator. Built-in runner, no new dependency.

**Rejected:** a bare number meaning hours (silent mis-set); a TTL on the owner
token (a second way to lock yourself out, no new safety); a periodic sweep
alone (up to a second of post-expiry input — hence the per-message check);
`ws.terminate()` instead of `close(1008)` (the client could not tell "expired"
from a network drop, and would retry forever); letting a valid cookie rescue a
dead link token (see above); `--share` silently ignored under `--auth false`
(now a startup error).

**Cost accepted:** no per-share revocation and no extension — restart is the
only lever, and it revokes the operator's link too. A stale bookmark carrying
an old `?token=` now gets `401` even if the browser still has a good cookie.

---

## 2026-09-30 — Phase 7 capture source: AXe raw frames, not ScreenCaptureKit

**Chose:** Phase 7 takes its frames from `axe stream-video --format bgra
--fps 30` and encodes them in a Swift/VideoToolbox helper. ScreenCaptureKit is
dropped from the phase. Settled with the owner in the Phase 7–8 pre-flight.

**Why:** the premise behind the original plan — "AXe's capture is a screenshot
loop capped at ~7–10 fps" (the 2026-04-24 AXe entry above) — turned out to be
true only of AXe's `mjpeg` mode. Measured on AXe 1.8.0, iOS 27, a headless
sandbox clone showing a static home screen, 6–8 s per run:

| Mode | Requested | Scale | Delivered |
|---|---|---|---|
| `mjpeg` | 10 fps | 1.0 | 8.8 fps (frames are ~3.6 MB PNGs labelled `image/jpeg`) |
| `mjpeg` | 30 fps | 1.0 | 9.5 fps |
| `mjpeg` | 30 fps | 0.5, quality 60 | 7.1 fps |
| `bgra` | 30 fps | 1.0 (1206×2622) | 30.4 fps |
| `bgra` | 30 fps | 0.5 (603×1311) | 28.6 fps |

So capture was never the bottleneck; the JPEG path is. And ScreenCaptureKit
does not fit this host at all: it captures a **visible Simulator.app window**,
and at the time of measurement Simulator.app was not running while seven
simulators were booted headless — which is how agents run them here. It would
also need a Screen Recording grant for whichever app launches the server, and
cropping of the window chrome and bezel before taps map correctly.

**Cost accepted:** AXe caps `--fps` at 30, so 30 fps is this design's ceiling
where ScreenCaptureKit could reach 60. `axe tap` also slowed from 1.6–2.0 s to
3.0–3.5 s while the raw stream ran — inside the queue's 5 s timeout, but to be
re-measured when the player lands.

**Rejected:** ScreenCaptureKit as written (cannot see headless simulators);
both sources at once (a second capture path to maintain before 30 fps has been
shown to be too little — add it as a lettered phase if that day comes).

**Also closes** the open question "when is ~7–10 fps no longer good enough to
justify Phase 7?" — the owner asked for the phase, and it is far cheaper than
the rewrite that question was guarding against.

---

## 2026-09-30 — Phase 7 transport: H.264 over WebSocket + WebCodecs; MJPEG stays

**Chose:** H.264 access units sent as binary messages on an authenticated
`/video` WebSocket and decoded in the browser with WebCodecs (`VideoDecoder` →
`<canvas>`). MJPEG is **kept** as the default-capable fallback rather than
replaced. Supersedes the WebRTC half of the 2026-04-24 MJPEG entry's "revisit
together with Phase 7". Settled with the owner in the pre-flight.

**Why:**
- **It travels wherever the page travels.** A WebSocket rides every route the
  tool already has, including the HTTP-only public tunnels. WebRTC media is
  UDP between peers: through Funnel, a Cloudflare tunnel or ngrok it needs a
  TURN relay, which is hosted infrastructure on the viewing path (PRD
  principle 3).
- **No new dependency.** The decoder is in the browser; the encoder is
  VideoToolbox. A WebRTC stack is a large library in either the helper or the
  server, in a project whose production dependencies are `express` and `ws`.
- **It reuses the auth and expiry machinery as-is** — `requestAuthorized()` at
  the upgrade, `ShareRegistry.track()` on the socket.

**Cost accepted:** browsers expose `VideoDecoder` only on secure contexts, so
a plain-http `--remote lan` link stays on MJPEG. `localhost`, Tailscale Serve
and Funnel, and the Cloudflare tunnel are https and get the H.264 path.

**Rejected:** WebRTC (above); fragmented MP4 into Media Source Extensions
(would also cover plain-http LAN, but adds a muxer, live-edge chasing and
roughly 0.2 s of delay, and is the most finicky of the three on iPhone Safari
— the likeliest to need a second pass in an unattended run); removing MJPEG
(it is what keeps `npm i && node server.js` a complete tool with no build).

---

## 2026-09-30 — `ngrok` provider parked as Phase 8b

**Chose:** the `ngrok` provider leaves Phase 8 and becomes **Phase 8b**, gated
on the owner's ngrok account — the same treatment, and the same lettering
rule, as Phase 6b.

**Why:** `ngrok` is not installed on the host and every ngrok tunnel now
requires an account and an authtoken, so the item cannot be verified
unattended; an unverifiable item must not sit inside a phase meant to run
without the owner. Its stated purpose — a one-off share without a Cloudflare
account — is already met by the Phase 6 quick tunnel, which needs no account.

**Carries an obligation:** the authtoken is a secret. It lives in the login
Keychain and reaches the provider as `NGROK_AUTHTOKEN`; the provider must not
write it to a repo file or to ngrok's config file.

**Rejected:** dropping the item (the owner kept it) and leaving it in Phase 8
(a guaranteed halt at the end of the run).

---

## 2026-09-30 — 7.2 tagged `[model: fable]`; the rest of Phases 7–8 untagged

**Chose:** tag only 7.2 (the H.264 hub and `/video` endpoint).

**Why:** same reasoning as the 5.2 tag — it is the slice that fails
**silently**. `/video` is a new long-lived entry point: a missed auth check is
an open door, a missed `track()` lets an expired share keep watching, and the
hub's refcount/generation guards are concurrency invariants that break without
throwing. 7.1 fails loudly (`ffprobe` reads 30 fps or it doesn't), 7.3 fails
visibly in the browser, and Phase 8 is small additive work.

**Cost accepted:** one sub-phase draws the capped Fable share of the plan.
(The 5.2 entry's "billed at API pricing" is out of date: Fable has been inside
the plan, capped, since 2026-08.)

**Rejected:** tagging all of Phase 7, and tagging nothing.

---

## 2026-09-30 — Phase 7–8 defaults (reversible, chosen in the pre-flight)

Logged so the run does not stop to ask. Each is cheap to change later.

- **Swift/VideoToolbox helper rather than `ffmpeg`** for the encode. Any host
  with simulators has the Xcode toolchain; `ffmpeg` would be a third required
  binary. `ffmpeg`/`ffprobe` remain fine as *verification* tools.
- **The helper is optional.** Not built, or no `swift`: the server serves MJPEG
  exactly as today with one log line. `start.sh` builds it when `swift` is on
  PATH. This is what keeps PRD principle 1 intact. 7.1 ships the package and
  `npm run build:helper`; 7.2 owns the `start.sh` step and the server's
  startup check.
- **Stream shape:** 30 fps, size following the existing `--scale` flag, a
  keyframe every second, no B-frames. One second bounds a joiner's wait even
  without the hub's cache.
- **Gallery is owner-only.** A share link lets someone drive the simulator for
  a while; it should not also expose every screenshot taken before it existed.
  Under `--auth false` there is no owner credential, so the gallery is open
  like every other route.
- **Thumbnails via `sips`**, cached under `~/Desktop/sim-stream/.thumbs/`.
  Existing `~/Desktop/sim-stream-*.png` files are left where they are.
- **Tap-by-label passes through to `axe tap --label`** (`#name` → `--id`)
  instead of resolving coordinates in the server: AXe 1.8.0 does the lookup,
  taps the element's activation point, and reports "no match" and "multiple
  matches" itself. Those errors are shown, never resolved by guessing.

---

## 2026-09-30 — H.264 hub mechanics (7.2)

Choices made while building the hub and `/video`; all reversible.

- **`/video` forwards the helper's records unchanged**, one per binary message,
  after a single JSON `config` message carrying the codec string. The 16-byte
  header already holds what a decoder needs per frame (key/delta, timestamp),
  so re-framing would only add a second format to keep in step. The server
  reads the codec string out of the SPS so the browser needs no bitstream
  parsing. *Rejected:* a custom per-message header; advertising the codec in
  `/api/info` (it is only known once the encoder has produced a keyframe).
- **`--fps` is shared, with split defaults.** Not given: MJPEG stays at 15,
  H.264 runs at 30 (the pre-flight's stream shape). Given: it sets both. Values
  outside the helper's ranges are clamped with a log line; a non-number turns
  H.264 off. *Rejected:* a second flag (`--video-fps`) — another knob for one
  idea, "how fast to capture"; rejecting out-of-range values at startup — it
  would break `--fps`/`--scale` invocations that work today for MJPEG.
- **A lagging viewer is skipped forward, then dropped.** More than about two
  seconds of video unsent in its socket → nothing more until a keyframe finds
  the backlog mostly drained; still behind after 10 s → closed with `1013`.
  The second half is what stops a vanished phone from holding the 30 fps
  capture (and its cost to tap latency) for the minutes TCP takes to notice.
  *Rejected:* dropping frames without the keyframe rule (undecodable); queueing
  (unbounded); closing at the first sign of lag (a brief stall would cost a
  reconnect and a respawn).
- **Hub close codes are `1011` (capture ended) and `1013` (too slow)** — never
  `1006`/`1008`, which the client reads as a bad credential.
- **Without the helper, an authorized `/video` upgrade answers `404`**, after
  the credential check — an unauthenticated caller learns nothing about what is
  built.
- **The screen's pixel size is measured once, at startup**, from a screenshot
  written to a temp file (`simctl io screenshot -` writes a file named `-`; it
  does not mean stdout). A failed measurement means MJPEG only for that run
  rather than a retry on first connect: `/api/info` must be able to state the
  picture size before anyone connects.
- **`start.sh` builds the helper only when it is missing or older than its
  sources**, so an ordinary start pays nothing; a failed build is printed and
  skipped.
- **The hub lives in the pure module, not in `server.js`.** The roadmap asked
  for the parser, cache and drop logic to be import-safe; the refcount and
  generation rules went with them, behind an injected `spawnPipeline`, because
  they are the part that fails silently and the part MJPEG's hub has never had
  a test for.
- **Two crash paths in the shared WebSocket entry were closed here**, since
  `/video` was about to inherit them: a malformed `Host` header on any upgrade
  request threw out of the handler (no credential needed), and a protocol-
  invalid frame on `/ws` was an unhandled `error` event. Both killed the
  process. Now an invariant in `docs/architecture.md`.

---

## 2026-09-30 — Browser player mechanics (7.3)

Choices made while building the page's H.264 player; all reversible.

- **One H.264 attempt per page load; any failure means MJPEG until reload.**
  Decoder refusal or error, a malformed record, the `/video` socket closing
  (refused, `1011`, `1013`), no frame for 8 s after connecting or 4 s after the
  first. *Rejected:* retrying H.264 with backoff — every connect after a
  pipeline death respawns AXe and the encoder, and a page that flips between
  surfaces is worse than a steady slow one; running MJPEG alongside while H.264
  starts — two capture processes cost tap latency (PRD principle 5, input
  over smoothness) for a blank second saved.
- **A hidden tab closes `/video` and rejoins when shown**; a page opened in the
  background waits. Saves the 30 fps capture while nobody watches and sidesteps
  browsers reclaiming background decoders (which would otherwise force the
  MJPEG fallback). *Rejected:* keeping the socket open while hidden.
- **The header label names the live path** (`H.264` / `MJPEG`) and its tooltip
  gives the reason for a fallback — no toast, since falling back is normal on
  plain-http links.
- **The canvas is stretched over the device-aspect wrap** (`object-fit: fill`),
  so the even-cropped picture maps onto the whole screen and the shared overlay
  needs no per-surface math.
- **Coordinate taps use `axe tap --tap-style physical`.** Found while verifying
  that taps still land: AXe 1.8.0's default for a coordinate tap
  (FBSimulator `tapAt`) acks but does nothing on iOS 27 simulators, directly
  from the CLI as well; the touch down/up style lands. Swipes and long-presses
  already use touch events. *Cost:* an AXe too old to know `--tap-style`
  fails every tap with its own error rather than silently.

---

## 2026-09-30 — Screenshot gallery mechanics (8.1)

Choices made while building `/gallery`; all reversible.

- **File names are local date and time to the millisecond**
  (`sim-stream-2026-09-30-140503-042.png`) instead of the old epoch
  milliseconds: readable in Finder, and they sort by time as text.
- **A failed thumbnail serves the full image**, not an error — `sips` is
  built into macOS, so this only matters when it is broken, and a slower page
  beats a grid of broken images.
- **`/gallery` does the same cookie handoff as `/`** (one `cookieHandoff`
  middleware): opened as `/gallery?token=…` in a fresh browser, the page's
  image requests would otherwise carry no credential and all fail.
- **Share viewers are refused with `403`, not `401`** — they are
  authenticated, just not the owner — and the page hides its gallery link from
  them (`/api/info` → `gallery: false`).
- **A final Express error handler replaces the default error page.** Found in
  review: `:name` is decoded before `authCheck`, so an unauthenticated
  `/gallery/file/%E0%A4%A.png` got Express's development error page with a
  stack trace and server paths. *Rejected:* `NODE_ENV=production` — it would
  depend on how the server is started.
- **The gallery stays on the local filesystem** (carried from the SimCast
  evaluation, § Build vs. adopt). Syncing it across devices would reproduce
  exactly the persistence lifecycle that made SimCast unattractive.

---

## 2026-09-30 — Tap-by-label mechanics (8.2)

Choices made while building the `tap-label` input event; all reversible.

- **Arguments go as `--label=<text>` / `--id=<name>`**, not two argv entries:
  AXe's parser reads a separate value that starts with `-` as another flag
  (`--label -x` → "Missing value"). Measured on AXe 1.8.0.
- **The toast shows AXe's `Error:` line minus its generic advice** ("Make sure
  the app is on the expected screen, then run `axe describe-ui` …"). The full
  output stays in the server log. Cut at that phrase, not at the first full
  stop, so a label like `Mr. Smith` survives; unknown output is shown whole.
- **A 15 s queue timeout for label/id taps**, 5 s for everything else. A miss
  normally answers in under 1 s, but one took 7 s during a screen transition,
  and a timeout would replace AXe's message with "timed out". A slow lookup
  holds the FIFO queue for that long — accepted, since it is the viewer's own
  deliberate action. *Rejected:* `--wait-timeout` polling — it would hold the
  queue by design.
- **A leading `#` always means an identifier.** No escape for a label that
  itself starts with `#`; use a coordinate tap for that rare case.
- **Error toasts stay up in proportion to their length** (45 ms per
  character, 2.5–8 s) — AXe's multiple-match message is ~190 characters.

---

## 2026-09-30 — `cloudflared` provider mechanics (6.1)

**Chose:** the quick-tunnel link is printed only after cloudflared registers a
connection **and** the hostname answers at trycloudflare.com's authoritative
nameservers; the DNS wait is bounded (15 s) and never fatal.
**Why:** measured — the name reaches DNS ~2 s after registration, and a link
opened sooner gets NXDOMAIN cached for the zone's 60 s negative TTL, so the
first viewer sees "server not found" for a minute. Polling the authoritative
servers caches nothing anywhere. **Rejected:** a fixed sleep (guesses the lag);
polling the system resolver (would poison the host's own cache — observed).

**Chose:** echo only tunnel-level `ERR` lines after start; skip per-request ones
(`dest=` / `originService=`). **Why:** every expired share and closed tab cuts a
stream mid-body and cloudflared logs an `unexpected EOF` for it — noise. A
tunnel-level error is the one explanation for every viewer dropping at once,
which was seen once on a real tunnel.

**Chose:** `stop` = SIGTERM, SIGKILL after 1 s, plus `--grace-period 1s`, plus a
synchronous exit hook. **Why:** cloudflared's default 30 s grace waits for
in-flight requests, and the MJPEG response never ends; the exit hook covers the
`process.exit` paths that skip `stop`.

**Settled by measurement:** Cloudflare's edge does **not** buffer MJPEG (same
frame rate and gaps as `localhost`), so the README recommends the quick tunnel
as an equal public route beside Funnel — no caveat needed.

---

## 2026-09-30 — Real devices join the tool as a second backend (PRD deviation)

**Chose:** add a **real-device backend** — a USB-tethered iPhone or iPad from
the QA bench, driven through the WebDriverAgent stack the bench already runs —
behind a seam that the existing simulator code moves behind first. Phase 9.
Settled with the owner after a measurement spike on the primary bench iPhone
(16e, iOS 26.6.2).

**Why:** the wedge — open a link on whatever is in your hand and drive the
thing an agent just built — applies to a real device at least as much as to a
simulator, and the measured numbers say a real device is the *more*
responsive target:

| | Bench iPhone via WebDriverAgent | Simulator (today) |
|---|---|---|
| Picture | 29 fps JPEG from WDA's built-in MJPEG server (½ scale, q60: ~4.4 MB/s; full: ~10.6 MB/s; at 10 fps: ~1.5 MB/s) | 30 fps H.264 / ~7 fps MJPEG |
| First frame | < 0.1 s | ~0.5 s |
| Tap (W3C actions) | ~0.5 s | 1–2 s |
| Home button | 0.5 s | uncertain on iOS 27 |
| Screenshot | 0.33 s | ~0.5 s |

**PRD deviation, recorded here because the PRD is frozen:** `docs/PRD.md`
scopes the tool to "a single running iOS Simulator". The scope becomes *one
simulator **or** one prepared physical device per server*. Every principle
holds unchanged: a URL is still the credential, nothing hosted is required,
one process, input correctness over smoothness. What does **not** change:
"one at a time", no accounts, no multi-device dashboards.

**Rejected:**
- **The QuickTime-mirror capture device** (the iPhone screen as a macOS
  AVFoundation "muxed" device, 60 fps H.264 over USB). Enabled at the
  CoreMediaIO level with the phone awake and unlocked, it does not enumerate
  on macOS 27 / iOS 26.6 — only Continuity Camera devices appear. A USB-level
  reimplementation (`qvh`) exists but needs exclusive device access, which
  would fight the bench tunnel, and is untested on current iOS.
- **go-ios's own MJPEG stream** (`ios screenshot --stream`): 2.7 fps.
- **A separate tool.** Auth, shares, tunnels, the player, the gallery and
  tap-by-label are all target-agnostic; only capture, input, bounds and
  screenshot know what they are driving. A seam is the honest shape.

**Consequence:** `docs/architecture.md` gains a backend contract when 9.1
lands; `docs/OVERVIEW.md` and the README gain device usage when 9.2 lands.

---

## 2026-09-30 — Device backend mechanics (Phase 9 defaults, reversible)

Chosen in planning so the run does not stop to ask. Each is cheap to change.

- **Video source is WDA's MJPEG server** (device port 9100, reached through
  `ios forward`), fed into the existing `MjpegHub`. Frame rate, scale and
  quality come from the same `--fps` / `--scale` / `--quality` flags, applied
  as WDA session settings (`mjpegServerFramerate`, `mjpegScalingFactor`,
  `mjpegServerScreenshotQuality`).
- **H.264 for devices reuses the Phase 7 helper** with a JPEG input mode
  (decode → VideoToolbox), so remote viewers get the low-bandwidth path. It is
  the last slice; the MJPEG path stands alone before it.
- **Selection:** `--device <udid>` with `--wda <url>` (default
  `http://localhost:8100`). When `qa-device` is on PATH, `--device
  primary|secondary|tablet` resolves both. `--device` and `--udid` are
  mutually exclusive: one target per process, as before.
- **The tool does not start WDA or the tunnel.** Missing WDA fails at startup
  with the command that fixes it (`qa-device up <role>`), the same policy as a
  missing `axe` or `cloudflared`. `ios` (go-ios) becomes a required binary
  **for device mode only**.
- **Bounds come from WDA** (`/window/size`, points) — not the hand-maintained
  `boundsForDeviceType` table, which stays simulator-only.
- **Input maps 1:1 onto today's event set** (tap, long-press, swipe, type,
  key, button, tap-label) so the client does not change. Multi-finger
  gestures, which WDA could do and the simulator cannot, are **out of scope**
  for Phase 9 — a later, client-visible addition.
- **Wake before input:** the bench devices auto-lock after 3 min; the backend
  checks `/wda/locked` and unlocks (they are passcode-free) before dispatching.
- **Never a personal device.** The README states it; the tool cannot enforce
  it. The bench rule (`~/.dotfiles/docs/device-bench.md`) is the guard.

**Rejected:** starting WDA from the tool (Xcode signing and device trust are
one-time owner work, not something a server should retry); a device-specific
client (the whole point is that the page does not care).

---

## 2026-09-30 — 9.1 tagged `[model: fable]`; the rest of Phase 9 untagged

**Chose:** tag only 9.1, the backend seam.

**Why:** it is the one slice that refactors *working* code — every simulator
path moves behind an interface, and the simulator has no automated coverage
beyond the import-safe modules. A regression there fails silently until the
manual checklist runs. 9.2–9.4 are new code against a live device, where
failures are loud (no picture, tap doesn't land, `ffprobe` disagrees).

**Rejected:** tagging nothing (cheapest; the gatekeeper's manual checklist
would be the only net under the refactor) and also tagging the input slice
(coordinate mistakes there are visible on the device at once).

---

## 2026-09-30 — Phase 9 pre-flight defaults (reversible, chosen by `/clarify`)

Small calls a fresh session would otherwise have to make mid-run. Each is
cheap to change.

- **Forwarded MJPEG port:** the backend asks the OS for a free host port for
  `ios forward` rather than hardcoding 9100 on the host, so two servers (or a
  stray forward) cannot collide. The device side stays WDA's default 9100.
- **Device identity** for the banner and the `hello` frame comes from
  `ios info --udid` (`DeviceName`, `ProductType`; go-ios is required in device
  mode anyway). WDA's `/wda/device/info` is only a fallback: on the bench it
  reports the generic `iPhone` / `iPhone`.
- **Special keys:** map what WDA's `/wda/keys` can express (return, delete,
  tab, space); refuse the rest with an error ack rather than sending a
  best-guess character.
- **Hardware buttons on a device:** `home` → `pressButton home`; `lock` and
  `side-button` → `/wda/lock` (they are the same button on a device); `siri`
  → `/wda/siri/activate`; `screenshot` unchanged; `apple-pay` refused with an
  error ack (no WDA equivalent). Volume buttons exist in WDA but not in the
  client — not exposed in Phase 9.
- **Helper JPEG input:** decode with ImageIO (simplest, fast enough at ½
  scale), locate frames by scanning for JPEG SOI/EOI markers so the helper
  does not care about multipart headers, and take the pixel size from the
  first frame's SOF header. **The server fetches** the forwarded MJPEG over
  HTTP and pipes the body into the helper's stdin; the helper stays
  stdin-only with no networking. 4–10 MB/s through Node is fine — the
  "never through Node" rule guards the 95–380 MB/s raw BGRA path, not this.
- **WDA session recovery:** on a `404`/invalid-session answer, re-create the
  session and retry the request once; a second failure surfaces as an error
  ack. Never a retry loop.

---

## 2026-09-30 — Device video mechanics (9.2, reversible)

Small calls made while building the device backend. Each is cheap to change.

- **Device MJPEG defaults to 30 fps** (simulator stays 15). WDA's server keeps
  up (27–28 fps measured at scale 0.5), and 9.2's bar is ≥25 fps with no flags.
  An explicit `--fps` still wins.
- **The forward is proven before the server listens.** Startup GETs the
  forwarded port until it answers `200 multipart/x-mixed-replace`; any other
  answer fails at once, and go-ios's own bind failure is checked *after* an
  answer, so a stranger holding the port is never streamed. The boundary comes
  from that header rather than a constant.
- **A dead forward is not respawned.** `openMjpeg()` throws and the log says
  to restart the server. A replug usually strands the bench's tunnel too
  (`qa-device up` fixes both); auto-respawn can come later if it bites.
- **`--wda` without `--device` is refused** rather than ignored, like `--share`
  without auth.
- **Startup failures of either backend print one line and exit 1** instead of
  a stack trace.

**Rejected:** hardcoding WDA's boundary (it would silently break on a WDA that
changes it); polling a non-MJPEG answer until the timeout (it cannot become
WDA's stream).
