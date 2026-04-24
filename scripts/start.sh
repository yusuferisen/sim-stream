#!/usr/bin/env bash
# sim-stream: boot an iOS simulator and serve it to a web browser.
#
# Usage:
#   ./scripts/start.sh                # auto-pick a simulator, start server
#   ./scripts/start.sh --list         # list available simulators and exit
#   ./scripts/start.sh --udid <UDID>  # use a specific simulator
#   ./scripts/start.sh --port 9090    # custom port (default 8080)
#   ./scripts/start.sh --host 0.0.0.0 # expose on LAN (default 127.0.0.1)
#   ./scripts/start.sh --no-auth      # disable token auth (local only!)
# Any extra flags are passed through to node server.js.

set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if [[ "${1:-}" == "--list" ]]; then
  xcrun simctl list devices available --json | node -e '
    let raw = ""; process.stdin.on("data", (d) => raw += d);
    process.stdin.on("end", () => {
      const data = JSON.parse(raw);
      for (const rt of Object.keys(data.devices)) {
        const rtShort = rt.replace("com.apple.CoreSimulator.SimRuntime.", "");
        const devs = data.devices[rt].filter((d) => d.isAvailable);
        if (devs.length === 0) continue;
        console.log("\n" + rtShort);
        for (const d of devs) {
          const marker = d.state === "Booted" ? "●" : " ";
          console.log(`  ${marker} ${d.udid}  ${d.name.padEnd(30)} ${d.state}`);
        }
      }
    });
  '
  exit 0
fi

if ! command -v axe >/dev/null 2>&1; then
  echo ""
  echo "  AXe CLI is required but not installed."
  echo ""
  echo "  Install it with:"
  echo "      brew install cameroncooke/axe/axe"
  echo ""
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "[sim-stream] installing node dependencies..."
  npm install --silent
fi

# Translate --no-auth into --auth false, which server.js expects.
# Avoid bash 3.2 empty-array pitfalls by building a string and re-splitting.
if [[ "${1:-}" == "--no-auth" ]]; then
  shift
  exec node server.js --auth false "$@"
else
  exec node server.js "$@"
fi
