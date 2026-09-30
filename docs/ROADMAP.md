# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–5: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation, token & session hardening; 7: the 30 fps H.264
> capture pipeline and browser player) have been pruned from here. Their narrative is in
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
a worse path than Tailscale. On the same tunnel, confirm that a short `--share`
link still cuts the stream at its deadline — expiry has to hold through the
edge, not just on the LAN. The tunnel is also the first https route to a
real iPhone, so check the H.264 player there too: the header should read
`H.264` in iPhone Safari and taps should still land.

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

## Unscheduled — 30 fps on plain-http LAN

Plain-http links (`--remote lan`) stay on ~8 fps MJPEG, because browsers decode
H.264 only on secure contexts. The encoder helper could emit JPEGs instead of
H.264 and feed the existing MJPEG path at 30 fps, closing that gap with no
browser changes. It costs roughly 25 Mbit/s, so it suits the LAN and nothing
else. If LAN smoothness turns out to matter, add it as a lettered phase.

---

## Phase 8 — Borrowed conveniences

Small, independent, additive. None of them changes the architecture; each can
land alone.

- **8.1 — Screenshot gallery.** Screenshots currently drop into
  `~/Desktop/sim-stream-<timestamp>.png` and are immediately hard to find. New
  ones land in `~/Desktop/sim-stream/`, and an authenticated `/gallery` page
  shows a newest-first thumbnail grid linking to the full images. Thumbnails
  come from macOS's built-in `sips`, cached beside the originals — no image
  library. The gallery answers only to the owner credential: a share link is
  for driving the simulator, not for browsing what was captured before it was
  issued. With `--auth false` there is no owner credential and the gallery is
  open, like every other route. File serving takes a bare filename matched against the directory
  listing, never a path. Read-only — no delete or rename endpoint. The listing
  and filename rules live in an import-safe module with `node:test` coverage.
  SimCast's `pending → ready/failed` persistence lifecycle is overkill here —
  stay on the filesystem.
- **8.2 — Tap by accessibility label.** AXe (1.8.0 on this host) resolves
  labels itself: `axe tap --label`. So this is a new `tap-label` input event
  that goes through the same FIFO command queue as every other input, plus a
  text field in the controls panel. A leading `#` targets an accessibility
  identifier (`--id`) instead. When a label is missing or matches more than
  one element, AXe says so; that message reaches the viewer as the normal
  error toast — the server never guesses which element was meant. Directly
  useful for verifying agent-built UI without hunting for pixel positions.

**Open question carried from the evaluation.** If the gallery ever wants to
sync across devices it reproduces exactly the persistence problem that made
SimCast unattractive. Keep it local.

---

## Phase 8b — `ngrok` provider

**Parked behind an owner prerequisite, deliberately** — see `DECISIONS.md §
ngrok provider parked as Phase 8b`. Same provider shape as Phase 6: `prepare`
binds `127.0.0.1`, `start` spawns the tunnel and returns the token-free base
URL, and `stop` is mandatory.

**Prerequisite before this phase can start:** `ngrok` installed and an ngrok
account. Every ngrok tunnel now needs an authtoken; it lives in the login
Keychain and reaches the provider as `NGROK_AUTHTOKEN`, never through a repo
file or ngrok's own config file written by this tool.

**Why it isn't in Phase 8.** It cannot be verified without that account, and
its original reason — a one-off share without a Cloudflare account — is
already met by the Phase 6 quick tunnel, which needs no account at all. Note
too that ngrok's free tier puts a warning page in front of the first load.
