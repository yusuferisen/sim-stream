# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–5: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation, token & session hardening; 6: the Cloudflare
> quick tunnel; 7: the 30 fps H.264 capture pipeline and browser player; 8:
> screenshot gallery and tap by label; 9: the real-device backend over
> WebDriverAgent) have been pruned from here. Their narrative is in
> `docs/JOURNAL.md`, their rationale in `docs/DECISIONS.md`, and the system as
> built is described in `docs/OVERVIEW.md`.

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

## Phase 8b — `ngrok` provider

**Parked behind an owner prerequisite, deliberately** — see `DECISIONS.md §
ngrok provider parked as Phase 8b`. Same provider shape as `cloudflared` (6.1): `prepare`
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
