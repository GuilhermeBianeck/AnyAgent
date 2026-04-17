# Troubleshooting

Common first-run failures, grouped by anchor so `setup.sh` / `add-worker.sh` can
link directly to a fix.

---

## nodejs-missing

**Symptom:** `Node.js not found`

**Fix:**
- **macOS:** `brew install node@20`
- **Ubuntu/Debian:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install nodejs`
- **Any OS via nvm:** `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 20`

Then re-run `./setup.sh`.

## nodejs-too-old

**Symptom:** `Node.js 20 found, 22+ required.`

**Fix:** the hub needs Node **22+** (for the built-in `node:sqlite`). If you're locked to an older version, use `nvm`:
```bash
nvm install 22
nvm use 22
./setup.sh
```
Worker machines still accept Node 20+.

## native-build-deps

**Symptom:** npm install fails on `node-pty` with `gyp ERR!` and `Python not found` (worker only — the hub no longer has native deps since v1.1).

**Fix (hub):** upgrade to **Node 22+**. The hub uses the built-in `node:sqlite` module and needs no compiler. `nvm install 22` then re-run `./setup.sh`.

**Fix (worker):** node-pty ships prebuilt binaries for most platforms — if yours is missing, install build tools:
- **macOS:** `xcode-select --install` (installs Clang + python3)
- **Ubuntu/Debian:** `sudo apt install python3 build-essential`
- **Fedora/RHEL:** `sudo dnf install python3 gcc gcc-c++ make`
- **Alpine (Docker):** `apk add python3 build-base`

After installing, delete `worker/node_modules` and re-run `./add-worker.sh`.

## sdk-build-failed / hub-build-failed / worker-build-failed

**Symptom:** `npm run build` fails with TypeScript errors.

**Fix:** ensure you ran `(cd sdk && npm run build)` before the hub/worker build. The hub and worker depend on `@anyagent/sdk` as a file dependency, so the SDK must be built first.

```bash
(cd sdk && npm ci && npm run build)
(cd hub && npm ci && npm run build)
(cd worker && npm ci && npm run build)
```

## telegram-token-format

**Symptom:** `Warning: doesn't match Telegram format.`

**Fix:** Telegram tokens look like `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz-0123456789`. Get a fresh one from `@BotFather` → `/newbot` or `/token`. Or skip Telegram entirely — press Enter at the prompt for CLI-only mode.

## telegram-user-id

**Symptom:** `ALLOWED_USER_ID must be a number.`

**Fix:** open Telegram → search `@userinfobot` → `/start` → copy the numeric `id`. It's ~10 digits, not a `@username`.

## pair-code-missing

**Symptom:** Worker setup fails at "Pairing code required."

**Fix:**
1. On the hub machine, type `pair` in the hub CLI (or send `/pair` in Telegram).
2. You'll see a code like `A1B2C3D4E5F6…`.
3. Paste it into `add-worker.sh` within 10 minutes (codes expire).

Need a new code? Just type `pair` again.

## verify-failed

**Symptom:** `./setup.sh --verify` reports hub didn't bind.

**Fix:** look at `/tmp/anyagent-verify.log` (hub) or `/tmp/anyagent-worker-verify.log` (worker). Common causes:
- **Port already in use:** another process on 8080 or 3000. `lsof -iTCP:8080`.
- **.env unreadable:** `chmod 600 hub/.env`.
- **Bad JSON in `WORKER_AGENTS`:** the worker will log `Failed to parse agents`.

## port-in-use

**Symptom:** `EADDRINUSE: address already in use :::8080`

**Fix:**
- Find the offender: `lsof -nP -iTCP:8080 -sTCP:LISTEN`
- Kill or change the port: set `WS_PORT=8090` in `hub/.env` and update every worker's `HUB_URL` to match.

## firewall-blocking

**Symptom:** Worker connects from localhost but not from another machine; times out with `ETIMEDOUT`.

**Fix:**
- **Linux (ufw):** `sudo ufw allow 8080/tcp` (workers) and `sudo ufw allow 3000/tcp` (MCP clients)
- **Linux (firewalld):** `sudo firewall-cmd --permanent --add-port=8080/tcp --add-port=3000/tcp && sudo firewall-cmd --reload`
- **macOS:** System Settings → Network → Firewall → Options → "Allow incoming connections" for `node`
- **Cloud VPS:** also open the ports in your cloud provider's security-group / VPC firewall

## worker-not-authenticated

**Symptom:** Worker log shows `Auth failed: Invalid signature` or `Unknown or revoked node`.

**Fix:**
- The hub doesn't know this worker. Clear the worker's credentials and re-pair:
  ```bash
  cd worker
  sed -i '' '/^NODE_ID=/d;/^PRIVATE_KEY_HEX=/d' .env   # BSD sed (macOS)
  # or: sed -i '/^NODE_ID=/d;/^PRIVATE_KEY_HEX=/d' .env  (GNU)
  # then generate a fresh pair code on the hub and add PAIR_CODE=... back to .env
  ```
- Or on the hub: `revoke <node_id>` and have the worker re-pair from scratch.

## binary-not-on-path

**Symptom:** Worker spawns reject with `Spawn rejected: binary "claude" not in allowlist` or `claude: command not found`.

**Fix:**
- Install the CLI on the **worker** machine (not the hub!) and make sure it's on the worker service's PATH.
- For systemd, either set `PATH=/usr/local/bin:...` in `worker/.env` or install the binary into `/usr/bin`.
- Run `cd worker && npm run doctor` to see exactly which binaries resolve.

## cli-not-authenticated

**Symptom:** Worker spawns the `claude` binary, but Claude itself says "please run `claude /login`".

**Fix:** AnyAgent doesn't handle model API keys — each CLI authenticates itself. SSH into the worker machine and run the CLI's login flow once:
```bash
claude /login          # Claude CLI
ollama serve           # Ollama daemon, if the binary is `ollama run …`
```

Credentials live in the CLI's own config dir and persist between spawns.

## hub-restarts-task-running

**Symptom:** Tasks show `status=failed, error="Hub restarted"` after a hub restart.

**Fix:** this is expected. Running tasks can't survive a hub restart because the PTY on the worker has already been killed. Queued tasks ARE preserved and re-dispatched on worker reconnect.

## mcp-401

**Symptom:** MCP client (Claude Code, Cursor) returns `Unauthorized`.

**Fix:**
- Verify the MCP token: `curl http://HUB:3000/health` should return 200 without auth. Then `curl -H "Authorization: Bearer $(grep MCP_TOKEN hub/.env | cut -d= -f2)" http://HUB:3000` should not 401.
- Make sure your `.mcp.json` header is `Authorization: Bearer <token>`, not just the token.

## worker-flapping

**Symptom:** `events.log` shows repeated `worker.online`/`worker.offline` pairs.

**Fix:** something on the worker side is restarting it in a loop. Check:
1. `journalctl -u anyagent-worker --no-pager -n 100` — look for crashes
2. Worker's heartbeat is failing — usually a NAT/firewall dropping idle WebSocket. Try `HEARTBEAT_INTERVAL_MS=15000` on the hub.
3. `WS_SECRET` mismatch — worker hits auth, gets 4401, gives up (no retry). Check both .env files.
