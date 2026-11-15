#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: Node.js (>=20) not found in PATH. Install Node.js 20+ and re-run ./setup.sh." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Error: Node.js >=20 required (found v$("$NODE_BIN" -v))." >&2
  exit 1
fi

PY_BIN="$(command -v python3 || true)"
if [[ -z "$PY_BIN" ]]; then
  echo "Error: python3 not found in PATH. Install Python 3.10+ and re-run ./setup.sh." >&2
  exit 1
fi

STT_VENV="${CLAUDIAN_STT_VENV:-$HOME/.venvs/audio}"
if [[ ! -x "$STT_VENV/bin/python3" ]]; then
  echo "[setup] Creating Python audio venv at $STT_VENV..."
  "$PY_BIN" -m venv "$STT_VENV"
  "$STT_VENV/bin/pip" install --upgrade pip
fi

if ! "$STT_VENV/bin/python3" -c "import faster_whisper, kokoro_onnx, soundfile, qrcode" >/dev/null 2>&1; then
  echo "[setup] Installing faster-whisper, kokoro-onnx, soundfile, and qrcode..."
  "$STT_VENV/bin/pip" install faster-whisper kokoro-onnx soundfile qrcode
fi

KOKORO_DIR="${CLAUDIAN_KOKORO_ROOT:-$HOME/.cache/claudian-bridge}/models/kokoro"
ALT_KOKORO_DIR="$HOME/.cache/obsidian-read-aloud/models/kokoro"
if [[ ! -f "$KOKORO_DIR/kokoro-v1.0.int8.onnx" && ! -f "$ALT_KOKORO_DIR/kokoro-v1.0.int8.onnx" ]]; then
  echo "[setup] Downloading Kokoro v1.0 ONNX voice models (~90 MB)..."
  mkdir -p "$KOKORO_DIR"
  curl -fL --progress-bar \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx" \
    -o "$KOKORO_DIR/kokoro-v1.0.int8.onnx"
  curl -fL --progress-bar \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" \
    -o "$KOKORO_DIR/voices-v1.0.bin"
fi

WORKSPACE_DEFAULT="${CLAUDIAN_WORKSPACE_DIR:-$HOME/dev}"
mkdir -p "$WORKSPACE_DEFAULT"

if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

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
  systemctl --user restart claudian-bridge.service
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
else
  echo "[setup] systemd --user not available; starting claudian-bridge in background..."
  nohup env CLAUDIAN_WORKSPACE_DIR="$WORKSPACE_DEFAULT" "$NODE_BIN" "$DIR/server.mjs" \
    >"$HOME/.cache/claudian-bridge.log" 2>&1 &
fi

for _ in $(seq 1 15); do
  if curl -sf http://127.0.0.1:8790/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

TOKEN=""
if [[ -f "$HOME/.config/claudian-bridge/config.json" ]]; then
  TOKEN="$("$NODE_BIN" -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.config/claudian-bridge/config.json','utf8')).token)")"
fi

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
LAN_IP="$("$NODE_BIN" -e "const os=require('os');for(const e of Object.values(os.networkInterfaces()))for(const i of e||[])if(i.family==='IPv4'&&!i.internal&&!i.address.startsWith('100.')){console.log(i.address);process.exit(0)}")"
PRIMARY_IP="${TS_IP:-${LAN_IP:-127.0.0.1}}"
PRIMARY_URL="http://$PRIMARY_IP:8790"
PAIR_URI="claudian://pair?url=$PRIMARY_URL&token=$TOKEN"

echo ""
echo "=========================================="
echo " claudian-bridge is running!"
echo "=========================================="
[[ -n "$TS_IP" ]] && echo "  Tailscale URL : http://$TS_IP:8790"
[[ -n "$LAN_IP" ]] && echo "  LAN URL       : http://$LAN_IP:8790 (mDNS auto-discovery active)"
echo "  Auth Token    : $TOKEN"
echo "  Workspace     : $WORKSPACE_DEFAULT"
echo "  Pairing Link  : $PAIR_URI"
echo "  Health Check  : curl -s http://127.0.0.1:8790/health"
echo ""

if [[ -n "$TOKEN" ]]; then
  echo "Scan this QR code from your phone to pair Claudian Call:"
  "$STT_VENV/bin/python3" - "$PAIR_URI" <<'PYEOF' || true
import sys, qrcode
qr = qrcode.QRCode(border=1)
qr.add_data(sys.argv[1])
qr.make(fit=True)
qr.print_ascii(invert=True)
PYEOF
fi
