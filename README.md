# AnyAgent

Personal MCP bridge for distributed agents. Make any agent on any machine available as an MCP tool — managed from Telegram.

```
Your Laptop (Claude Code) ──MCP──→ AnyAgent Hub ──WebSocket──→ Workers (any machine)
                                       ↕
                                   Telegram (management)
```

## Quick Start (5 minutes)

### 1. Set up the hub

```bash
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./setup.sh
```

The wizard walks you through:
- Entering your Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Entering your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- Auto-generating secure tokens for WS_SECRET and MCP_TOKEN

Then start:

```bash
cd hub && npm start
```

### 2. Add a worker

On each machine you want to connect:

```bash
# Get a pairing code first — send /pair to your bot in Telegram

git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./add-worker.sh
```

The wizard asks for the hub URL, pairing code, worker name, and which binary to expose. Then:

```bash
cd worker && npm start
```

Approve the pairing in Telegram — done. The worker auto-saves its credentials for future restarts.

### 3. Use it

**From Telegram:** Just type what you need. The hub routes to the right agent.

**From Claude Code / Cursor:** Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "anyagent": {
      "url": "http://YOUR_HUB_IP:3000",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Your agents appear as MCP tools: `anyagent_claude`, `anyagent_shell`, etc.

### Docker alternative

```bash
cp .env.hub.example .env.hub   # edit with your tokens
cp .env.worker.example .env.worker
docker compose up -d
```

## What it does

- **MCP bridge**: Agents on any machine become MCP tools callable by Claude Code, Cursor, or any MCP client
- **Telegram management**: Pair workers, monitor status, run tasks, get alerts — all from your phone
- **Task tracking**: Every request (Telegram or MCP) is a tracked task with status, results, and retry
- **Capability routing**: Hub matches your intent to the right agent by capability keywords
- **Queue + retry**: Busy agents queue tasks (max 3). Failed tasks get a one-tap retry button
- **Privacy-first**: All data on your machines. No cloud. No telemetry. See [PRIVACY.md](docs/PRIVACY.md)

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Show help, pin live status message |
| `/pair` | Generate pairing code for a new worker |
| `/workers` | List workers with online/offline status |
| `/agents` | List agents with capabilities (tap to start) |
| `/call <name>` | Start a specific agent |
| `/tasks` | Show recent task history with status |
| `/stop` | Stop the active session |
| `/default <name>` | Set auto-start agent (just type to interact) |
| `/status` | Update and pin the live status message |
| `/purge` | Delete all task history |

## MCP tools

When connected, MCP clients see these tools:

| Tool | Description |
|------|-------------|
| `anyagent_route` | Route intent to best agent (supports `timeout_ms` for blocking) |
| `anyagent_<name>` | Call a specific agent by name |
| `anyagent_list_agents` | List all agents with capabilities and status |
| `anyagent_task_status` | Check task progress/result by ID |

## Architecture

```
┌─────────────────────────────────────────┐
│              AnyAgent Hub               │
│  Telegram Bot + WebSocket + MCP Server  │
│               + SQLite                  │
└─────┬────────────┬──────────────┬───────┘
      │            │              │
   Telegram    WebSocket       MCP HTTP
   (manage)    (workers)    (Claude Code)
      │            │              │
   Phone      Worker 1        Laptop
              Worker 2
              Worker N
```

- **Hub**: Central server running Telegram bot, WebSocket gateway, MCP server, SQLite
- **Workers**: Connect outbound to hub, spawn agent processes, stream I/O
- **SDK** (`sdk/`): Shared library workers use for connection, auth, and structured output

## Security

- Ed25519 challenge-response authentication (no passwords)
- Spawned agents don't receive private keys (env sanitized)
- Binary allowlist on workers (only declared agents can run)
- Timing-safe token comparison for MCP and WS auth
- `.env` files written with 0600 permissions
- All Telegram commands restricted to your user ID
- See [PRIVACY.md](docs/PRIVACY.md) for the full privacy model

## Docs

- [PRD](docs/PRD-v2-agent-control-plane.md) — Product requirements and design decisions
- [Privacy](docs/PRIVACY.md) — What data goes where, retention, and recommendations
- [Research](docs/RESEARCH-requirement-validation.md) — Market validation and requirement analysis
