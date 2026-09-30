#!/usr/bin/env bash
# sim-stream: boot an iOS simulator and serve it to a web browser.
#
# Usage:
#   ./scripts/start.sh                           # auto-pick a simulator, start server
#   ./scripts/start.sh --list                    # list available simulators and exit
#   ./scripts/start.sh --udid <UDID>             # use a specific simulator
#   ./scripts/start.sh --device primary          # a QA-bench device over WDA (qa-device up primary first)
#   ./scripts/start.sh --port 9090               # custom port (default 8080)
#   ./scripts/start.sh --remote lan              # bind to 0.0.0.0 (LAN access)
#   ./scripts/start.sh --remote tailscale-serve  # private HTTPS over tailnet
#   ./scripts/start.sh --remote tailscale-funnel # PUBLIC HTTPS via Funnel
#   ./scripts/start.sh --remote cloudflared      # PUBLIC HTTPS, anonymous quick tunnel
#   ./scripts/start.sh --share demo=2h           # also mint a link that expires (repeatable)
#   ./scripts/start.sh --no-auth                 # disable token auth (local only!)
# Also builds the optional H.264 encoder helper when `swift` is available.
# Any extra flags are passed through to node server.js. See README.md for the
# full --remote provider list and prerequisites.

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

# Device mode (--device) drives WebDriverAgent and needs go-ios, not AXe; the
# server checks for both itself.
DEVICE_MODE=0
for arg in "$@"; do [[ "$arg" == "--device" ]] && DEVICE_MODE=1; done

if [[ "$DEVICE_MODE" == 0 ]] && ! command -v axe >/dev/null 2>&1; then
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

# The H.264 encoder helper is an optional upgrade (30 fps video on /video).
# Build it when there is a Swift toolchain and the binary is missing or older
# than its sources; on any failure carry on — the server then serves MJPEG
# only, and says so at startup.
ENCODER="helper/.build/release/sim-stream-encoder"
if command -v swift >/dev/null 2>&1; then
  if [[ ! -x "$ENCODER" ]] || [[ -n "$(find helper/Package.swift helper/Sources -newer "$ENCODER" -print -quit 2>/dev/null)" ]]; then
    echo "[sim-stream] building the H.264 encoder helper (a minute the first time)..."
    if ! BUILD_LOG="$(swift build -c release --package-path helper 2>&1)"; then
      echo "[sim-stream] helper build failed — continuing without it (an earlier build, if any, is still used):"
      echo "$BUILD_LOG" | tail -n 15 | sed 's/^/    /'
    fi
  fi
fi

# Translate --no-auth into --auth false, which server.js expects.
# Avoid bash 3.2 empty-array pitfalls by building a string and re-splitting.
if [[ "${1:-}" == "--no-auth" ]]; then
  shift
  exec node server.js --auth false "$@"
else
  exec node server.js "$@"
fi
