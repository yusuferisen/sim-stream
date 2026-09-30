// The credential registry for sim-stream.
//
// Holds every token the server will accept: the operator's own ("owner",
// valid for the life of the process) plus any number of expiring share tokens
// minted at startup from `--share [label=]<ttl>`. It lives in memory only —
// restarting the server is the guaranteed revoke-everything switch, and there
// is deliberately no way to mint over HTTP (a token that can mint successors
// would make expiry decorative).
//
// No I/O and no side effects at import, so `node --test` can exercise it
// without a simulator. Both clocks are injectable for the same reason.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// A share is meant to end. The cap also keeps `now + ttl` a valid Date.
export const MAX_TTL_MS = 365 * UNIT_MS.d;

// Longest the expiry timer sleeps between looks at the clocks. Bounds how long
// an open connection can outlive its share if timers and the wall clock
// disagree (machine sleep, a clock step), and keeps every delay far below
// setTimeout's 2^31-1 ms ceiling — past which Node fires immediately.
const RECHECK_MS = 1000;

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const OWNER_LABEL = "owner";

// "30m" -> 1_800_000. The unit is mandatory: a bare "30" could mean minutes or
// hours, and guessing wrong in the long direction is exactly the silent
// failure expiry exists to prevent.
export function parseTtl(text) {
  const m = /^(\d+)([smhd])$/.exec(text);
  if (!m) throw new Error(`invalid duration '${text}' — use a whole number plus a unit: 45s, 30m, 2h, 1d`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (!(ms > 0)) throw new Error(`invalid duration '${text}' — must be greater than zero`);
  if (ms > MAX_TTL_MS) throw new Error(`invalid duration '${text}' — the maximum is 365d`);
  return ms;
}

// "demo=2h" -> { label: "demo", ttlMs }, "2h" -> { label: "share-<n>", ttlMs }.
export function parseShareSpec(spec, index) {
  const eq = spec.indexOf("=");
  const label = eq === -1 ? `share-${index + 1}` : spec.slice(0, eq);
  if (!LABEL_RE.test(label)) {
    throw new Error(`--share '${spec}': label must be 1–32 characters of letters, digits, '.', '_' or '-'`);
  }
  try {
    return { label, ttlMs: parseTtl(eq === -1 ? spec : spec.slice(eq + 1)) };
  } catch (e) {
    throw new Error(`--share '${spec}': ${e.message}`);
  }
}

export function mintToken() {
  return randomBytes(12).toString("hex");
}

export class ShareRegistry {
  // shares: [{ label, ttlMs }] — already parsed; see parseShareSpec().
  constructor({ ownerToken, shares = [], now = Date.now, mono = () => performance.now(), mint = mintToken } = {}) {
    if (typeof ownerToken !== "string" || ownerToken === "") throw new Error("ShareRegistry needs an owner token");
    this.now = now;
    this.mono = mono;
    this.sessions = new Set();
    this.timer = null;
    this.entries = [this.#entry(OWNER_LABEL, ownerToken, null)];
    for (const { label, ttlMs } of shares) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error(`share '${label}': invalid lifetime`);
      if (label === OWNER_LABEL) throw new Error(`share label '${OWNER_LABEL}' is reserved for your own token`);
      if (this.entries.some((e) => e.label === label)) throw new Error(`duplicate share label '${label}'`);
      const value = mint();
      // Two entries with one value would let the longer-lived one answer for
      // the other. Minted values are random, so this only trips on a --token
      // chosen to collide or a broken mint — either way, refuse to start.
      if (this.entries.some((e) => e.value === value)) throw new Error(`share '${label}': minted a token already in use`);
      this.entries.push(this.#entry(label, value, ttlMs));
    }
  }

  #entry(label, value, ttlMs) {
    return {
      label,
      value,
      buf: Buffer.from(value),
      ttlMs,
      // Wall-clock instant the share stops working — what the operator is told.
      expiresAt: ttlMs === null ? null : this.now() + ttlMs,
      // The same deadline on the monotonic clock. See remaining().
      monoDeadline: ttlMs === null ? null : this.mono() + ttlMs,
      expired: false, // latch: set the first time anything observes expiry
      reaped: false,  // sweep() has closed its sessions and reported it
    };
  }

  get owner() {
    return this.entries[0];
  }

  // Milliseconds of life left: Infinity for the owner, 0 once expired.
  //
  // This is the single definition of expiry — match(), track(), the sweep, and
  // the cookie's Max-Age all come through here. A share is dead as soon as
  // EITHER clock says so: the wall clock is the promise printed at startup
  // (and keeps counting while the machine sleeps); the monotonic clock cannot
  // be wound back, so resetting the system time cannot extend a share. And
  // the latch makes expiry one-way: once observed dead, a share stays dead
  // whatever the clocks do afterwards.
  remaining(entry) {
    if (entry.expiresAt === null) return Infinity;
    if (entry.expired) return 0;
    const left = Math.min(entry.expiresAt - this.now(), entry.monoDeadline - this.mono());
    if (left <= 0) {
      entry.expired = true;
      return 0;
    }
    return left;
  }

  isLive(entry) {
    return this.remaining(entry) > 0;
  }

  // The live entry whose token equals `provided`, or null.
  match(provided) {
    if (typeof provided !== "string" || provided === "") return null;
    const given = Buffer.from(provided);
    let hit = null;
    // Constant-time per entry (never `===`), and no early exit: every entry is
    // compared on every call, so timing does not depend on which one matched.
    for (const entry of this.entries) {
      if (given.length === entry.buf.length && timingSafeEqual(given, entry.buf)) hit ??= entry;
    }
    return hit && this.isLive(hit) ? hit : null;
  }

  // Register a long-lived connection (the MJPEG response, a WebSocket) that
  // `entry` authorized, so expiry can end it: authorization happens once, at
  // connect, and without this an open tab would keep streaming and sending
  // input long after its link died. Returns an untrack function for the
  // connection's own close handler. If the share is already dead, `close` runs
  // immediately.
  track(entry, close) {
    if (entry.expiresAt === null) return () => {};
    if (!this.isLive(entry)) {
      close();
      return () => {};
    }
    const session = { entry, close };
    this.sessions.add(session);
    return () => this.sessions.delete(session);
  }

  // Close the sessions of every share that has expired since the last sweep.
  // Returns [{ entry, closed }] for the newly expired ones.
  sweep() {
    const out = [];
    for (const entry of this.entries) {
      if (entry.expiresAt === null || entry.reaped || this.isLive(entry)) continue;
      entry.reaped = true;
      let closed = 0;
      for (const session of [...this.sessions]) {
        if (session.entry !== entry) continue;
        this.sessions.delete(session);
        closed++;
        try { session.close(); } catch {}
      }
      out.push({ entry, closed });
    }
    return out;
  }

  // Sweep at each share's deadline (and at least every RECHECK_MS while any is
  // pending), calling onExpire({ entry, closed }) as each one dies. The timer
  // is unref'd — it never holds the process open — and stops by itself once
  // the last share is gone.
  watch(onExpire = () => {}) {
    this.stop();
    const tick = () => {
      this.timer = null;
      for (const gone of this.sweep()) {
        try { onExpire(gone); } catch {}
      }
      const pending = this.entries.filter((e) => e.expiresAt !== null && !e.reaped);
      if (pending.length === 0) return;
      const next = Math.min(...pending.map((e) => this.remaining(e)));
      this.timer = setTimeout(tick, Math.min(Math.max(Math.ceil(next), 1), RECHECK_MS));
      this.timer.unref?.();
    };
    tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
