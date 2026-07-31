// Pluggable remote-access providers for sim-stream.
//
// One flag — `--remote <name>` — selects how the server is exposed beyond
// localhost. Each provider implements a tiny interface so adding a new one
// (e.g. cloudflared, ngrok) is just a new entry in PROVIDERS — no server
// changes required.
//
//   prepare()                -> { host? }                    // before listen()
//   start({ port, token })   -> { url, note? } | Promise     // after  listen()
//   stop()                   -> void | Promise               // on shutdown
//
// Every hook is OPTIONAL — the server calls each through optional chaining, so
// a provider implements only what it needs (`lan` has no stop()). But one that
// spawns a long-lived process must implement stop(), or it leaks past exit.
//
// Built-ins:
//   lan               — bind on 0.0.0.0, reachable on the local network
//   tailscale-serve   — private HTTPS on the tailnet (auto TLS via MagicDNS)
//   tailscale-funnel  — PUBLIC HTTPS via Tailscale Funnel

import { execFileSync } from "node:child_process";
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
    start({ port, token }) {
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
      const url = `https://${host}/${token ? `?token=${token}` : ""}`;
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
    start({ port, token }) {
      const ip = primaryLanIp();
      if (!ip) return { url: null, note: "Could not detect a LAN IP — check `ifconfig`." };
      const url = `http://${ip}:${port}/${token ? `?token=${token}` : ""}`;
      return { url, note: "Reachable from devices on the same Wi-Fi / LAN." };
    },
  },
  "tailscale-serve": tailscaleProvider("serve"),
  "tailscale-funnel": tailscaleProvider("funnel"),
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
