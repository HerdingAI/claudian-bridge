#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Subcommand: ./setup.sh doctor
if [[ "${1:-}" == "doctor" ]]; then
  echo "=== Claudian Bridge Doctor ==="
  node_bin="$(command -v node || true)"
  if [[ -n "$node_bin" ]]; then
    echo "  [OK] Node.js: $("$node_bin" -v)"
  else
    echo "  [FAIL] Node.js not found — install Node.js >= 20"
  fi
  for cli in claude opencode agy; do
    if command -v "$cli" >/dev/null 2>&1; then
      echo "  [OK] CLI $cli: $(command -v "$cli")"
    else
      echo "  [INFO] CLI $cli: not found on PATH"
    fi
  done
  STT_VENV="${CLAUDIAN_STT_VENV:-$HOME/.venvs/audio}"
  if [[ -x "$STT_VENV/bin/python3" ]] && "$STT_VENV/bin/python3" -c "import faster_whisper, kokoro_onnx" >/dev/null 2>&1; then
    echo "  [OK] Audio venv: $STT_VENV (faster-whisper + kokoro-onnx)"
  else
    echo "  [WARN] Audio venv incomplete — run ./setup.sh"
  fi
  if [[ -f "$HOME/.config/claudian-bridge/config.json" ]]; then
    echo "  [OK] Auth token: ~/.config/claudian-bridge/config.json"
  else
    echo "  [WARN] Auth token missing — run ./setup.sh"
  fi
  if command -v tailscale >/dev/null 2>&1; then
    ts_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
    echo "  [OK] Tailscale IP: ${ts_ip:-not connected}"
  else
    echo "  [INFO] Tailscale not installed"
  fi
  if curl -sf "http://127.0.0.1:${CLAUDIAN_BRIDGE_PORT:-8790}/health" >/dev/null 2>&1; then
    echo "  [OK] Bridge listening on port ${CLAUDIAN_BRIDGE_PORT:-8790}"
  else
    echo "  [WARN] Bridge not responding on port ${CLAUDIAN_BRIDGE_PORT:-8790}"
  fi
  exit 0
fi

# Subcommand: ./setup.sh devices [revoke <id>]
if [[ "${1:-}" == "devices" ]]; then
  DEVICES_FILE="${CLAUDIAN_CONFIG_DIR:-$HOME/.config/claudian-bridge}/devices.json"
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { echo "Error: node not found" >&2; exit 1; }
  if [[ "${2:-}" == "revoke" && -n "${3:-}" ]]; then
    "$NODE_BIN" -e '
      const fs = require("fs"), f = process.argv[1], id = process.argv[2];
      const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
      const next = list.filter(d => d.id !== id);
      if (next.length === list.length) { console.error("Device not found:", id); process.exit(1); }
      fs.writeFileSync(f, JSON.stringify(next, null, 2), { mode: 0o600 });
      console.log("Revoked device:", id);
    ' "$DEVICES_FILE" "$3"
  else
    "$NODE_BIN" -e '
      const fs = require("fs"), f = process.argv[1];
      const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
      if (!list.length) { console.log("No paired per-device tokens."); process.exit(0); }
      for (const d of list) {
        console.log(`${d.id}  ${d.name || "device"}  created=${new Date(d.createdAt || 0).toISOString()}`);
      }
    ' "$DEVICES_FILE"
  fi
  exit 0
fi

# Opt-in flags. Anything that edits global agent config stays off by default.
WITH_CE=0
for arg in "$@"; do
  case "$arg" in
    --with-compound-engineering) WITH_CE=1 ;;
    *) echo "[setup] Unknown option: $arg" >&2; exit 2 ;;
  esac
done

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
  "$STT_VENV/bin/python3" -m pip install --upgrade pip
fi

if ! "$STT_VENV/bin/python3" -c "import faster_whisper, kokoro_onnx, soundfile, qrcode" >/dev/null 2>&1; then
  echo "[setup] Installing faster-whisper, kokoro-onnx, soundfile, and qrcode..."
  "$STT_VENV/bin/python3" -m pip install faster-whisper kokoro-onnx soundfile qrcode
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

install_compound_engineering() {
  local ce_dir=""
  for candidate in \
    "${CLAUDIAN_CE_SKILLS_DIR:-}" \
    "$HOME/.gemini/config/plugins/compound-engineering/skills" \
    "$HOME/.claude/plugins/compound-engineering/skills" \
    "$HOME/.agents/skills"; do
    if [[ -n "$candidate" && -d "$candidate" ]] && compgen -G "$candidate/ce-*/SKILL.md" >/dev/null 2>&1; then
      ce_dir="$candidate"
      break
    fi
  done

  if [[ -n "$ce_dir" ]]; then
    echo "[setup] Installing Compound Engineering commands from $ce_dir..."
    local skill_path skill_name
    for skill_path in "$ce_dir"/ce-* "$ce_dir"/lfg; do
      [[ -f "$skill_path/SKILL.md" ]] || continue
      skill_name="$(basename "$skill_path")"

      if command -v claude >/dev/null 2>&1 || [[ -d "$HOME/.claude" ]]; then
        mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills"
        ln -sfn "$skill_path/SKILL.md" "$HOME/.claude/commands/$skill_name.md"
        ln -sfn "$skill_path" "$HOME/.claude/skills/$skill_name"
      fi

      if command -v opencode >/dev/null 2>&1 || [[ -d "$HOME/.config/opencode" ]]; then
        mkdir -p "$HOME/.config/opencode/commands" "$HOME/.config/opencode/skills"
        ln -sfn "$skill_path/SKILL.md" "$HOME/.config/opencode/commands/$skill_name.md"
        ln -sfn "$skill_path" "$HOME/.config/opencode/skills/$skill_name"
      fi

      if command -v agy >/dev/null 2>&1 || [[ -d "$HOME/.gemini" ]]; then
        mkdir -p "$HOME/.gemini/antigravity/skills"
        ln -sfn "$skill_path" "$HOME/.gemini/antigravity/skills/$skill_name"
      fi
    done
  else
    echo "[setup] Compound Engineering skills directory not found; skipping command symlinks."
  fi

  local marker_start="<!-- claudian-compound-engineering:start -->"
  local marker_end="<!-- claudian-compound-engineering:end -->"
  local ce_block
  ce_block=$(cat <<'CEEOF'
<!-- claudian-compound-engineering:start -->
## Compound Engineering Framework
Use the Compound Engineering workflow when planning, building, reviewing, debugging, or capturing learnings:
- `/ce-brainstorm` — Explore vague ideas, scope, and trade-offs before planning.
- `/ce-plan` — Produce a concrete step-by-step implementation plan.
- `/ce-work` — Execute a plan or spec end-to-end and verify locally.
- `/ce-code-review` — Review changes for bugs, regressions, edge cases, and tests.
- `/ce-debug` — Run structured root-cause diagnosis and minimal verified fixes.
- `/ce-compound` — Document solved problems and prevention rules as durable learnings.
<!-- claudian-compound-engineering:end -->
CEEOF
)

  local target_file
  for target_file in \
    "$HOME/.claude/CLAUDE.md" \
    "$HOME/.config/opencode/AGENTS.md" \
    "$HOME/.gemini/GEMINI.md" \
    "$WORKSPACE_DEFAULT/AGENTS.md" \
    "$WORKSPACE_DEFAULT/CLAUDE.md"; do
    mkdir -p "$(dirname "$target_file")"
    touch "$target_file"
    if ! grep -qF "$marker_start" "$target_file"; then
      printf '\n%s\n' "$ce_block" >> "$target_file"
    fi
  done
}

if [[ "$WITH_CE" == "1" ]]; then
  install_compound_engineering
else
  echo "[setup] Skipping Compound Engineering install and global CLAUDE.md/AGENTS.md/GEMINI.md edits (pass --with-compound-engineering to enable)."
fi

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
