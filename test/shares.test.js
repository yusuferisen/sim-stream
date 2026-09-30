// Unit tests for the credential registry. Run with `npm test` (node --test).
//
// These cover what fails silently: an expiry boundary that is off by one, a
// share that comes back to life, a connection that outlives its link. Both
// clocks are fakes, so nothing here waits on real time except the two watch()
// tests at the bottom.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ShareRegistry, MAX_TTL_MS, parseShareSpec, parseTtl } from "../shares.js";

// A registry on two independently steerable clocks, with predictable tokens.
function setup(shares = [{ label: "demo", ttlMs: 60_000 }], ownerToken = "owner-token") {
  const clock = { wall: 1_000_000, mono: 5_000 };
  let n = 0;
  const reg = new ShareRegistry({
    ownerToken,
    shares,
    now: () => clock.wall,
    mono: () => clock.mono,
    mint: () => `minted-${++n}`,
  });
  const advance = (ms) => { clock.wall += ms; clock.mono += ms; };
  return { reg, clock, advance };
}

// --- parseTtl ---------------------------------------------------------------

test("parseTtl converts each unit", () => {
  assert.equal(parseTtl("45s"), 45_000);
  assert.equal(parseTtl("30m"), 1_800_000);
  assert.equal(parseTtl("2h"), 7_200_000);
  assert.equal(parseTtl("1d"), 86_400_000);
  assert.equal(parseTtl("365d"), MAX_TTL_MS);
});

test("parseTtl rejects anything that is not a positive whole number plus a unit", () => {
  for (const bad of ["", "30", "h", "2 h", "2H", "1.5h", "-1h", "0s", "0h", "2h30m", "2hr", " 2h", "2h ", "1e3s", "366d", "99999999999999999999999d"]) {
    assert.throws(() => parseTtl(bad), /invalid duration/, `should reject '${bad}'`);
  }
});

// --- parseShareSpec ---------------------------------------------------------

test("parseShareSpec reads label=ttl and defaults the label by position", () => {
  assert.deepEqual(parseShareSpec("demo=2h", 0), { label: "demo", ttlMs: 7_200_000 });
  assert.deepEqual(parseShareSpec("30m", 0), { label: "share-1", ttlMs: 1_800_000 });
  assert.deepEqual(parseShareSpec("30m", 2), { label: "share-3", ttlMs: 1_800_000 });
  assert.deepEqual(parseShareSpec("qa.team_1-b=1d", 0), { label: "qa.team_1-b", ttlMs: 86_400_000 });
});

test("parseShareSpec rejects bad labels and bad durations, naming the flag", () => {
  for (const bad of ["=2h", "demo=", "demo", "de mo=2h", "a=b=2h", "-x=2h", `${"x".repeat(33)}=2h`, "demo=2"]) {
    assert.throws(() => parseShareSpec(bad, 0), /--share/, `should reject '${bad}'`);
  }
});

// --- construction -----------------------------------------------------------

test("the owner is entry 0 and never expires; shares get both deadlines", () => {
  const { reg } = setup();
  assert.equal(reg.owner.label, "owner");
  assert.equal(reg.owner.expiresAt, null);
  assert.equal(reg.remaining(reg.owner), Infinity);
  const demo = reg.entries[1];
  assert.equal(demo.value, "minted-1");
  assert.equal(demo.expiresAt, 1_000_000 + 60_000);
  assert.equal(demo.monoDeadline, 5_000 + 60_000);
});

test("construction refuses duplicate labels, a reserved label, colliding tokens, and bad lifetimes", () => {
  assert.throws(() => setup([{ label: "a", ttlMs: 1000 }, { label: "a", ttlMs: 2000 }]), /duplicate share label 'a'/);
  assert.throws(() => setup([{ label: "owner", ttlMs: 1000 }]), /'owner' is reserved/);
  assert.throws(() => setup([{ label: "a", ttlMs: 1000 }], "minted-1"), /already in use/);
  for (const ttlMs of [0, -1, NaN, Infinity, MAX_TTL_MS + 1, undefined, null]) {
    assert.throws(() => setup([{ label: "a", ttlMs }]), /invalid lifetime/, `ttlMs=${ttlMs}`);
  }
  assert.throws(() => new ShareRegistry({ ownerToken: "" }), /owner token/);
  assert.throws(() => new ShareRegistry({}), /owner token/);
});

// --- match ------------------------------------------------------------------

test("match returns the entry for a live token and null for everything else", () => {
  const { reg } = setup();
  assert.equal(reg.match("owner-token"), reg.owner);
  assert.equal(reg.match("minted-1"), reg.entries[1]);
  for (const bad of [undefined, null, "", 42, ["minted-1"], {}, "minted-", "minted-11", "Minted-1", "minted-2", "owner-token ", "minted-1,minted-1"]) {
    assert.equal(reg.match(bad), null, `should not match ${JSON.stringify(bad)}`);
  }
});

test("match tells shares apart even when their tokens have equal length", () => {
  const { reg } = setup([{ label: "a", ttlMs: 1000 }, { label: "b", ttlMs: 5000 }]);
  assert.equal(reg.match("minted-1").label, "a");
  assert.equal(reg.match("minted-2").label, "b");
});

test("the expiry boundary: live one millisecond before, dead exactly at the deadline", () => {
  const { reg, advance } = setup();
  const demo = reg.entries[1];
  advance(59_999);
  assert.equal(reg.remaining(demo), 1);
  assert.equal(reg.match("minted-1"), demo);
  advance(1);
  assert.equal(reg.match("minted-1"), null);
  assert.equal(reg.remaining(demo), 0);
  assert.equal(reg.isLive(demo), false);
});

test("one share expiring leaves the owner and longer shares working", () => {
  const { reg, advance } = setup([{ label: "short", ttlMs: 1000 }, { label: "long", ttlMs: 5000 }]);
  advance(1000);
  assert.equal(reg.match("minted-1"), null);
  assert.equal(reg.match("minted-2").label, "long");
  assert.equal(reg.match("owner-token"), reg.owner);
  advance(10 * MAX_TTL_MS);
  assert.equal(reg.match("minted-2"), null);
  assert.equal(reg.match("owner-token"), reg.owner);
});

// --- the two clocks and the latch --------------------------------------------

test("winding the wall clock back does not extend a share (monotonic deadline holds)", () => {
  const { reg, clock } = setup();
  clock.mono += 60_000;       // a full TTL of real time has passed…
  clock.wall -= 3_600_000;    // …but the system clock was set back an hour
  assert.equal(reg.match("minted-1"), null);
});

test("a stalled monotonic clock does not extend a share (wall deadline holds)", () => {
  const { reg, clock } = setup();
  clock.wall += 60_000;       // e.g. the machine slept: wall time moved, timers did not
  assert.equal(reg.match("minted-1"), null);
});

test("remaining is the smaller of the two clocks' views", () => {
  const { reg, clock } = setup();
  clock.wall += 10_000;
  clock.mono += 40_000;
  assert.equal(reg.remaining(reg.entries[1]), 20_000);
});

test("expiry latches: a share seen dead stays dead when both clocks go back", () => {
  const { reg, clock, advance } = setup();
  advance(60_000);
  assert.equal(reg.match("minted-1"), null);
  clock.wall -= 120_000;
  clock.mono -= 120_000;
  assert.equal(reg.match("minted-1"), null);
  assert.equal(reg.remaining(reg.entries[1]), 0);
});

// --- sessions ---------------------------------------------------------------

test("sweep closes only the expired share's sessions, exactly once", () => {
  const { reg, advance } = setup([{ label: "short", ttlMs: 1000 }, { label: "long", ttlMs: 5000 }]);
  const [, short, long] = reg.entries;
  const closed = [];
  reg.track(short, () => closed.push("short-stream"));
  reg.track(short, () => closed.push("short-ws"));
  reg.track(long, () => closed.push("long-ws"));
  reg.track(reg.owner, () => closed.push("owner-ws"));

  advance(999);
  assert.deepEqual(reg.sweep(), []);
  assert.deepEqual(closed, []);

  advance(1);
  const first = reg.sweep();
  assert.deepEqual(first.map((g) => [g.entry.label, g.closed]), [["short", 2]]);
  assert.deepEqual(closed, ["short-stream", "short-ws"]);

  assert.deepEqual(reg.sweep(), [], "an expired share is reported once");
  advance(4000);
  assert.deepEqual(reg.sweep().map((g) => [g.entry.label, g.closed]), [["long", 1]]);
  assert.deepEqual(closed, ["short-stream", "short-ws", "long-ws"]);
  assert.equal(reg.sessions.size, 0);
});

test("an untracked session is not closed at expiry", () => {
  const { reg, advance } = setup();
  let closed = 0;
  const untrack = reg.track(reg.entries[1], () => closed++);
  untrack();
  advance(60_000);
  assert.deepEqual(reg.sweep().map((g) => g.closed), [0]);
  assert.equal(closed, 0);
});

test("tracking against an already-dead share closes immediately and keeps nothing", () => {
  const { reg, advance } = setup();
  advance(60_000);
  let closed = 0;
  reg.track(reg.entries[1], () => closed++);
  assert.equal(closed, 1);
  assert.equal(reg.sessions.size, 0);
  // …including after the sweep has already reaped the share.
  reg.sweep();
  reg.track(reg.entries[1], () => closed++);
  assert.equal(closed, 2);
  assert.equal(reg.sessions.size, 0);
});

test("owner sessions are never tracked or closed", () => {
  const { reg, advance } = setup();
  let closed = 0;
  reg.track(reg.owner, () => closed++);
  assert.equal(reg.sessions.size, 0);
  advance(10 * MAX_TTL_MS);
  reg.sweep();
  assert.equal(closed, 0);
});

test("a close callback that throws does not stop the others", () => {
  const { reg, advance } = setup();
  let closed = 0;
  reg.track(reg.entries[1], () => { throw new Error("socket already gone"); });
  reg.track(reg.entries[1], () => closed++);
  advance(60_000);
  assert.deepEqual(reg.sweep().map((g) => g.closed), [2]);
  assert.equal(closed, 1);
});

// --- watch (real timers) ----------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("watch closes sessions at the deadline — not before, and without being polled", async () => {
  const started = Date.now(); // taken before minting, so "early" is measured from a lower bound
  const reg = new ShareRegistry({ ownerToken: "owner-token", shares: [{ label: "demo", ttlMs: 150 }] });
  const demo = reg.entries[1];
  let closedAt = null;
  const expired = [];
  reg.track(demo, () => { closedAt = Date.now(); });
  reg.watch((gone) => expired.push(gone.entry.label));
  try {
    await sleep(60);
    assert.equal(closedAt, null, "closed before the deadline");
    assert.equal(reg.match(demo.value), demo);
    await sleep(250);
    assert.notEqual(closedAt, null, "never closed");
    assert.ok(closedAt - started >= 150, `closed early, after ${closedAt - started}ms`);
    assert.deepEqual(expired, ["demo"]);
    assert.equal(reg.match(demo.value), null);
    assert.equal(reg.timer, null, "the timer stops once nothing is pending");
  } finally {
    reg.stop();
  }
});

test("watch re-arms past its recheck cap for a share longer than one interval", async () => {
  const reg = new ShareRegistry({ ownerToken: "owner-token", shares: [{ label: "demo", ttlMs: 1300 }] });
  let closed = 0;
  reg.track(reg.entries[1], () => closed++);
  reg.watch();
  try {
    await sleep(1100); // one full recheck interval has elapsed and re-armed
    assert.equal(closed, 0);
    assert.notEqual(reg.timer, null);
    await sleep(400);
    assert.equal(closed, 1);
  } finally {
    reg.stop();
  }
});
