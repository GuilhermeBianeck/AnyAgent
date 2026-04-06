<h1 align="center">AnyAgent</h1>

<p align="center">
  <strong>The simplest way to make your agents work together as MCP tools.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#mcp-tools">MCP Tools</a> &middot;
  <a href="#management">Management</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#security">Security</a> &middot;
  <a href="docs/ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP" />
  <img src="https://img.shields.io/badge/self--hosted-privacy--first-orange" alt="Self-hosted" />
</p>

---

Run agents on your machines — Claude Code, local LLMs, shell scripts, anything. AnyAgent connects them all to a single hub and exposes each one as an MCP tool that Claude Code, Cursor, or any MCP client can call. Manage the fleet from your terminal or Telegram.

```
 Claude Code ─── MCP ───→  AnyAgent Hub  ←── WebSocket ──── Workers
 Cursor                        │ ↕ │                      (any machine)
 Any MCP client           CLI   Telegram
                       (manage from anywhere)
```

### Why AnyAgent?

- **One hub, all your agents.** Claude Code on your laptop calls your GPU server's Ollama. Your VPS shell agent runs deployments. All through MCP — no SSH, no manual switching.
- **Zero lock-in.** Works with any binary: Claude CLI, Ollama, bash, Python scripts, local LLMs. Not tied to one AI provider.
- **Self-hosted, private.** All data on your machines. No cloud. No telemetry. Air-gappable.
- **Telegram optional.** Full management from your terminal. Add Telegram for mobile push notifications.
- **5-minute setup.** Interactive wizard. One command per machine.

---

## Quick Start

### 1. Set up the hub

```bash
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./setup.sh    # asks 2 questions, generates all secrets
cd hub && npm start
```

> Hub starts with a CLI prompt. Telegram is optional — set `BOT_TOKEN` to enable.

### 2. Add a worker

On each machine you want to connect:

```bash
# In the hub CLI, type: pair (or send /pair in Telegram)
# Copy the pairing code, then on the worker machine:

git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./add-worker.sh
cd worker && npm start
```

Approve the pairing (`y` in CLI, or tap Approve in Telegram). Done — credentials auto-save for future restarts.

### 3. Connect MCP clients

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

Your agents appear as MCP tools automatically. Try: *"Use anyagent_route to fix the bug in auth.ts"*

### Docker alternative

```bash
cp .env.hub.example .env.hub       # edit with your tokens
cp .env.worker.example .env.worker
docker compose up -d
```

---

## MCP Tools

Every registered agent becomes an MCP tool. Plus these built-in tools:

| Tool | Input | Description |
|------|-------|-------------|
| `anyagent_route` | `intent`, `timeout_ms?` | Route to best agent by capability. Set `timeout_ms` (max 120s) to block for result. |
| `anyagent_<name>` | `intent`, `timeout_ms?` | Call a specific agent directly. One tool per registered agent. |
| `anyagent_list_agents` | — | List all agents with capabilities and online/offline status. |
| `anyagent_task_status` | `task_id` | Check task progress and result by ID. |
| `anyagent_context` | — | Read the operator's persistent context notes. |

**Blocking mode:** Set `timeout_ms` to wait for the result inline. Without it, tool calls return a `task_id` for polling via `anyagent_task_status`.

---

## Management

AnyAgent has two management interfaces with full feature parity. Use either or both.

### CLI (always available)

```
anyagent> agents
  ● claude — Claude Code [coding, refactoring]
  ● shell — Bash executor [shell, scripts]
  ○ ollama — Local LLM (offline)

anyagent> route fix the authentication bug
✓ claude started. Type to interact, "stop" to end.
```

| Command | Description |
|---------|-------------|
| `pair` | Generate pairing code |
| `workers` | List workers |
| `agents` | List agents |
| `call <name>` | Start agent |
| `route <intent>` | Route by capability |
| `switch` | Switch agent |
| `stop` | Stop session |
| `tasks` | Task history |
| `retry <id>` | Retry failed task |
| `cancel <id>` | Cancel queued task |
| `y` / `n` / `trust` | Approve / deny / trust pending task |
| `default [name\|off]` | Auto-start agent |
| `approve [off\|mcp\|always]` | Approval mode |
| `context [set\|add\|clear]` | Operator context |
| `revoke <node_id>` | Revoke worker |
| `purge` | Clear history |
| `status` | Current status |

Any unrecognized text is forwarded as input to the active agent session.

### Telegram (optional — set `BOT_TOKEN`)

Same commands with `/` prefix: `/pair`, `/workers`, `/agents`, `/call`, `/tasks`, `/stop`, `/default`, `/approve`, `/context`, `/revoke`, `/purge`, `/status`, `/switch`.

Plus: inline buttons for pairing approval, task approval/deny/trust, retry, cancel, and agent selection. Live pinned status message auto-updates every 30 seconds.

---

## Configuration

### Hub

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_USER_ID` | *required* | Your Telegram user ID (numeric) |
| `BOT_TOKEN` | — | Telegram bot token. Omit to run CLI-only. |
| `WS_PORT` | `8080` | WebSocket port for workers |
| `WS_SECRET` | — | Shared secret for worker auth (recommended) |
| `MCP_PORT` | `3000` | MCP HTTP server port |
| `MCP_TOKEN` | — | MCP bearer token. Omit to disable MCP server. |
| `SESSION_TIMEOUT_MS` | `1800000` | Inactivity timeout (30 min) |
| `MAX_QUEUE_DEPTH` | `3` | Max queued tasks per worker |

### Worker

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_URL` | `ws://localhost:8080` | Hub WebSocket URL |
| `PAIR_CODE` | — | One-time pairing code (first run only) |
| `WS_SECRET` | — | Must match hub if set |
| `WORKER_NAME` | hostname | Display name |
| `WORKER_AGENTS` | *required* | JSON array of agent declarations |

Worker also accepts CLI flags: `--hub`, `--pair`, `--secret`, `--name`, `--agents`, `--help`.

### Agent declaration

```json
[{
  "name": "claude",
  "binary": "claude",
  "args": [],
  "description": "Claude Code AI assistant",
  "capabilities": ["coding", "refactoring", "testing"]
}]
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

| Module | Role |
|--------|------|
| **manager.ts** | Pure business logic: routing, tasks, queue, approval, context. No UI. |
| **cli.ts** | Terminal interface. Always active. |
| **bot.ts** | Telegram interface. Optional. |
| **mcp.ts** | MCP server. Exposes agents as tools. |
| **gateway.ts** | WebSocket server. Worker auth, heartbeat, I/O relay. |
| **sdk/** | Worker SDK: connection, auth, structured output helpers. |

---

## Security

- Ed25519 challenge-response authentication
- Timing-safe token comparison (MCP + WebSocket)
- Binary allowlist — only declared agents can spawn
- Environment sanitization — child processes don't see private keys
- `.env` files written with 0600 permissions
- Agent namespacing per worker — no cross-worker hijacking
- Output ownership verification — workers can't spoof other workers' results
- Task approval gate — optional human confirmation before execution
- Session takeover prevention — new auth terminates prior connection
- 1MB max payload (WebSocket + MCP HTTP)
- Non-root Docker containers
- Node revocation via `revoke` command
- 30-day auto-cleanup of task history

See [PRIVACY.md](docs/PRIVACY.md) for the full trust model.

---

## Contributing

Found a bug? Have a feature idea? [Open an issue](https://github.com/GuilhermeBianeck/AnyAgent/issues).

Want to contribute code? See the [architecture section](#architecture) for module boundaries. The codebase is TypeScript (hub + SDK) with a clean separation: `manager.ts` owns business logic, frontends (`bot.ts`, `cli.ts`, `mcp.ts`) own rendering.

```bash
cd hub && npm run dev    # hot-reload development
cd worker && npm run dev
```

---

## Documentation

| | |
|---|---|
| [Privacy Model](docs/PRIVACY.md) | What Telegram sees, what stays local, retention policy |
| [Roadmap](docs/ROADMAP.md) | 6-phase plan from npm publish to community building |
| [Market Comparison](docs/MARKET-COMPARISON.md) | AnyAgent vs Manus, OpenClaw, AgentGateway, Claude Channels |
| [Product Requirements](docs/PRD-v2-agent-control-plane.md) | Goals, requirements, acceptance criteria |
| [User Personas](docs/USER-TESTING-personas.md) | 5 persona evaluations with actionable feedback |
| [Research](docs/RESEARCH-requirement-validation.md) | Market validation for the "Personal MCP Bridge" niche |

---

<p align="center">
  <strong>MIT License</strong>
</p>
