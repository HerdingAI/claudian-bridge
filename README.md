# Claudian Bridge

Lightweight, zero-dependency Node.js HTTP/SSE bridge server that exposes **Claude Code** (`claude`), **Antigravity** (`agy`), **OpenCode** (`opencode`), local **faster-whisper STT**, and local **Kokoro TTS** to **Claudian Mobile** and **Claudian Call** over Tailscale or LAN.

## Quick Start

```bash
node server.mjs
```

On first run, an auth token is generated and saved atomically to `~/.config/claudian-bridge/config.json` (`0600`).

For always-on operation across reboots and power loss, run via `systemd --user` (`~/.config/systemd/user/claudian-bridge.service`) with `loginctl enable-linger` and `Restart=always` / `StartLimitIntervalSec=0`.

## Configuration (Environment Variables)

- `CLAUDIAN_BRIDGE_PORT` (default: `8790`)
- `CLAUDIAN_BRIDGE_HOST` (default: `0.0.0.0`)
- `CLAUDIAN_WORKSPACE_DIR` (default workspace directory, defaults to `~/dev` if present, else `$HOME`; `CLAUDIAN_VAULT_DIR` is supported as a legacy alias)
- `CLAUDIAN_WORKSPACES_ROOT` (root directory scanned by `GET /workspaces` and target for `POST /workspaces`, defaults to `CLAUDIAN_WORKSPACE_DIR`)
- `CLAUDIAN_OBSIDIAN_VAULT` (target Obsidian vault for `POST /vault/save`, defaults to `CLAUDIAN_WORKSPACE_DIR`)
- `CLAUDIAN_CLAUDE_BIN` (path to `claude` CLI)
- `CLAUDIAN_AGY_BIN` (path to `agy` CLI)
- `CLAUDIAN_OPENCODE_BIN` (path to `opencode` CLI)
- `CLAUDIAN_STT_PYTHON` (Python executable with `faster-whisper`; automatically prefers `~/.venvs/audio/bin/python3` over system `PATH` and prepends its `nvidia/*/lib` paths to `LD_LIBRARY_PATH`)
- `CLAUDIAN_STT_WORKER` (path to `stt_worker.py`)
- `CLAUDIAN_STT_MODEL` (default: `small`)
- `CLAUDIAN_BRIDGE_TOKEN` (optional override for bearer token)

## Endpoints

- `GET /health` — Service readiness status (`ok`, `vault`, `claude`, `agy`, `opencode`, `stt`, `tts`)
- `GET /apk/version` — Returns built `claudian-call` APK metadata (`versionCode`, `versionName`, `size`, `mtimeMs`) for in-app self-update
- `GET / HEAD /apk` — Serves the latest `claudian-call` APK from `dist/claudian-call.apk` or Gradle build outputs
- `GET /workspaces` — Lists available workspace directories under `CLAUDIAN_WORKSPACES_ROOT`
- `POST /workspaces` — Creates a new project/topic folder `{ name }` inside `CLAUDIAN_WORKSPACES_ROOT`
- `GET /workflows` — Lists Compound Engineering workflow presets (`general`, `ce-brainstorm`, `ce-plan`, `ce-work`, `ce-code-review`, `ce-debug`, `ce-compound`)
- `GET /models?provider=claude|agy|opencode` — Dynamically lists available models for the selected provider (5-minute cache; falls back to `Default (auto)` if a CLI is unavailable)
- `GET /sessions?cwd=...` — Lists workspace-scoped sessions across `~/.config/claudian-bridge/sessions.json` (all providers), `.claudian/sessions/`, and Claude Code `.jsonl` files
- `GET /sessions/:sessionId/messages` — Loads session history across all providers
- `POST /sessions/:sessionId/recap` — Generates a 5-second spoken catch-up summary of recent turns
- `POST /vault/save` — Saves a dated Markdown note (`{ title, content, workspace, sessionId }`) into `<CLAUDIAN_OBSIDIAN_VAULT>/Voice Notes/`
- `POST /chat` — Streams SSE events (`session`, `status`, `text`, `done`, `error`) from `claude`, `agy`, or `opencode` with spoken-first formatting, workflow guidance, workspace isolation, and full web/MCP tool access
- `POST /stt` — Transcribes 16 kHz WAV audio (`audio/wav` binary or `{ wavBase64, language }` JSON) via `faster-whisper` (CUDA with automatic CPU `int8` fallback)
- `POST /tts` — Synthesizes WAV audio via Kokoro ONNX

## Resilience & Performance

- Pre-warms `sttWorker` and `ttsWorker` on startup so the first voice turn has no cold-start delay.
- Preloads NVIDIA CUDA libraries (`libcudart` → `libcublasLt` → `libcublas` → `libcudnn`) and injects venv `nvidia/*/lib` directories into `LD_LIBRARY_PATH`, falling back to CPU `int8` automatically if CUDA fails at runtime.
- Enforces startup (`60s`) and per-request (`45s`) worker timeouts, sends 15-second SSE `: keepalive` heartbeats on `/chat`, and automatically respawns crashed Python workers.
- Sweeps stale `/tmp/bridge-stt-*.wav` and `/tmp/bridge-tts-*.wav` files on startup and shuts down workers cleanly on `SIGTERM`/`SIGINT`.
- Run `./setup.sh` for guided community installation, or package with `tar -czf dist/claudian-bridge-0.1.0.tar.gz server.mjs stt_worker.py setup.sh package.json README.md LICENSE`.
