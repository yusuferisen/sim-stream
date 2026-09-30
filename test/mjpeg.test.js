// Unit tests for the MJPEG hub's lifecycle rules. Run with `npm test`.
//
// What is covered is what breaks silently: a source opened twice, a reload
// that restarts the capture, a dying old source tearing down its replacement
// or bleeding into its stream, and viewers left attached to a dead source.
// The source, the responses and the timers are fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { MjpegHub } from "../mjpeg.js";

class FakeSource extends EventEmitter {
  kills = 0;
  kill() { this.kills++; }
  feed(text) { this.emit("data", Buffer.from(text)); }
  exit(detail = "code=1 sig=null") { this.emit("exit", detail); }
}

class FakeResponse extends EventEmitter {
  chunks = [];
  ended = false;
  write(chunk) { this.chunks.push(chunk.toString()); }
  end() { this.ended = true; }
  close() { this.emit("close"); }
  get body() { return this.chunks.join(""); }
}

function setup(options = {}) {
  const sources = [];
  const timers = [];
  const statuses = [];
  const logs = [];
  const hub = new MjpegHub({
    open: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    graceMs: 5000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    log: (line) => logs.push(line),
    ...options,
  });
  hub.on("status", (s) => statuses.push(s));
  const elapse = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
  };
  const armed = () => timers.filter((t) => !t.cleared);
  return { hub, sources, armed, elapse, statuses, logs };
}

test("hub: the first client opens the source, later ones share it", () => {
  const { hub, sources, statuses } = setup();
  assert.equal(hub.status, "idle");
  hub.addClient(new FakeResponse());
  hub.addClient(new FakeResponse());
  assert.equal(sources.length, 1);
  assert.deepEqual(statuses, ["live"]);
});

test("hub: every chunk goes to every client as-is; empty chunks are skipped", () => {
  const { hub, sources } = setup();
  const a = new FakeResponse(), b = new FakeResponse();
  hub.addClient(a);
  hub.addClient(b);
  sources[0].feed("----mjpegstream\r\nContent-Type: image/jpeg\r\n\r\nJPEG1");
  sources[0].emit("data", Buffer.alloc(0));
  sources[0].feed("\r\n----mjpegstream\r\n");
  assert.equal(a.body, "----mjpegstream\r\nContent-Type: image/jpeg\r\n\r\nJPEG1\r\n----mjpegstream\r\n");
  assert.equal(b.body, a.body);
  assert.deepEqual(a.chunks.length, 2);
});

test("hub: a client that leaves inside the grace window does not restart the source", () => {
  const { hub, sources, armed, elapse } = setup();
  const a = new FakeResponse();
  hub.addClient(a);
  a.close();
  assert.equal(armed().length, 1, "the grace timer is armed");
  assert.equal(sources[0].kills, 0);
  hub.addClient(new FakeResponse());
  assert.equal(armed().length, 0, "the timer was cleared by the rejoin");
  elapse();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kills, 0);
  assert.equal(hub.status, "live");
});

test("hub: the source is closed once the grace window passes with no clients", () => {
  const { hub, sources, elapse, statuses } = setup();
  const a = new FakeResponse();
  hub.addClient(a);
  a.close();
  elapse();
  assert.equal(sources[0].kills, 1);
  assert.deepEqual(statuses, ["live", "idle"]);
  // The exit that follows our own kill is expected: no "dead", no client
  // teardown, and the next client opens a fresh source.
  sources[0].exit("code=null sig=SIGTERM");
  assert.equal(hub.status, "idle");
  hub.addClient(new FakeResponse());
  assert.equal(sources.length, 2);
  assert.equal(hub.status, "live");
});

test("hub: a source that dies ends every client and reports dead", () => {
  const { hub, sources, statuses, logs } = setup();
  const a = new FakeResponse(), b = new FakeResponse();
  hub.addClient(a);
  hub.addClient(b);
  sources[0].exit("code=1 sig=null");
  assert.ok(a.ended && b.ended);
  assert.equal(hub.clients.size, 0);
  assert.deepEqual(statuses, ["live", "dead"]);
  assert.match(logs.join("\n"), /stream ended \(code=1 sig=null\)/);
  // The next client respawns.
  hub.addClient(new FakeResponse());
  assert.equal(sources.length, 2);
  assert.equal(hub.status, "live");
});

test("hub: a dead source's late data and exit cannot touch its replacement", () => {
  const { hub, sources, statuses } = setup();
  hub.addClient(new FakeResponse());
  sources[0].exit();
  const c = new FakeResponse();
  hub.addClient(c);
  sources[0].feed("stale");
  sources[0].exit();
  sources[1].feed("fresh");
  assert.equal(c.body, "fresh");
  assert.equal(c.ended, false);
  assert.deepEqual(statuses, ["live", "dead", "live"]);
});

test("hub: a stopped source's trailing data is not forwarded", () => {
  const { hub, sources, elapse } = setup();
  const a = new FakeResponse();
  hub.addClient(a);
  a.close();
  elapse();
  const b = new FakeResponse();
  hub.addClient(b);
  sources[0].feed("late from the old process");
  assert.equal(b.body, "");
  sources[1].feed("ok");
  assert.equal(b.body, "ok");
});

test("hub: an open() that throws leaves no source and reports dead", () => {
  const { hub, statuses, logs } = setup({ open: () => { throw new Error("no fds"); } });
  const a = new FakeResponse();
  hub.addClient(a);
  assert.equal(hub.source, null);
  assert.ok(a.ended);
  assert.deepEqual(statuses, ["dead"]);
  assert.match(logs.join("\n"), /could not open the stream: no fds/);
});

test("hub: stop() with clients attached closes the source and does not report dead", () => {
  const { hub, sources, statuses } = setup();
  hub.addClient(new FakeResponse());
  hub.stop();
  assert.equal(sources[0].kills, 1);
  sources[0].exit("code=null sig=SIGTERM");
  assert.deepEqual(statuses, ["live", "idle"]);
});

test("hub: a client's write failure drops that client only", () => {
  const { hub, sources } = setup();
  const bad = new FakeResponse();
  bad.write = () => { throw new Error("EPIPE"); };
  const good = new FakeResponse();
  hub.addClient(bad);
  hub.addClient(good);
  sources[0].feed("x");
  assert.equal(good.body, "x");
  assert.equal(hub.clients.has(bad), false);
  assert.equal(hub.clients.has(good), true);
});

test("hub: a source that dies inside the grace window reports dead, then idle when the window closes", () => {
  const { hub, sources, elapse, statuses } = setup();
  const a = new FakeResponse();
  hub.addClient(a);
  a.close();
  sources[0].exit("code=1 sig=null");
  assert.deepEqual(statuses, ["live", "dead"]);
  elapse();
  assert.deepEqual(statuses, ["live", "dead", "idle"]);
  assert.equal(sources[0].kills, 0, "nothing left to kill");
});
