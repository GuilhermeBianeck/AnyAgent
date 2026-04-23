# Setup with an AI Agent

If you already have [Claude Code](https://docs.claude.com/docs/claude-code) or
the [Codex CLI](https://github.com/openai/codex) on the machine you want to
install AnyAgent on, you can hand the whole install to the agent. Open Claude
Code / Codex in any directory, paste the prompt below, and answer the few
questions it asks you.

The prompt works for all four setup scenarios:

| Role | What you get |
|---|---|
| **LOCAL** | Single-machine trial — hub + worker + MCP wiring, all on this box |
| **HUB** | Central coordinator (usually a VPS). Exposes MCP on :3000, accepts workers on :8080 |
| **WORKER** | Runs your local AI CLIs (claude, codex, ollama…) and makes them available to a remote hub |
| **CLIENT** | Just wire Claude Code / Cursor on this machine to an existing hub — no install |

If you're trying AnyAgent for the first time, start with **LOCAL**. Otherwise
pick the role this machine should play in your fleet.

---

## The prompt

Copy everything between the fences into Claude Code / Codex:

````
You are installing AnyAgent on this machine.

AnyAgent (https://github.com/GuilhermeBianeck/AnyAgent) is a self-hosted MCP
bridge. Workers (machines running AI CLIs like claude or codex) connect to a
hub over an outbound WebSocket — no inbound ports on workers, so they work
behind NAT / home routers / coffee-shop wifi. The hub exposes every declared
agent as an MCP tool that any MCP client (Claude Code, Cursor, etc.) can call.

Step 1 — Ask me which role this machine should play:

  L — LOCAL: single-machine trial (hub + worker + client, loopback only)
  H — HUB: central coordinator, usually a VPS with a public address
  W — WORKER: runs local AI CLIs; dials into an existing hub
  C — CLIENT: wire my Claude Code / Cursor to an existing hub (no install)

Then ask only the follow-up questions listed for that role, and run the
matching flow. After each command, show me the output or a short status
line so I know what happened. If anything fails, read docs/TROUBLESHOOTING.md
in the repo and propose a fix before retrying.

Prerequisites to check first (all roles except CLIENT):
  - Node 22+ on hub machines, Node 20+ on workers. If older, suggest
    `nvm install 22` before continuing.
  - git, curl, openssl available.

===================== L — LOCAL =====================
No follow-up questions. Just run:

  git clone https://github.com/GuilhermeBianeck/AnyAgent.git
  cd AnyAgent
  ./quickstart.sh

Verify:
  curl -sf http://127.0.0.1:3000/health | jq .workers.online
    → should print 1

Tell me:
  - Reopen Claude Code / Cursor now.
  - Try: "use anyagent_list_agents" — I should see one green agent.
  - To stop later: ./quickstart.sh --stop
  - To make it survive reboot:
      ./packaging/install-service.sh hub
      ./packaging/install-service.sh worker

===================== H — HUB =======================
Ask me:
  1. BOT_TOKEN? (Telegram bot from @BotFather, or Enter to skip for CLI-only)
  2. If BOT_TOKEN given — my numeric Telegram user ID (from @userinfobot).
  3. Public hostname / IP other machines will use to reach this hub.
     (e.g. "vps.example.com" or "203.0.113.10")

Then run:
  git clone https://github.com/GuilhermeBianeck/AnyAgent.git
  cd AnyAgent
  BOT_TOKEN="<value or empty>" ALLOWED_USER_ID="<value or 0>" \
    ./setup.sh --non-interactive

On Linux, open firewall (ignore errors if ufw not present):
  sudo ufw allow 8080/tcp 2>/dev/null || true
  sudo ufw allow 3000/tcp 2>/dev/null || true

Install as a service (may prompt for sudo on Linux):
  ./packaging/install-service.sh hub

Verify:
  curl -sf http://127.0.0.1:3000/health
    → must return {"ok":true,...}

Print these for me — I'll need them when I set up workers and clients:
  HUB_WS_URL   = ws://<hostname>:8080
  HUB_MCP_URL  = http://<hostname>:3000
  WS_SECRET    = $(grep ^WS_SECRET hub/.env | cut -d= -f2-)
  MCP_TOKEN    = $(grep ^MCP_TOKEN hub/.env | cut -d= -f2-)

Generate a pairing code and print it — it expires in 10 minutes:
  node hub/dist/tools/gen-pair.js

Warn me:
  - Also open 8080 and 3000 in the cloud provider's security group
    (ufw alone isn't enough on AWS/GCP/DigitalOcean/etc.).
  - Over the public internet, put an HTTPS reverse proxy in front
    of port 3000 (Caddy or nginx + Let's Encrypt). MCP_TOKEN flows
    on every request — don't ship it plaintext. See docs/NETWORKING.md.

===================== W — WORKER ====================
Ask me:
  1. Hub WebSocket URL? (e.g. ws://vps.example.com:8080)
  2. Pair code from the hub?
  3. WS_SECRET from the hub?
  4. Worker display name? (default: hostname)

Detect and report installed AI CLIs on PATH:
  for bin in claude codex ollama aider gemini bash; do
    command -v "$bin" >/dev/null 2>&1 && echo "✓ found: $bin"
  done

Then run:
  git clone https://github.com/GuilhermeBianeck/AnyAgent.git
  cd AnyAgent
  HUB_URL="<URL>" PAIR_CODE="<CODE>" WS_SECRET="<SECRET>" \
  WORKER_NAME="<NAME>" \
    ./add-worker.sh --non-interactive

Install as a service:
  ./packaging/install-service.sh worker

Verify by polling the hub's health from this machine (convert ws→http, :8080→:3000):
  HUB_HTTP=$(echo "<HUB_URL>" | sed -e 's|^ws|http|' -e 's|:8080|:3000|')
  curl -sf "$HUB_HTTP/health" | jq .workers.online
    → should increase by 1 vs before

CRITICAL reminder — AnyAgent never handles model credentials. I must log
each AI CLI in on THIS machine, once, before anything will work:
  claude /login          # Claude CLI
  codex login            # Codex CLI (or whatever its login command is)
  (skip for ollama, bash, aider — they don't need it)

Also run worker's self-check to confirm binaries resolve:
  cd worker && npm run doctor

===================== C — CLIENT ====================
Ask me:
  1. Hub MCP URL? (e.g. http://vps.example.com:3000, or https://... for TLS)
  2. MCP_TOKEN from the hub?

First, verify the hub accepts my token (should NOT return 401):
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer <TOKEN>" <URL>
    → 200, 400, or 405 are all fine. 401 means the token is wrong.

Then wire the MCP entry. Pick whichever works on my setup:

  (a) If the `claude` CLI is on PATH (canonical, recommended):
        claude mcp add --scope user --transport http anyagent "<URL>" \
          --header "Authorization: Bearer <TOKEN>"
        claude mcp list   # verify it prints "anyagent: ... ✓ Connected"

  (b) If AnyAgent is already cloned here:
        cd <path to AnyAgent>
        node hub/dist/tools/wire-mcp.js --url "<URL>" --token "<TOKEN>"

  (c) Manual edit of ~/.claude.json (back up first: cp ~/.claude.json ~/.claude.json.bak).
      Add this under "mcpServers" — the `"type": "http"` field is REQUIRED, without
      it Claude Code silently treats the entry as stdio and ignores it:
        "anyagent": {
          "type": "http",
          "url": "<URL>",
          "headers": { "Authorization": "Bearer <TOKEN>" }
        }
      For Cursor, edit ~/.cursor/mcp.json with the same shape.

Tell me:
  - FULLY quit Claude Code / Cursor (⌘Q, not just close the window).
    MCP server lists are read at session start and NOT hot-reloaded.
  - Reopen, start a fresh conversation, try: "use anyagent_list_agents"

===================== ON FAILURE =====================
If any step fails, grep docs/TROUBLESHOOTING.md for a matching anchor and
suggest the fix. The most common ones:

  nodejs-too-old          hub needs Node 22+; worker needs Node 20+
  port-in-use             :8080 or :3000 already bound (lsof -iTCP:PORT)
  firewall-blocking       cloud provider's security group, not just ufw
  pair-code-missing       codes expire in 10 min; generate a new one
  worker-not-authenticated  WS_SECRET doesn't match hub↔worker
  binary-not-on-path      worker service's PATH doesn't include the CLI
  cli-not-authenticated   I forgot `claude /login` on the worker
  posix-spawnp-failed     node-pty spawn-helper lost +x; or launchd PATH misses the CLI
  mcp-tool-not-found      anyagent_* missing after reopen — `type: "http"` required
  mcp-401                 wrong Authorization header shape or MCP_TOKEN

Do NOT use destructive shortcuts (rm -rf, git reset --hard, skipping hooks)
to work around an error. Diagnose first, ask me if you're unsure.
````

---

## If your agent doesn't have shell access

If you're using Claude or ChatGPT through a web UI without shell access, the
prompt still works — the agent will print the exact commands for you to run
manually instead of executing them. Tell it: *"You don't have shell access.
Print each command clearly so I can copy-paste into my terminal, and wait for
me to paste the output back."*

## After setup

Full operations guide: [OPERATIONS.md](OPERATIONS.md).
Networking / TLS / reverse-proxy patterns: [NETWORKING.md](NETWORKING.md).
When something breaks: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
