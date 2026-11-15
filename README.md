# Claudian Bridge

Lightweight, zero-dependency Node.js HTTP/SSE bridge server that exposes **Claude Code** (`claude`), **Antigravity** (`agy`), **OpenCode** (`opencode`), local **faster-whisper STT**, and local **Kokoro TTS** to **Claudian Mobile** and **Claudian Call** over Tailscale or LAN.

## Quick Start (2-Step Setup)

```bash
git clone https://github.com/HerdingAI/claudian-bridge.git
cd claudian-bridge
./setup.sh
```

`./setup.sh` automatically:
1. Creates `~/.venvs/audio` and installs `faster-whisper`, `kokoro-onnx`, `soundfile`, and `qrcode`.
2. Downloads the Kokoro v1.0 ONNX voice models (`kokoro-v1.0.int8.onnx` & `voices-v1.0.bin`) into `~/.cache/claudian-bridge/models/kokoro/`.
3. Generates an auth token in `~/.config/claudian-bridge/config.json` (`0600`).
4. Installs and starts `systemd --user` (`claudian-bridge.service`) on Linux (with `loginctl enable-linger` and `Restart=always`), or starts in background when `systemd --user` is unavailable.
5. **Opt-in only** (`./setup.sh --with-compound-engineering`): installs Compound Engineering slash commands (`ce-*`, `lfg`) and instructions into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` for `claude`, `opencode`, and `agy`. Without the flag, setup never edits global agent files or skill symlinks.
6. Advertises `_claudian._tcp.local` via mDNS for LAN auto-discovery and prints a **scannable QR code** (`claudian://pair?url=...&token=...`) for 1-tap pairing in **Claudian Call** over LAN or Tailscale.

> To run manually without `setup.sh`: `node server.mjs`

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
- `GET /models?provider=claude|agy|opencode` — (`agy` is disabled unless `CLAUDIAN_ENABLE_AGY=1`; `/chat` with `agy`/`antigravity` returns an error event too) Dynamically lists available models for the selected provider (5-minute cache; falls back to `Default (auto)` if a CLI is unavailable)
- `GET /sessions?cwd=...` — Lists workspace-scoped sessions across `~/.config/claudian-bridge/sessions.json` (all providers), `.claudian/sessions/`, and Claude Code `.jsonl` files
- `GET /sessions/:sessionId/messages` — Loads session history across all providers
- `POST /sessions/:sessionId/recap` — Generates a 5-second spoken catch-up summary of recent turns
- `POST /vault/save` — Saves a dated Markdown note (`{ title, content, workspace, sessionId }`) into `<CLAUDIAN_OBSIDIAN_VAULT>/Voice Notes/`
- `POST /chat` — Streams SSE events (`session`, `status`, `text`, `done`, `error`) from `claude`, `agy`, or `opencode` in auto mode (`--permission-mode auto` / `--mode auto` / `--auto`) with spoken-first formatting, workspace isolation, and full web/MCP tool access
- `POST /stt` — Transcribes 16 kHz WAV audio (`audio/wav` binary or `{ wavBase64, language }` JSON) via `faster-whisper` (CUDA with automatic CPU `int8` fallback)
- `POST /tts` — Synthesizes WAV audio via Kokoro ONNX

## Resilience & Performance

- Pre-warms `sttWorker` and `ttsWorker` on startup so the first voice turn has no cold-start delay.
- Preloads NVIDIA CUDA libraries (`libcudart` → `libcublasLt` → `libcublas` → `libcudnn`) and injects venv `nvidia/*/lib` directories into `LD_LIBRARY_PATH`, falling back to CPU `int8` automatically if CUDA fails at runtime.
- Enforces startup (`60s`) and per-request (`45s`) worker timeouts, sends 15-second SSE `: keepalive` heartbeats on `/chat`, and automatically respawns crashed Python workers.
- Sweeps stale `/tmp/bridge-stt-*.wav` and `/tmp/bridge-tts-*.wav` files on startup and shuts down workers cleanly on `SIGTERM`/`SIGINT`.
- Run `./setup.sh` for guided community installation, or package with `tar -czf dist/claudian-bridge-0.1.0.tar.gz server.mjs stt_worker.py setup.sh package.json README.md LICENSE`.

## Claudian Suite

- **[Claudian Mobile](https://github.com/HerdingAI/claudian-mobile)** — Mobile-compatible (`isDesktopOnly: false`) Obsidian plugin for iOS, Android, and Desktop that connects to `claudian-bridge`.
- **[Claudian Call](https://github.com/HerdingAI/claudian-call)** — Native Android app for screen-off, phone-call-style voice conversations with `claudian-bridge`.
- **[Claudian Voice](https://github.com/HerdingAI/claudian-voice)** — Desktop Obsidian plugin adding local `faster-whisper` STT and Kokoro TTS directly to Claudian.

## License

MIT — see [LICENSE](LICENSE).
