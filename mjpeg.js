// The MJPEG path's hub: one capture source, fanned out to every `/stream`
// response, with the same lifecycle rules as the H.264 hub (h264.js).
//
//   refcount      the source is opened for the first client and closed 5 s
//                 (graceMs) after the last one leaves — a page reload is a
//                 leave-then-join inside that window and must not restart it
//   generation    each open bumps it; data and exit handlers act only for
//                 the current one, so a dying old source can neither tear
//                 down its replacement nor bleed into its stream
//   status        idle | live | dead, emitted as "status" for the server to
//                 broadcast
//
// The source comes from the backend (docs/architecture.md § Backends):
// `open()` returns an emitter with "data" (chunks of a clean multipart body —
// the backend strips any preamble), "exit" (once, with a detail string) and
// kill(). Every chunk is written to every client as-is; the hub never parses
// the body.
//
// No I/O and no side effects at import: the source and the timers are handed
// in, so `node --test` covers the rules without a simulator
// (test/mjpeg.test.js).

import { EventEmitter } from "node:events";

export class MjpegHub extends EventEmitter {
  constructor({
    open,
    graceMs = 5000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  } = {}) {
    super();
    if (typeof open !== "function") throw new Error("MjpegHub needs open");
    this.open = open;
    this.graceMs = graceMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;

    this.clients = new Set();
    this.source = null;
    this.generation = 0;
    this.stopTimer = null;
    this.status = "idle"; // idle | live | dead
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  // Registers a response (anything with write(), end() and "close"/"error"
  // events) and opens the source if it is not running.
  addClient(res) {
    if (this.stopTimer) {
      this.clearTimer(this.stopTimer);
      this.stopTimer = null;
    }
    this.clients.add(res);
    const drop = () => this.#drop(res);
    res.on("close", drop);
    res.on("error", drop);
    this.start();
  }

  #drop(res) {
    if (!this.clients.has(res)) return;
    this.clients.delete(res);
    if (this.clients.size === 0) this.scheduleStop();
  }

  scheduleStop() {
    if (this.stopTimer) return;
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = null;
      if (this.clients.size === 0) this.stop();
    }, this.graceMs);
  }

  start() {
    if (this.source) return;
    const gen = ++this.generation;
    let source;
    try {
      source = this.open();
    } catch (e) {
      this.log(`could not open the stream: ${e.message}`);
      this.#ended();
      return;
    }
    this.source = source;
    this.setStatus("live");
    source.on("data", (chunk) => {
      if (this.generation === gen) this.#onData(chunk);
    });
    source.on("exit", (detail) => {
      // A newer open, or our own stop(), has moved the generation on: this
      // source is no longer ours to account for.
      if (this.generation !== gen) return;
      this.log(`stream ended (${detail})`);
      this.generation++;
      this.source = null;
      this.#ended();
    });
  }

  stop() {
    if (this.source) {
      // Bumped first: the exit that follows the kill is expected, not a death.
      this.generation++;
      try { this.source.kill(); } catch {}
      this.source = null;
    }
    this.setStatus("idle");
  }

  // The source went away on its own: every client's response is ended (the
  // browser reconnects, which reopens the source) and the status says why.
  #ended() {
    const toClose = [...this.clients];
    this.clients.clear();
    for (const c of toClose) {
      try { c.end(); } catch {}
    }
    this.setStatus("dead");
  }

  #onData(chunk) {
    if (chunk.length === 0) return;
    for (const res of [...this.clients]) {
      try {
        res.write(chunk);
      } catch {
        this.#drop(res);
      }
    }
  }
}
