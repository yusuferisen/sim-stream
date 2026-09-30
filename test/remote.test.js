// Unit tests for the cloudflared quick-tunnel provider. Run with `npm test`.
//
// The provider is driven against test/fixtures/fake-cloudflared, which prints
// cloudflared's real banner lines; no network and no real tunnel. What is
// covered is what fails silently: a link printed before the tunnel answers, a
// tunnel process that outlives the server, a missing binary with no advice.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOUDFLARED_INSTALL,
  cloudflaredProvider,
  getRemoteProvider,
  isTunnelRegistered,
  parseQuickTunnelUrl,
  waitForAuthoritativeDns,
} from "../remote.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cloudflared");
const PORT = 18123;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function provider(mode, opts = {}) {
  process.env.FAKE_CF_MODE = mode;
  process.env.FAKE_CF_PORT = String(PORT);
  const logs = [];
  const p = cloudflaredProvider({ binaries: [FAKE], readyTimeoutMs: 1_500, stopGraceMs: 200, log: (l) => logs.push(l), waitForDns: async () => true, ...opts });
  return { p, logs };
}

// The child's pid, found through the provider's exit hook: the only handle a
// test has without widening the provider's surface.
const tunnelPids = () => {
  const out = [];
  for (const fn of process.listeners("exit")) if (fn.name === "killOnExit") out.push(fn);
  return out;
};

test("the assigned hostname is parsed; api.trycloudflare.com is not it", () => {
  const log = [
    'INF Requesting new quick Tunnel on trycloudflare.com...',
    'ERR Post "https://api.trycloudflare.com/tunnel": EOF',
    'INF |  https://Brave-Otter-Quiet-Lake.trycloudflare.com   |',
  ].join("\n");
  assert.equal(parseQuickTunnelUrl(log), "https://brave-otter-quiet-lake.trycloudflare.com/");
  assert.equal(parseQuickTunnelUrl('Post "https://api.trycloudflare.com/tunnel"'), null);
  assert.equal(parseQuickTunnelUrl("https://evil.trycloudflare.com.example.org"), null);
  assert.equal(isTunnelRegistered("INF Registered tunnel connection connIndex=0"), true);
  assert.equal(isTunnelRegistered("INF Starting tunnel"), false);
});

test("the provider is registered and binds loopback", () => {
  const p = getRemoteProvider("cloudflared");
  assert.equal(p.name, "cloudflared");
  assert.deepEqual(p.prepare(), { host: "127.0.0.1" });
  assert.equal(typeof p.stop, "function");
});

test("start resolves with a token-free base URL only once a connection is registered", async () => {
  const { p } = provider("ok");
  const { url, note } = await p.start({ port: PORT });
  assert.equal(url, "https://brave-otter-quiet-lake.trycloudflare.com/");
  assert.match(note, /PUBLIC/);
  assert.equal(tunnelPids().length, 1, "an exit hook guards the running tunnel");
  await p.stop();
  assert.equal(tunnelPids().length, 0, "the exit hook is removed once the tunnel is gone");
});

test("a URL without a registered connection times out and kills the process", async () => {
  const { p } = provider("hang");
  await assert.rejects(p.start({ port: PORT }), /no tunnel after 2s[\s\S]*trycloudflare\.com/);
  // The kill lands asynchronously; give the exit event a moment.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tunnelPids().length, 0);
});

test("an early exit rejects with cloudflared's own output", async () => {
  const { p } = provider("die");
  await assert.rejects(p.start({ port: PORT }), /exited \(code 1\) before the tunnel was up:[\s\S]*no such host/);
  await p.stop(); // no-op, must not throw or hang
});

test("unexpected arguments surface as an early exit (guards the argv contract)", async () => {
  const { p } = provider("ok");
  process.env.FAKE_CF_PORT = "1";
  await assert.rejects(p.start({ port: PORT }), /unexpected arguments/);
});

test("a missing binary fails with the install command", () => {
  const { p } = provider("ok", { binaries: ["/nonexistent/cloudflared"] });
  assert.throws(() => p.start({ port: PORT }), (e) => e.message.includes(CLOUDFLARED_INSTALL));
});

test("stop escalates to SIGKILL when cloudflared ignores SIGTERM", async () => {
  const { p, logs } = provider("stubborn");
  await p.start({ port: PORT });
  const t0 = Date.now();
  await p.stop();
  assert.ok(Date.now() - t0 < 1_000, "stop returns after the grace period");
  assert.deepEqual(logs, [], "a deliberate stop is not reported as a dead tunnel");
});

test("a tunnel that dies after start is logged", async () => {
  const { p, logs } = provider("ok");
  await p.start({ port: PORT });
  // Kill it behind the provider's back, via the pid the OS reports.
  const { execFileSync } = await import("node:child_process");
  const pid = Number(execFileSync("pgrep", ["-f", `${FAKE} tunnel`], { encoding: "utf8" }).trim().split("\n")[0]);
  assert.ok(alive(pid));
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /tunnel exited \(SIGKILL\) — the public link is dead/);
  await p.stop(); // already gone: no-op
});

test("after start, tunnel-level ERR lines are logged whole; INF and per-request ERR lines are not", async () => {
  const { p, logs } = provider("errlater");
  await p.start({ port: PORT });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(logs, ['2026-09-30T10:01:00Z ERR Connection terminated error="timeout: no recent network activity" connIndex=0']);
  await p.stop();
});

test("start waits for the hostname's DNS; a name that never answers still starts, with a retry hint", async () => {
  const asked = [];
  const { p } = provider("ok", { waitForDns: async (host) => { asked.push(host); return false; } });
  const { url, note } = await p.start({ port: PORT });
  assert.deepEqual(asked, ["brave-otter-quiet-lake.trycloudflare.com"]);
  assert.equal(url, "https://brave-otter-quiet-lake.trycloudflare.com/");
  assert.match(note, /retry in a minute/);
  await p.stop();
});

test("the DNS wait never throws — an unusable zone is just 'not answering'", async () => {
  assert.equal(await waitForAuthoritativeDns("x.example.invalid", { timeoutMs: 500 }), false);
});
