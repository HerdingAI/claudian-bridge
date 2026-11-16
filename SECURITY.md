# Security Architecture

Claudian Bridge is designed for **private workstation-to-phone control** with zero cloud relay.

## What It Does & Does Not Do
- **No cloud relay or telemetry**: Audio, transcripts, and code never leave your machine + Tailscale/LAN link.
- **No credential scraping**: The bridge only invokes your already-signed-in local CLIs (`claude`, `opencode`, optional `agy`).

## Controls Enforced

1. **Authentication & Per-Device Tokens**
   - Unauthenticated `GET /health` returns only `{ ok, version }`. Every other route (including `/apk`, `/apk/version`, `/workspaces`, `/jobs`, `/approvals`, `/stt`, `/tts`) requires a valid `Bearer` token.
   - Tokens are compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests).
   - Per-device tokens issued via `POST /devices` are stored as SHA-256 hashes in `~/.config/claudian-bridge/devices.json` (`0600`) and can be revoked anytime via `DELETE /devices/:id` or `./setup.sh devices revoke <id>`.
   - Per-IP failed-auth brute-force backoff engages with `429 Retry-After` after 5 wrong token guesses.

2. **Workspace Confinement & Policy Engine**
   - `cwd` on `/chat` and `/jobs` is validated via `fs.realpathSync` to stay strictly inside `CLAUDIAN_WORKSPACES_ROOT` (`..`, outside paths, and symlink escapes are rejected with `400`).
   - `policy-engine.mjs` denies tool paths outside the workspace (blocking prompt-injection escapes such as `~/.ssh`) and requires explicit approval (`POST /approvals/:id`) for non-allowlisted shell commands and network fetches, with a 10-minute auto-deny timeout.

3. **Network & CORS**
   - CORS only permits `app://obsidian.md`, `capacitor://localhost`, and `http://localhost` (evil origins receive no `Access-Control-Allow-Origin` and `403` on preflight).
   - `CLAUDIAN_BIND` defaults to `0.0.0.0` for LAN/Tailscale convenience and logs a startup warning; set `CLAUDIAN_BIND=<tailscale-ip>` or `127.0.0.1` to restrict.

4. **Android Client Hardening (`claudian-call`)**
   - Auth tokens are encrypted at rest using **AndroidKeyStore** (`AES/GCM/NoPadding`), with `android:allowBackup="false"`.
   - `claudian://pair` deep links require tapping **Pair** on a host confirmation dialog before saving.
   - Cleartext HTTP is permitted only for private RFC1918, localhost, `.local`/`.ts.net`, and Tailscale CGNAT (`100.64.0.0/10`) hosts; public hosts require HTTPS.
   - `/apk` updates require auth and verify both **SHA-256** and **signing certificate** match before installing.

5. **Audit Log**
   - Sensitive actions (auth failures, device changes, job starts, workspace creation, permission decisions) append JSON lines to `~/.config/claudian-bridge/audit.jsonl` (`0600`).
