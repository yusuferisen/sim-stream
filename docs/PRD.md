# PRD — sim-stream

> **Inferred by /adopt from the codebase — verify.** This repo was born outside
> the planning pipeline and had no product-intent document. The intent below was
> reconstructed on 2026-07-31 from the README's framing, the shape of the code,
> and the reasoning recorded in the SimCast build-vs-adopt evaluation. Correct
> anything wrong here now — once verified, this file is frozen and later work
> treats it as intent of record.

## The problem

You run iOS Simulators on a Mac that isn't the machine you're sitting at — a
Mac Mini at the desk, agents building features on it all day. Verifying what
was just built means walking to that Mac, or having an iPhone handy, or
screen-sharing an entire desktop to look at one window. Each of those is enough
friction to make you skip the check.

## The wedge

**Open a URL on whatever device is in your hand and drive the simulator.**

One command on the Mac prints a link. The link works in Mobile Safari, on a
laptop across the room, or — over a tunnel — from anywhere. What you get is
the live simulator screen and full touch and keyboard control of it.

## Who it's for

One developer, their own machines. Specifically: someone delegating feature
work to AI agents on a host Mac who needs a fast "did that actually work" loop
without the physical device. Not a team product, not a service, not multi-user.

## Principles

These are the constraints that decide arguments, in priority order.

1. **Seconds to first frame.** `npm i && node server.js`. Any change that adds
   an account, a cloud project, a migration, or a deploy step to the basic path
   is rejected regardless of what it buys. This principle alone decided the
   build-vs-adopt evaluation.
2. **A URL is the credential.** Sharing means sending a link — no invites, no
   sign-in, no identity provider on either end. Access control may get
   *stronger* (expiry, a cookie, an SSO check in front of the tunnel) but must
   never become a login the viewer has to complete to look at a screen.
3. **No cloud dependencies.** The tool works offline and on an air-gapped
   network. Nothing runs on someone else's infrastructure by default.
4. **A tool, not a platform.** One simulator, one viewer session, one process.
   Small enough to read in an afternoon.
5. **Correctness of input over smoothness of video.** Taps must land where you
   clicked, and commands must arrive in order. Frame rate is secondary — the
   job is verification, not video playback.

## In scope

- Live view of a single running iOS Simulator in a browser.
- Full interactive input: tap, swipe, long-press, keyboard text, special keys,
  hardware buttons, preset gestures.
- Screenshot capture to the host.
- Usable on a phone-sized viewport, not just a desktop.
- Reaching the server from off-box: LAN, private tunnel, and public tunnel,
  behind a shared secret.

## Explicitly out of scope

Each of these was considered and rejected; reopening one is a change of intent,
not a feature request.

- **Accounts, teams, and multi-user access.** See principle 2.
- **Hosted infrastructure of any kind** — auth providers, realtime services,
  object storage, managed video transport. See principle 3.
- **Multi-simulator dashboards.** One at a time is the design.
- **A durable, synced artifact library.** Screenshots land on the host's
  filesystem. Syncing them reproduces exactly the persistence complexity that
  made the alternative unattractive.
- **Native or mobile client apps.** The browser is the client.

## What success looks like

An agent finishes a feature on the host Mac. You open a link on your phone,
tap through the new screen, confirm it works, and close the tab — without
getting up, plugging anything in, or signing into anything.

## Known trade-offs accepted at birth

Documented as intent so they aren't relitigated as bugs: capture is a
screenshot loop and tops out around 7–10 fps; text input is US-keyboard only;
touch is single-finger. All three follow from using the AXe CLI as the single
capture-and-input backend, which is what keeps the server small and dependency-
free. Improving any of them is a deliberate, costed project — see
`docs/ROADMAP.md`.
