# AnyAgent

Make any agent on any machine available as an MCP tool. Self-hosted, privacy-first, managed from your terminal or Telegram.

```
 Claude Code / Cursor ──MCP──→  AnyAgent Hub  ──WebSocket──→  Workers (any machine)
                                     ↕
                            CLI / Telegram (management)
```

---

## Quick Start

### Option A: Setup wizard (recommended)

```bash
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./setup.sh       # asks 2 questions, generates all secrets
cd hub && npm start
```

The hub starts with a CLI prompt. Telegram is optional — set `BOT_TOKEN` to enable it.

### Option B: Docker

```bash
cp .env.hub.example .env.hub       # edit with your tokens
cp .env.worker.example .env.worker
docker compose up -d
```

### Option C: Manual

```bash
cd hub && cp .env.example .env     # edit all values
npm install && npm run build && npm start
```

---

## Add a Worker

On each machine you want to connect:

**1.** Get a pairing code — type `pair` in the hub CLI, or send `/pair` in Telegram.

**2.** On the worker machine:

```bash
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./add-worker.sh    # wizard asks for hub URL, code, agent binary, capabilities
cd worker && npm start
```

Or with CLI flags (no wizard):

```bash
cd worker && node dist/index.js \
  --hub ws://HUB_IP:8080 \
  --pair PAIRING_CODE \
  --name my-server \
  --agents '[{"name":"claude","binary":"claude","args":[],"capabilities":["coding"]}]'
```

**3.** Approve the pairing in CLI (`y`) or Telegram (tap Approve). Credentials auto-save for future restarts.

---

## Connect MCP Clients

Add to your Claude Code / Cursor `.mcp.json`:

```json
{
  "mcpServers": {
    "anyagent": {
      "url": "http://HUB_IP:3000",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Your agents appear as MCP tools automatically.

---

## MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `anyagent_route` | `intent`, `timeout_ms?` | Route to best agent by capability. Set `timeout_ms` (max 120s) to block for result. |
| `anyagent_<name>` | `intent`, `timeout_ms?` | Call a specific agent directly. One tool per registered agent. |
| `anyagent_list_agents` | — | List all agents with capabilities and online/offline status. |
| `anyagent_task_status` | `task_id` | Check task progress and result. |
| `anyagent_context` | — | Read the operator's persistent context notes. |

---

## Management Interfaces

AnyAgent has two management interfaces. Both have full feature parity. Use either or both simultaneously.

### CLI Commands (always available)

| Command | Description |
|---------|-------------|
| `pair` | Generate a pairing code for a new worker |
| `workers` | List workers with online/offline status |
| `agents` | List agents with capabilities |
| `call <name>` | Start a specific agent session |
| `route <intent>` | Route by capability matching (interactive picker if ambiguous) |
| `switch` | Switch to a different online agent |
| `stop` | Stop the active session |
| `tasks` | Show recent task history |
| `retry <task_id>` | Retry a failed task |
| `cancel <task_id>` | Cancel a queued task |
| `y` / `n` / `trust` | Approve / deny / trust a pending task |
| `default [name\|off]` | Set or clear the auto-start agent |
| `approve [off\|mcp\|always]` | Set task approval mode |
| `context [set\|add\|clear]` | Manage persistent operator context |
| `revoke <node_id>` | Revoke a paired worker |
| `purge` | Delete all task history |
| `status` | Show current status |
| *(any text)* | If session active: send as input. If default agent set: auto-route. |

### Telegram Commands (optional — set `BOT_TOKEN` to enable)

| Command | Description |
|---------|-------------|
| `/start` | Show help, create pinned live status message |
| `/pair` | Generate pairing code with ready-to-paste worker commands |
| `/workers` | List workers (tap for detail, aliases: `/devices`, `/list`) |
| `/agents` | List agents (tap to start) |
| `/call <name>` | Start a specific agent |
| `/switch` | Switch to a different agent |
| `/stop` | Stop the active session |
| `/tasks` | Show recent task history with status emoji |
| `/default [name]` | Set auto-start agent (alias: `/delegate`) |
| `/approve [off\|mcp\|always]` | Set task approval mode |
| `/context [set\|add\|clear]` | Manage operator context |
| `/revoke <node_id>` | Revoke a worker |
| `/purge` | Delete all task history (with confirmation) |
| `/status` | Update and pin live status message (auto-refreshes every 30s) |

Telegram also provides inline buttons for: pairing approval, task approval/deny/trust, retry on failure, cancel queued tasks, and agent selection.

---

## Features

| Feature | Description |
|---------|-------------|
| **MCP bridge** | Agents on any machine become MCP tools callable by Claude Code, Cursor, or any MCP client |
| **Telegram optional** | Full management from terminal CLI. Telegram adds mobile push + inline buttons when enabled |
| **Task tracking** | Every request (CLI, Telegram, or MCP) is a persistent task with lifecycle tracking |
| **Capability routing** | Hub matches your intent to the right agent by keyword scoring on capabilities |
| **Task queue** | Busy agents queue tasks (FIFO, max 3). Tasks auto-start when the current one finishes |
| **Retry** | Failed tasks show retry option. Error context injected on retry. Max 3 retries |
| **Task approval** | Optional gate: require Telegram/CLI confirmation before agents run (per-agent trust) |
| **Persistent context** | Operator notes + recent task history injected into agent spawns |
| **Structured output** | Agents can send status, progress, result, error messages (rendered in CLI and Telegram) |
| **Legacy TTY** | Raw terminal I/O for interactive agents (Claude CLI, bash, etc.) |
| **Privacy-first** | All data on your machines. No cloud. No telemetry. Fully air-gappable |

---

## Configuration Reference

### Hub environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ALLOWED_USER_ID` | Yes | — | Your Telegram user ID (numeric) |
| `BOT_TOKEN` | No | — | Telegram bot token. If unset, Telegram disabled. |
| `WS_PORT` | No | `8080` | WebSocket port for workers |
| `WS_SECRET` | No | — | Shared secret for worker transport auth |
| `MCP_PORT` | No | `3000` | HTTP port for MCP server |
| `MCP_TOKEN` | No | — | Bearer token for MCP auth. If unset, MCP disabled. |
| `SESSION_TIMEOUT_MS` | No | `1800000` | Session inactivity timeout (ms) |
| `MAX_QUEUE_DEPTH` | No | `3` | Max queued tasks per worker |

### Worker environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `HUB_URL` | No | `ws://localhost:8080` | Hub WebSocket URL |
| `PAIR_CODE` | First time | — | From `/pair` or `pair` command |
| `WS_SECRET` | If hub has it | — | Must match hub's WS_SECRET |
| `WORKER_NAME` | No | hostname | Worker display name |
| `WORKER_DESCRIPTION` | No | — | Worker description |
| `WORKER_AGENTS` | Yes | — | JSON array of agent declarations |
| `NODE_ID` | Auto-saved | — | Assigned after pairing |
| `PRIVATE_KEY_HEX` | Auto-saved | — | Ed25519 private key (auto-generated) |

### Worker CLI flags (override env vars)

```
--hub <url>       Hub WebSocket URL
--pair <code>     Pairing code
--secret <token>  WS_SECRET
--name <name>     Worker display name
--desc <text>     Worker description
--agents <json>   Agent declarations as JSON
--help            Show usage
```

### Agent declaration format

```json
[
  {
    "name": "claude",
    "binary": "claude",
    "args": [],
    "description": "Claude Code AI assistant",
    "capabilities": ["coding", "refactoring", "testing"]
  }
]
```

---

## Architecture

```
                    manager.ts (business logic)
                   /          |           \
              bot.ts       cli.ts       mcp.ts
            (Telegram)   (terminal)   (MCP tools)
                   \          |           /
                    gateway.ts (WebSocket + workers)
                         |
                       db.ts (SQLite)
```

| Component | What it does |
|-----------|-------------|
| **manager.ts** | Pure business logic: routing, task lifecycle, queue, approval, context. No UI deps. |
| **bot.ts** | Telegram frontend (optional). Calls manager, renders results as Telegram messages. |
| **cli.ts** | Terminal frontend (always active). Same manager calls, rendered as ANSI text. |
| **mcp.ts** | MCP server. Exposes agents as tools. Calls manager for routing and spawning. |
| **gateway.ts** | WebSocket server. Worker auth, heartbeat, binary frame relay, event callbacks. |
| **db.ts** | SQLite: tasks, agents, nodes, sessions, approval config, default agents. |
| **context.ts** | Persistent operator notes stored as Markdown file. |
| **sdk/** | Worker SDK: connection, auth, structured output helpers. |

## Security

- Ed25519 challenge-response authentication (no passwords transmitted)
- Timing-safe comparison for MCP bearer token and WS_SECRET
- Binary allowlist on workers — only declared agents can be spawned
- Environment sanitization — child processes don't receive private keys
- `.env` files written with owner-only permissions (0600)
- Agent names namespaced per worker — one worker can't hijack another's agents
- Output ownership verification — workers can't spoof other workers' task results
- Task approval gate — optional human confirmation before agents run
- Session takeover prevention — new auth terminates prior connection for same node
- 1MB max payload on WebSocket and MCP HTTP
- Docker containers run as non-root user
- 30-day auto-cleanup of old tasks
- Node revocation via `/revoke` command

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full privacy model.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Privacy Model](docs/PRIVACY.md) | What data flows through Telegram vs stays local, retention, recommendations |
| [Product Requirements](docs/PRD-v2-agent-control-plane.md) | Full PRD with goals, requirements, acceptance criteria |
| [Market Comparison](docs/MARKET-COMPARISON.md) | AnyAgent vs Manus, OpenClaw, AgentGateway, Claude Channels, n8n |
| [User Personas](docs/USER-TESTING-personas.md) | 5 persona evaluations with feedback and gap analysis |
| [Research Validation](docs/RESEARCH-requirement-validation.md) | Market research validating the "Personal MCP Bridge" niche |
| [Roadmap](docs/ROADMAP.md) | 6-phase plan: npm publish → CLI mode → Python SDK → recipes → community |

---

## License

MIT
