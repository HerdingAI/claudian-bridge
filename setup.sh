#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: Node.js (>=20) not found in PATH." >&2
  exit 1
fi

STT_VENV="${CLAUDIAN_STT_VENV:-$HOME/.venvs/audio}"
if [[ ! -x "$STT_VENV/bin/python3" ]]; then
  echo "[setup] Creating Python STT venv at $STT_VENV..."
  python3 -m venv "$STT_VENV"
  "$STT_VENV/bin/pip" install --upgrade pip
  "$STT_VENV/bin/pip" install faster-whisper
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
WORKSPACE_DEFAULT="${CLAUDIAN_WORKSPACE_DIR:-$HOME/dev}"
mkdir -p "$WORKSPACE_DEFAULT"

cat > "$UNIT_DIR/claudian-bridge.service" <<EOF
[Unit]
Description=Claudian Bridge Server
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/server.mjs
Restart=always
RestartSec=2
TimeoutStopSec=10
Environment=CLAUDIAN_WORKSPACE_DIR=$WORKSPACE_DEFAULT
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claudian-bridge.service
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

sleep 2
TOKEN=""
if [[ -f "$HOME/.config/claudian-bridge/config.json" ]]; then
  TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.config/claudian-bridge/config.json','utf8')).token)")"
fi
TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || echo '127.0.0.1')"

echo ""
echo "claudian-bridge is running!"
echo "  Bridge URL : http://$TS_IP:8790"
echo "  Auth Token : $TOKEN"
echo "  Workspace  : $WORKSPACE_DEFAULT"
echo "  Health     : curl -s http://127.0.0.1:8790/health"
