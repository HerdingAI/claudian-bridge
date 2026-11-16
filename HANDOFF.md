# Claudian Suite — Session Handoff

Last updated: 2026-11-15

## Repositories & Active Branch (`m0-groundwork`)

| Repo | Path | Role | Latest State |
| :--- | :--- | :--- | :--- |
| **claudian-bridge** | `/home/buntu/dev/claudian-bridge` | Node.js HTTP/SSE server (`:8790`) exposing `claude`, `opencode`, optional `agy`, `faster-whisper` STT, Kokoro ONNX TTS, and `/apk` | `systemd --user` `claudian-bridge.service` active; `createServer(opts)` extracted for tests |
| **claudian-call** | `/home/buntu/dev/claudian-call` | Native Android (Kotlin) screen-off voice client | **`v0.6.8` (`versionCode = 14`)** built and served at `/apk` |
| **claudian-mobile** | `/home/buntu/dev/claudian-mobile` | Cross-platform Obsidian plugin (`claudian-bridge-mobile`) | `vadSilenceMs = 1800`; pure helpers extracted & unit-tested |

## Key Architecture & Recent Changes

1. **Auto Mode Across All Harnesses (`claudian-bridge/server.mjs`)**
   - `claude`: `--permission-mode auto`
   - `opencode`: `--auto`
   - `agy`: `--mode auto` (disabled by default unless `CLAUDIAN_ENABLE_AGY=1`)
   - Plan/Build workflow chip bar and `GET /workflows` were removed.

2. **Compound Engineering Setup (`claudian-bridge/setup.sh`)**
   - Opt-in via `./setup.sh --with-compound-engineering` (without the flag, `setup.sh` does not modify global agent files or skill symlinks).
   - Symlinks `ce-*` and `lfg` skills into `~/.claude/commands/`, `~/.claude/skills/`, `~/.config/opencode/commands/`, `~/.config/opencode/skills/`, and `~/.gemini/antigravity/skills/`, and appends the Compound Engineering block to `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.

3. **Non-Interrupting Voice Capture & Turn Queue (`claudian-call`)**
   - `CallModels.kt`: `vadSilenceMs = 1800L`, `minSpeechMs = 600L`, `bargeIn = false`, with a one-time `prefsVersion = 2` migration in `CallSettings.load()`.
   - `VoiceCallService.kt`: 3-frame (~96 ms) speech-onset debounce (`speechProb >= 0.55f`, `noiseFloorRms * 2.8f`); `enqueueOrStartTurn()` queues follow-up transcripts in `pendingTranscripts` under `queueLock` instead of cancelling `activeChatCall` or `turnJob`; `interruptSpeaking()` stops TTS audio without aborting the active harness turn.

## Build & Verification Commands

- **Bridge syntax & tests** (`/home/buntu/dev/claudian-bridge`):
  ```bash
  node --check server.mjs
  node --test tests/*.test.mjs
  curl -s http://127.0.0.1:8790/health
  curl -s http://127.0.0.1:8790/apk/version
  ```
- **Android APK build** (`/home/buntu/dev/claudian-call`):
  Requires full JDK 17 with `jlink` (installed at `~/.gradle/jdks/jdk-17.0.21+9`):
  ```bash
  JAVA_HOME=~/.gradle/jdks/jdk-17.0.21+9 ./gradlew testDirectDebugUnitTest assembleDirectDebug
  cp app/build/outputs/apk/direct/debug/app-direct-debug.apk dist/claudian-call.apk
  ```
- **Obsidian Mobile plugin** (`/home/buntu/dev/claudian-mobile`):
  ```bash
  npm test && npm run build
  ```
