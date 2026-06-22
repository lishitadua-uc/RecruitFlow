#!/bin/bash
# ============================================================
#  RecruitFlow — one-click launcher (macOS)
#  Double-click this file to start RecruitFlow on your laptop.
#  It installs everything it needs the first time (one-time, ~2 min).
# ============================================================
cd "$(dirname "$0")" || exit 1
echo "Starting RecruitFlow…"

# ---- 1. Make sure Node.js is available (install a private copy if not) ----
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$HOME/.local/node/bin/node" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"; NODE_BIN="$HOME/.local/node/bin/node"
else
  echo "First-time setup: installing Node.js (this only happens once)…"
  ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && NARCH="darwin-arm64" || NARCH="darwin-x64"
  mkdir -p "$HOME/.local"
  FN="$(curl -s "https://nodejs.org/dist/latest-v22.x/" | grep -o "node-v[0-9.]*-$NARCH.tar.gz" | head -1)"
  curl -# -L -o /tmp/rf-node.tar.gz "https://nodejs.org/dist/latest-v22.x/$FN" || { echo "Download failed — check your internet."; read -r _; exit 1; }
  tar -xzf /tmp/rf-node.tar.gz -C "$HOME/.local"
  rm -rf "$HOME/.local/node"; mv "$HOME/.local/${FN%.tar.gz}" "$HOME/.local/node"
  export PATH="$HOME/.local/node/bin:$PATH"; NODE_BIN="$HOME/.local/node/bin/node"
fi
echo "Using Node: $($NODE_BIN -v)"

# ---- 2. Install dependencies the first time ----
if [ ! -d node_modules ]; then
  echo "Installing app components (one-time, downloads a headless browser ~few min)…"
  "$HOME/.local/node/bin/npm" install --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
fi

# ---- 3. Start the app and open the dashboard ----
echo "Launching dashboard… a browser tab will open at http://localhost:3000"
# 'caffeinate' keeps macOS awake (screen may still lock/dim) so candidates keep
# getting replies even when the laptop is locked. It stops when RecruitFlow stops.
#   -d prevent display sleep   -i prevent idle sleep
#   -m prevent disk sleep      -s keep system awake while on power
if command -v caffeinate >/dev/null 2>&1; then
  (caffeinate -dims "$NODE_BIN" server.js) &
else
  ("$NODE_BIN" server.js) &
fi
SRV=$!
# wait for it to come up, then open the browser
for i in $(seq 1 40); do
  if curl -s -o /dev/null http://localhost:3000/ ; then break; fi
  sleep 1
done
open "http://localhost:3000"
echo ""
echo "============================================================"
echo " RecruitFlow is running.  Keep this window OPEN while you use it."
echo " Close this window (or press Ctrl+C) to stop RecruitFlow."
echo "============================================================"
wait $SRV
