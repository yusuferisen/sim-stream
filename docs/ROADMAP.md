# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–4: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation) have been pruned from here. Their narrative is in
> `docs/JOURNAL.md`, their rationale in `docs/DECISIONS.md`, and the system as
> built is described in `docs/OVERVIEW.md`.

---

## Phase 5 — Token & session hardening

**The problem.** The auth model is a capability URL: one random token, valid
forever, carried in the query string. That was a deliberate trade for
paste-into-a-phone ergonomics (`DECISIONS.md § Random token in the URL`), and
it's fine on a LAN. It stops being fine the moment `--remote tailscale-funnel`
puts the same URL on the public internet, where the token is visible in the URL
bar, in browser history, in history sync, and in any screen-share of the page.

**Scope.**

- **Cookie handoff on first load.** Authenticate once from `?token=…`, set an
  `httpOnly` cookie, then redirect to a clean URL. Subsequent requests —
  including the `/stream` MJPEG connection and the `/ws` upgrade — authenticate
  from the cookie. The token stops being shoulder-surfable and stops landing in
  history. The `x-token` header **stays**: a header never reaches the URL bar,
  history, or a screen-share, so it is the safest of the three channels, and
  it's the scripted/`curl` path.
- **Per-share, time-limited tokens.** Mint a token that expires after N hours,
  so a Funnel URL handed to someone for a demo stops working on its own.
  Implies more than one live token at a time, which the current single-`TOKEN`
  comparison doesn't model — the server needs a small registry (value, expiry,
  label) rather than one constant. **In-memory, minted at startup** via
  repeatable flags; the registry dies with the process, which makes restarting
  a guaranteed revoke-everything. No mint-over-HTTP: a token that can mint
  successors defeats expiry as a boundary.

**Out of scope.** Accounts, an identity provider, or any login UI. The whole
point of the design is that a URL is the credential; these items make the
credential leak less and expire, not turn it into a session system.

**Watch for.** The WebSocket upgrade and the MJPEG stream authenticate on
separate paths from the page load, so all three have to agree on the cookie —
a partial conversion that leaves `/ws` on query-string auth would silently keep
the token in the URL.

---

## Phase 6 — Cloudflare quick tunnel

**Why.** A second exit route that needs no account at all. `cloudflared tunnel
--url http://127.0.0.1:<port>` mints an anonymous `trycloudflare.com` hostname
on the spot — useful when Tailscale isn't installed, when its macOS GUI-agent
path is hanging (a failure we've already hit), or when you want Cloudflare's
larger edge in front of the stream.

**Scope.** One `PROVIDERS` entry implementing `prepare` (bind `127.0.0.1`),
`start` (spawn the tunnel, parse the assigned hostname out of its output,
return the URL), and `stop` — **`stop` is mandatory here**: the tunnel is a
long-lived child process and without teardown it outlives the server.

**Trade-off to settle before recommending it.** MJPEG is a single long-lived
`multipart/x-mixed-replace` response and Cloudflare's edge may buffer it —
which would surface as a stalled first frame or visible stutter. Verify against
a real tunnel; if it buffers, say so in the README rather than quietly shipping
a worse path than Tailscale.

**Out of scope.** Installing `cloudflared` — treat a missing binary the way
`start.sh` already treats a missing `axe`: fail immediately with the install
command, don't attempt a download.

---

## 🏁 Milestone: Safe public sharing

The stop point. After Phase 6, exposing this tool beyond the LAN no longer
rests on a permanent secret parked in a URL bar: the credential rides in an
httpOnly cookie, share links expire on their own, and killing the process
revokes every outstanding link. Everything past here is capability, not risk
reduction.

---

## Phase 6b — Gated public sharing (Cloudflare Access)

**Deferred past the milestone, deliberately** — see `DECISIONS.md § Phase 6.2
deferred`. This is the only option where a leaked URL *and* a leaked token
still don't get someone in: a *named* Cloudflare tunnel on a domain you own,
with Cloudflare Access (email magic link / OAuth / IP rules) in front. Free up
to 50 users.

**Why it isn't in the milestone.** It requires a domain on a Cloudflare
account, which doesn't exist yet. The phase could be written but not verified,
and an unverifiable item shouldn't gate a stop point.

**Prerequisite before this phase can start:** a domain on Cloudflare, a named
tunnel, and an Access policy. All one-time manual setup — documented like the
Tailscale prerequisites, never automated.

**Note on intent.** This phase is the reason `docs/PRD.md` principle 2 was
amended: it puts a login in front of the stream, which the original inferred
wording banned outright. The settled position is that a gate is legitimate as
an *opt-in per-share choice* and never as the default path.

---

## Phase 7 — Capture pipeline (ScreenCaptureKit → WebRTC)

**The ceiling.** AXe's `stream-video` is a screenshot loop; real throughput is
~7–10fps no matter what `--fps` says. That's adequate for "did the button
land in the right place" and inadequate for anything about motion — animation
review, scroll feel, gesture responsiveness.

**Scope.** A small Swift helper that captures the Simulator window with
ScreenCaptureKit, hardware-encodes with VideoToolbox, and feeds a WebRTC
transport, replacing the MJPEG path. This is the one genuine advantage SimCast
demonstrated, and the evaluation concluded it's severable from their
architecture — build the helper, keep everything else.

**Explicitly not.** Adopting LiveKit, Supabase, or any hosted service. The
evaluation rejected that re-platforming on auth-model and bring-up grounds
(`DECISIONS.md § Build vs. adopt`), and none of those grounds have moved.

**Sequencing note.** This is the largest item on the roadmap by a wide margin —
a new language in the repo, a new build step, and signalling that the current
transport doesn't need. Worth confirming the framerate threshold actually
bites (see `PROGRESS.md § Open Decisions`) before starting.

---

## Phase 8 — Borrowed conveniences

Small, independent, additive. None of them changes the architecture; each can
land alone.

- **Screenshot gallery.** Screenshots currently drop into
  `~/Desktop/sim-stream-<timestamp>.png` and are immediately hard to find. A
  `~/Desktop/sim-stream/` directory plus a served index page with a thumbnail
  grid covers the actual need. SimCast's `pending → ready/failed` persistence
  lifecycle is overkill here — stay on the filesystem.
- **Tap by accessibility label.** AXe already exposes the simulator's
  accessibility tree. Type a label, the server resolves it to coordinates and
  dispatches a tap. Directly useful for verifying agent-built UI without
  hunting for pixel positions.
- **`ngrok` provider.** Same provider shape as Phase 6, useful for a one-off
  share without a Cloudflare account.

**Open question carried from the evaluation.** If the gallery ever wants to
sync across devices it reproduces exactly the persistence problem that made
SimCast unattractive. Keep it local.
