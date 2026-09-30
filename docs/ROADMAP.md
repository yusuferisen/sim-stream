# Roadmap

> **Future only.** Scope prose for *unshipped* phases — what each one means,
> why it's worth doing, and what's out of scope. Carries **no execution state**:
> the live checklist and all completion truth live in `PROGRESS.md`.
>
> Shipped phases (1–5: core streaming, mobile UI, remote providers, the
> build-vs-adopt evaluation, token & session hardening; 6: the Cloudflare
> quick tunnel; 7: the 30 fps H.264 capture pipeline and browser player; 8:
> screenshot gallery and tap by label) have been pruned from here. Their narrative is in
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

---

## Phase 9 — Real-device backend (WebDriverAgent)

**Why.** The same link, the same page, the same controls — but the thing on
the other end is a real iPhone or iPad from the QA bench instead of a
simulator. Measured on the bench, a real device is the more responsive target
(29 fps picture, ~0.5 s taps; `DECISIONS.md § Real devices join the tool`).
The viewer can be any browser, an Android phone included.

**Shape.** One seam, four slices. Capture, input, bounds and screenshot are
the only things that know what they drive; auth, shares, tunnels, the H.264
player, the gallery and tap-by-label stay as they are.

- **9.1 — Backend seam.** Move today's AXe/`simctl` code behind one interface
  in an import-safe module (`backends/simulator.js`): identity and bounds, an
  MJPEG source, an H.264 pipeline, `input(event)`, `screenshot(dest)`, and
  `stop()`. `server.js`, `MjpegHub` and the H.264 hub talk only to that
  interface. **Behaviour is identical** — the whole manual checklist passes on
  a sandbox clone exactly as before, `npm test` stays green, and the contract
  is written into `docs/architecture.md` so 9.2 builds against it. No device
  code in this slice.
- **9.2 — Device video.** `--device <udid|role>` selects a
  `backends/device.js` that opens a WDA session, forwards the device's MJPEG
  port with `ios forward`, applies `--fps`/`--scale`/`--quality` as WDA
  settings, feeds the stream into `MjpegHub`, takes bounds from
  `/window/size` and screenshots from `/screenshot`. Input events answer with
  a clear "not supported yet" error ack. Tests run against a fake WDA server
  (the `fake-cloudflared` pattern). **Done when** the primary bench iPhone is
  watchable in Chrome at ≥25 fps, the header status behaves, a share link
  still expires, and a missing WDA fails at startup with the fix printed.
- **9.3 — Device input.** Tap, long-press and swipe as W3C touch actions;
  `type` through `/wda/keys` (Unicode works here); special keys mapped; the
  hardware buttons that exist on a device (home, volume up/down, lock, Siri)
  through WDA's endpoints, others refused; `tap-label` through an
  accessibility lookup. Wake and unlock before dispatching. Everything goes
  through the same FIFO queue with the same acks and error toasts. **Done
  when** the browser checklist — tap, swipe, long-press, typed text, a key, a
  button, a label tap, a screenshot — passes from Chrome against the primary
  bench iPhone.
- **9.4 — H.264 for devices.** The Phase 7 helper gains `--input mjpeg`
  (JPEG decode → VideoToolbox), and the device backend's H.264 pipeline is:
  the server fetches the forwarded MJPEG over HTTP and pipes the body into
  the helper's stdin (the helper stays stdin-only; this stream is 4–10 MB/s,
  not the raw-BGRA firehose the Phase 7 rule was about). **Done when** `/video` from the device plays at
  ≥25 fps in Chrome at a few Mbit/s instead of ~35, and the page still falls
  back to MJPEG when the helper is absent.

**Out of scope.** Multi-finger gestures (a client change; later). Starting
WDA or the tunnel from the tool. More than one target per process. Any
device that is not a prepared bench device. Audio.

**Watch for.**

- **WDA sessions die.** A `404`/invalid-session answer means re-create the
  session and retry once; never spin.
- **Two coordinate spaces.** WDA takes points; the JPEG frames are pixels at
  `mjpegScalingFactor`. The browser still sends normalized `(0..1)`
  coordinates, so only bounds (points) matter for input — but the H.264
  helper needs the pixel size, which comes from the first JPEG's header, not
  from a table.
- **`MjpegHub` strips AXe's fake HTTP preamble.** WDA's server speaks real
  HTTP; the source abstraction must hand the hub a clean multipart body in
  both cases.
- **`ios forward` is a child process** — the backend's `stop()` must kill it,
  and a port already in use must fail loudly, not silently stream someone
  else's device.
- **Auto-lock is 3 minutes.** The MJPEG stream shows the lock screen; input
  must unlock first, and the status line should say the device is locked
  rather than looking dead.
- **A real device carries real Apple IDs.** A public share of a bench device
  exposes Settings and signed-in accounts to whoever holds the link — keep
  device shares short and prefer the tailnet.
