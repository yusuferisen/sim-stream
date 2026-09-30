// Pluggable remote-access providers for sim-stream.
//
// One flag — `--remote <name>` — selects how the server is exposed beyond
// localhost. Each provider implements a tiny interface so adding a new one
// (e.g. cloudflared, ngrok) is just a new entry in PROVIDERS — no server
// changes required.
//
//   prepare()                -> { host? }                    // before listen()
//   start({ port })          -> { url, note? } | Promise     // after  listen()
//   stop()                   -> void | Promise               // on shutdown
//
// `url` is the token-free base URL, ending in "/". Providers know nothing
// about auth: the server appends `?token=…` itself, once per share link.
//
// Every hook is OPTIONAL — the server calls each through optional chaining, so
// a provider implements only what it needs (`lan` has no stop()). But one that
// spawns a long-lived process must implement stop(), or it leaks past exit.
//
// Built-ins:
//   lan               — bind on 0.0.0.0, reachable on the local network
//   tailscale-serve   — private HTTPS on the tailnet (auto TLS via MagicDNS)
//   tailscale-funnel  — PUBLIC HTTPS via Tailscale Funnel
//   cloudflared       — PUBLIC HTTPS via an anonymous Cloudflare quick tunnel

import { execFileSync, spawn } from "node:child_process";
import dns from "node:dns";
import os from "node:os";

function tailscaleBinary() {
  const candidates = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "tailscale",
  ];
  for (const p of candidates) {
    try {
      execFileSync(p, ["version"], { stdio: "pipe" });
      return p;
    } catch {}
  }
  throw new Error(
    "tailscale CLI not found. Install with `brew install tailscale`, " +
    "or symlink the App Store app: " +
    "sudo ln -s '/Applications/Tailscale.app/Contents/MacOS/Tailscale' /usr/local/bin/tailscale"
  );
}

function tailscaleHostname(ts) {
  const json = execFileSync(ts, ["status", "--json"], { encoding: "utf8" });
  const data = JSON.parse(json);
  const dns = data?.Self?.DNSName;
  if (!dns) {
    throw new Error("tailscale: this node has no DNSName — is `tailscale up` complete and MagicDNS enabled?");
  }
  return dns.replace(/\.$/, "");
}

// On macOS, the App Store / standalone-installer builds of Tailscale route
// `tailscale serve|funnel` through the GUI agent. If the GUI isn't running,
// the CLI hangs trying to spawn it. Pre-launching the app makes the call
// fail-fast (with a usable error) instead of stalling for a minute.
function ensureMacGuiRunning() {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("open", ["-ga", "Tailscale"], { stdio: "ignore", timeout: 5000 });
  } catch {}
}

// Tailscale serve and funnel share the same shape — only the subcommand and
// the public/private framing differ.
function tailscaleProvider(mode) {
  return {
    name: `tailscale-${mode}`,
    // Force loopback bind: tailscale serve/funnel proxies from tailnet:443 →
    // 127.0.0.1:<port>, so binding on 0.0.0.0 would only widen the attack
    // surface without adding reach.
    prepare() {
      return { host: "127.0.0.1" };
    },
    start({ port }) {
      const ts = tailscaleBinary();
      const host = tailscaleHostname(ts);
      ensureMacGuiRunning();
      // --bg persists the config past this CLI call. Idempotent: rerunning
      // with the same target is a no-op. Hard timeout so we never hang —
      // typical success is sub-second; prereq errors return in 1–3s.
      try {
        execFileSync(ts, [mode, "--bg", String(port)], {
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch (e) {
        const stderr = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim();
        // Pass the upstream error through verbatim — Tailscale's own
        // messages already include the admin-console URL when prereqs are
        // missing (e.g. "Serve is not enabled on your tailnet. To enable,
        // visit: https://login.tailscale.com/f/serve?node=…").
        throw new Error(`tailscale ${mode} failed:\n${stderr}`);
      }
      const url = `https://${host}/`;
      const note = mode === "funnel"
        ? "PUBLIC — anyone with this URL + token can reach your simulator."
        : "Private to your tailnet (devices signed in to your Tailscale account).";
      return { url, note };
    },
    stop() {
      // Reset our config on shutdown so visitors don't hit a broken endpoint
      // after the local server is gone. `reset` clears all serve/funnel
      // config; if you need finer-grained control, manage it manually.
      try {
        const ts = tailscaleBinary();
        execFileSync(ts, [mode, "reset"], { stdio: "ignore", timeout: 10_000 });
      } catch {}
    },
  };
}

// ---- cloudflared quick tunnel ----------------------------------------------
//
// `cloudflared tunnel --url …` needs no account: it asks api.trycloudflare.com
// for a random `<words>.trycloudflare.com` hostname, prints it inside a banner
// on stderr, then registers edge connections. The hostname does not answer
// until the first "Registered tunnel connection" line, so start() waits for
// both before returning — a printed link must work when it is printed.

export const CLOUDFLARED_INSTALL = "brew install cloudflared";

// The assigned hostname, or null. api.trycloudflare.com appears in the same
// output (as the endpoint cloudflared asks) and must never be mistaken for it.
export function parseQuickTunnelUrl(text) {
  for (const m of String(text).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com(?![\w.-])/gi)) {
    if (m[1].toLowerCase() !== "api") return `https://${m[1].toLowerCase()}.trycloudflare.com/`;
  }
  return null;
}

export const isTunnelError = (line) => /\bERR\b/.test(line) && !/\b(dest|originService)=/.test(line);

export const isTunnelRegistered = (text) => /Registered tunnel connection/i.test(String(text));

// The hostname reaches Cloudflare's DNS ~2 s after the tunnel registers
// (measured), and a lookup that lands first is cached as NXDOMAIN for the
// zone's 60 s negative TTL — a link opened straight from the banner would
// fail for a minute. So start() waits for the name at trycloudflare.com's own
// nameservers: authoritative answers are never cached, so polling them cannot
// poison anyone's resolver. Resolves true once the name answers, false on
// timeout or when DNS itself is unusable — never throws.
export async function waitForAuthoritativeDns(hostname, { timeoutMs = 15_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  try {
    const zone = hostname.split(".").slice(-2).join(".");
    const nsNames = await dns.promises.resolveNs(zone);
    const ips = (await Promise.all(nsNames.map((n) => dns.promises.resolve4(n).catch(() => [])))).flat();
    if (!ips.length) return false;
    const resolver = new dns.promises.Resolver({ timeout: 2_000, tries: 1 });
    resolver.setServers(ips);
    while (Date.now() < deadline) {
      try {
        if ((await resolver.resolve4(hostname)).length) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } catch {}
  return false;
}

function cloudflaredBinary(candidates) {
  for (const p of candidates) {
    try {
      execFileSync(p, ["--version"], { stdio: "pipe", timeout: 10_000 });
      return p;
    } catch {}
  }
  throw new Error(`cloudflared not found. Install it with \`${CLOUDFLARED_INSTALL}\` (no account needed).`);
}

// A factory so tests can point it at a fake binary and a short timeout.
export function cloudflaredProvider({
  binaries = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "cloudflared"],
  readyTimeoutMs = 45_000,
  stopGraceMs = 1_000,
  waitForDns = waitForAuthoritativeDns,
  log = (line) => console.error(`[remote:cloudflared] ${line}`),
} = {}) {
  let proc = null;
  const running = (c) => c && c.exitCode === null && c.signalCode === null;
  // Last resort for exits that skip stop() — process.exit() from a failed
  // start, the shutdown timer, an uncaught error. A child is not killed when
  // its parent exits, so without this the tunnel would keep serving a dead
  // port. Synchronous, as 'exit' handlers must be.
  const killOnExit = () => { if (running(proc)) proc.kill("SIGKILL"); };

  return {
    name: "cloudflared",
    // The tunnel reaches the server over loopback; binding wider would only
    // widen the attack surface.
    prepare() {
      return { host: "127.0.0.1" };
    },
    start({ port }) {
      const bin = cloudflaredBinary(binaries);
      return new Promise((resolve, reject) => {
        // --grace-period: on SIGTERM cloudflared otherwise waits up to 30 s
        // for in-flight requests — and the MJPEG stream never finishes.
        const child = spawn(bin, [
          "tunnel", "--no-autoupdate", "--grace-period", "1s",
          "--url", `http://127.0.0.1:${port}`,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        proc = child;
        process.on("exit", killOnExit);

        let output = "";
        let url = null;
        let settled = false;
        const tail = () => output.trim().split("\n").slice(-8).join("\n");
        const fail = (message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (running(child)) child.kill("SIGKILL");
          reject(new Error(message));
        };
        const timer = setTimeout(
          () => fail(`cloudflared: no tunnel after ${Math.round(readyTimeoutMs / 1000)}s. Last output:\n${tail()}`),
          readyTimeoutMs,
        );

        // Both streams are drained for the tunnel's whole life: cloudflared
        // logs continuously, and a full pipe would stall it. Once the tunnel
        // is up, only its tunnel-level error lines are echoed — an edge
        // reconnect drops every viewer at once, and without them that is
        // unexplained. Per-request errors (they carry `dest=` or
        // `originService=`) are skipped: every expired share or closed tab
        // cuts a stream mid-body and logs one.
        const drain = () => {
          let pending = ""; // per stream, so two streams never splice a line
          return (chunk) => {
            if (settled) {
              const lines = (pending + chunk).split("\n");
              pending = lines.pop().slice(-4_096);
              for (const line of lines) if (isTunnelError(line)) log(line.trim());
              return;
            }
            output = (output + chunk).slice(-16_384);
            url ??= parseQuickTunnelUrl(output);
            if (url && isTunnelRegistered(output)) {
              settled = true;
              clearTimeout(timer);
              output = "";
              const note = "PUBLIC — anyone with this URL + token can reach your simulator. " +
                           "Anonymous quick tunnel: new hostname every run, no uptime guarantee.";
              resolve(waitForDns(new URL(url).hostname).then((ok) => ({
                url,
                note: ok ? note : `${note} Its DNS name was not answering yet — if the link fails, retry in a minute.`,
              })));
            }
          };
        };
        child.stdout.setEncoding("utf8").on("data", drain());
        child.stderr.setEncoding("utf8").on("data", drain());
        child.on("error", (e) => fail(`cloudflared failed to start: ${e.message}`));
        child.on("exit", (code, signal) => {
          process.off("exit", killOnExit);
          if (proc === child) proc = null;
          if (!settled) fail(`cloudflared exited (${signal || `code ${code}`}) before the tunnel was up:\n${tail()}`);
          else if (!child.stopping) log(`tunnel exited (${signal || `code ${code}`}) — the public link is dead; restart to get a new one`);
        });
      });
    },
    async stop() {
      const child = proc;
      if (!running(child)) return;
      child.stopping = true;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
      await exited;
      clearTimeout(t);
    },
  };
}

function primaryLanIp() {
  const ifaces = os.networkInterfaces();
  // Prefer en0 (typical Wi-Fi/Ethernet on macOS); fall back to any non-loopback IPv4.
  const order = ["en0", ...Object.keys(ifaces).filter((n) => n !== "en0")];
  for (const name of order) {
    for (const a of ifaces[name] || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

const PROVIDERS = {
  "lan": {
    name: "lan",
    prepare() {
      return { host: "0.0.0.0" };
    },
    start({ port }) {
      const ip = primaryLanIp();
      if (!ip) return { url: null, note: "Could not detect a LAN IP — check `ifconfig`." };
      const url = `http://${ip}:${port}/`;
      return { url, note: "Reachable from devices on the same Wi-Fi / LAN." };
    },
  },
  "tailscale-serve": tailscaleProvider("serve"),
  "tailscale-funnel": tailscaleProvider("funnel"),
  "cloudflared": cloudflaredProvider(),
};

export function getRemoteProvider(name) {
  if (!name) return null;
  const p = PROVIDERS[name];
  if (!p) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new Error(`unknown --remote provider: '${name}'. Available: ${known}`);
  }
  return p;
}

export function listRemoteProviders() {
  return Object.keys(PROVIDERS);
}
