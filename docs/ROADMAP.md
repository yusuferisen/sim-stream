# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–5: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation, token & session hardening) have been pruned from
> here. Their narrative is in
> `docs/JOURNAL.md`, their rationale in `docs/DECISIONS.md`, and the system as
> built is described in `docs/OVERVIEW.md`.

---

## Phase 6 — Cloudflare quick tunnel

**Why.** A second exit route that needs no account at all. `cloudflared tunnel
--url http://127.0.0.1:<port>` mints an anonymous `trycloudflare.com` hostname
on the spot — useful when Tailscale isn't installed, when its macOS GUI-agent
path is hanging (a failure we've already hit), or when you want Cloudflare's
larger edge in front of the stream.

**Scope.** One `PROVIDERS` entry implementing `prepare` (bind `127.0.0.1`),
`start` (spawn the tunnel, parse the assigned hostname out of its output,
return the token-free base URL — the server adds the tokens), and `stop` — **`stop` is mandatory here**: the tunnel is a
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
