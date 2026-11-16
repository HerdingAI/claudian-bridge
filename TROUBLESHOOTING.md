# Troubleshooting

## 1. Bridge Not Reachable from Phone
- Run `./setup.sh doctor` on your workstation to verify Node.js, CLIs, audio venv, Tailscale IP, and `/health`.
- Check the service status and logs:
  ```bash
  systemctl --user status claudian-bridge.service
  journalctl --user -u claudian-bridge.service -n 50 --no-pager
  ```
- Make sure **Tailscale** is active on both your workstation and phone (or both are on the same Wi-Fi LAN), and verify your URL uses port `8790` (e.g. `http://100.x.y.z:8790`).

## 2. `401 Unauthorized` on `/apk` or `/stt`
- Check your token in `~/.config/claudian-bridge/config.json`, or re-scan the QR code printed by `./setup.sh`.
- If your phone is on an older pre-M1 APK (`<= build 14` before token-gated `/apk`), **Check for App Update** will receive `401` when querying `/apk/version`. Install `v0.6.9+` once from [GitHub Releases](https://github.com/HerdingAI/claudian-call/releases) or via `adb install`; all future in-app updates will authenticate automatically.

## 3. Voice Cuts Off Too Early or Background Noise Triggers Turns
- Default VAD settings in `claudian-call` `v0.6.9` (`prefsVersion = 3`):
  - **VAD Silence**: `1800 ms` (increase in **⚙ Settings** up to `5000 ms` if you pause longer mid-sentence)
  - **Min Speech**: `200 ms` (captures short `"Yes"` / `"No"` replies while 3-frame ~96 ms onset gating rejects brief bumps)
  - **Barge-In**: Off by default so ambient noise never interrupts TTS or aborts the running agent.

## 4. `claude` or `opencode` Not Found
- Ensure the CLI is installed and on your user `PATH` (e.g. `~/.nvm/versions/node/*/bin` or `~/.local/bin`), or set `CLAUDIAN_CLAUDE_BIN` / `CLAUDIAN_OPENCODE_BIN` in `~/.config/systemd/user/claudian-bridge.service` and run `systemctl --user daemon-reload && systemctl --user restart claudian-bridge.service`.

## 5. Building Android APK from Source Fails with `jlink` Error
- Gradle 8.9 + AGP requires a **full JDK 17** (with `javac` and `jlink`, not JRE-only `openjdk-17-jre-headless`). Point `JAVA_HOME` to a full JDK 17 (e.g. Eclipse Temurin 17):
  ```bash
  JAVA_HOME=~/.gradle/jdks/jdk-17.0.21+9 ./gradlew assembleDirectDebug
  ```
