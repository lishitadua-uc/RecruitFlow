#!/bin/bash
# ============================================================
#  RecruitFlow — one-click launcher (macOS)
#  Double-click to start. Shows each step so you always know
#  it's working. Reuses your installed Chrome to avoid a big
#  one-time download.
# ============================================================
cd "$(dirname "$0")" || exit 1
clear
echo "============================================================"
echo "   RecruitFlow — starting up"
echo "============================================================"

# ---- [1/4] Node.js ----
echo ""
echo "[1/4] Checking Node.js…"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$HOME/.local/node/bin/node" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"; NODE_BIN="$HOME/.local/node/bin/node"
else
  echo "      First-time: installing a private Node.js (one-time)…"
  ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && NARCH="darwin-arm64" || NARCH="darwin-x64"
  mkdir -p "$HOME/.local"
  FN="$(curl -s "https://nodejs.org/dist/latest-v22.x/" | grep -o "node-v[0-9.]*-$NARCH.tar.gz" | head -1)"
  curl -# -L -o /tmp/rf-node.tar.gz "https://nodejs.org/dist/latest-v22.x/$FN" || { echo "      Download failed — check your internet."; read -r _; exit 1; }
  tar -xzf /tmp/rf-node.tar.gz -C "$HOME/.local"
  rm -rf "$HOME/.local/node"; mv "$HOME/.local/${FN%.tar.gz}" "$HOME/.local/node"
  export PATH="$HOME/.local/node/bin:$PATH"; NODE_BIN="$HOME/.local/node/bin/node"
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM_BIN" ] || NPM_BIN="npm"
echo "      ✓ Node $($NODE_BIN -v)"

# ---- [2/4] Reuse installed Chrome (skips a ~200MB download) ----
echo ""
echo "[2/4] Looking for Google Chrome…"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CH" ]; then
  export CHROME_PATH="$CH"; export PUPPETEER_SKIP_DOWNLOAD=true
  echo "      ✓ Found Chrome — reusing it (skips a big one-time download, much faster)."
else
  echo "      ⚠ Chrome not found — will download a browser once (~200MB; the slow bit)."
  echo "        Tip: install Google Chrome first to make this near-instant."
fi

# ---- [3/4] Install components (with a live elapsed timer) ----
echo ""
echo "[3/4] Installing app components…"
if [ ! -d node_modules ]; then
  # Use a project-local npm cache so a root-owned/broken ~/.npm (from a past `sudo npm`) can't
  # block the install with an EACCES permission error.
  ( "$NPM_BIN" install --no-audit --no-fund --prefer-offline --loglevel=error --cache "$(pwd)/.npm-cache" > /tmp/rf-install.log 2>&1 ) &
  IPID=$!
  SECS=0
  while kill -0 "$IPID" 2>/dev/null; do
    printf "\r      working… %3ss elapsed (first run downloads once; then it's instant)" "$SECS"
    sleep 2; SECS=$((SECS+2))
  done
  printf "\r"
  if ! wait "$IPID"; then
    echo "      ✗ Install failed. Last lines:"; tail -8 /tmp/rf-install.log; echo ""
    echo "      Check your internet and double-click this file again."; read -r _; exit 1
  fi
  echo "      ✓ Components ready (${SECS}s).                                        "
else
  echo "      ✓ Already installed."
fi

# ---- [4/4] Launch + open the dashboard ----
echo ""
echo "[4/4] Launching dashboard…"
if command -v caffeinate >/dev/null 2>&1; then
  ( caffeinate -dims "$NODE_BIN" server.js ) &
else
  ( "$NODE_BIN" server.js ) &
fi
SRV=$!
printf "      waiting for the app"
for i in $(seq 1 40); do
  if curl -s -o /dev/null http://localhost:3000/ ; then break; fi
  printf "."; sleep 1
done
printf "\n"
open "http://localhost:3000"
echo "      ✓ Dashboard open at http://localhost:3000"
echo ""
echo "============================================================"
echo "  RecruitFlow is running. Click the WhatsApp status and scan"
echo "  the QR (WhatsApp → Settings → Linked Devices → Link a Device)."
echo "  Keep this window OPEN. Close it (or Ctrl+C) to stop."
echo "============================================================"
wait $SRV
