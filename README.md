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

## Prerequisites

- **Node.js 22+** on the hub machine — the hub uses the built-in `node:sqlite` module, which is stable since Node 22.5. Install via `brew install node@22`, `nvm install 22`, or NodeSource.
- **Node.js 20+** on worker machines — the worker still uses `node-pty` for interactive CLI spawning; 20 LTS or newer works.
- **Build tools** — only needed if `node-pty`'s prebuilt binary isn't available for your Node version on your platform. On most Linux/macOS boxes the install skips the compile step entirely.
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt install python3 build-essential`
  - Alpine (Docker): `apk add python3 build-base`

## Quick Start

> **Got Claude Code or Codex on this machine?** Paste the prompt in
> [docs/SETUP-WITH-AI.md](docs/SETUP-WITH-AI.md) into your agent and it'll
> do the whole install — hub, worker, or MCP-client role, your choice.

### Option 0 — One-line install (no git, no npm, no Node)

```bash
curl -fsSL https://raw.githubusercontent.com/GuilhermeBianeck/AnyAgent/main/packaging/sea/install.sh | bash
anyagent quickstart
```

Installs a ~110MB single-file binary at `~/.local/bin/anyagent`. The binary bundles Node 22, the hub, the worker, **and** the native `pty.node` + `spawn-helper` — nothing else to install. `anyagent quickstart`:

1. Detects a local AI CLI (`claude`, `codex`, `aider`, `ollama`, `gemini`, or `bash`)
2. Writes `./anyagent-hub/.env` and `./anyagent-worker/.env` with generated secrets
3. Starts the hub + a local worker as child processes (auto-paired over loopback)
4. Injects the `anyagent` entry into `~/.claude.json` (backs up first)

When it's done, reopen Claude Code. Ctrl+C stops both processes.

Available subcommands:

```bash
anyagent hub             # run a hub only (uses ./.env or $ANYAGENT_HUB_DIR)
anyagent worker          # run a worker (reads ./.env — HUB_URL, PAIR_CODE, WORKER_AGENTS)
anyagent pair            # print a fresh pair code
anyagent wire-mcp ...    # inject the anyagent entry into an MCP config
anyagent doctor PATH     # validate a worker .env
anyagent --help
```

### Option A — git clone + quickstart (~60 seconds)

If you already have an AI CLI installed (`claude`, `codex`, `ollama`, `aider`, or `gemini`) and you prefer a source install:

```bash
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent
./quickstart.sh
```

That script:

1. Detects an AI CLI on your PATH
2. Builds hub + worker
3. Starts both in the background
4. Auto-pairs over loopback (no code dance)
5. Writes the MCP entry into your Claude Code / Cursor config

When it's done, reopen your MCP client. Your CLI is now callable as `anyagent_<name>`.

```bash
./quickstart.sh --stop                    # halt the background processes
./packaging/install-service.sh hub         # promote to systemd / launchd
./packaging/install-service.sh worker
```

### Option B — Multi-machine setup

For a hub on one machine and workers on others:

```bash
# Machine A (hub):
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent && ./setup.sh       # 2 questions, Telegram optional
cd hub && npm start

# Machine B (worker) — first run only:
# In the hub CLI, type: pair (or /pair in Telegram)
# Copy the code, then on machine B:
git clone https://github.com/GuilhermeBianeck/AnyAgent.git
cd AnyAgent && ./add-worker.sh   # auto-detects installed CLIs
```

Approve the pairing (`y` in the hub CLI, or tap Approve in Telegram).

Pass `--install-service` to either script to install a systemd/launchd unit at the end.

Then wire up your MCP client:

```bash
# From the hub checkout, inject into ~/.claude.json (backup saved automatically):
node hub/dist/tools/wire-mcp.js \
  --url http://HUB_IP:3000 \
  --token "$(grep MCP_TOKEN hub/.env | cut -d= -f2)"
```

Or add manually to Claude Code / Cursor's `.mcp.json`:

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

Try: *"Use anyagent_route to fix the bug in auth.ts"*

### Option C — Docker

```bash
cp .env.hub.example .env.hub       # edit with your tokens
cp .env.worker.example .env.worker
docker compose up -d
```

### Keeping it online

Neither `quickstart.sh` nor `npm start` survive a reboot. For production:

```bash
./packaging/install-service.sh hub      # systemd (Linux) / launchd (macOS)
./packaging/install-service.sh worker
```

Full operations guide: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

---

## MCP Tools

Every registered agent becomes an MCP tool. Plus these built-in tools:

| Tool | Input | Description |
|------|-------|-------------|
| `anyagent_route` | `intent`, `timeout_ms?` | Route to best agent by capability. Set `timeout_ms` (max 120s) to block for result. |
| `anyagent_<name>` | `intent`, `timeout_ms?` | Call a specific agent directly. One tool per registered agent. |
| `anyagent_list_agents` | — | List all agents with capabilities and online/offline status. |
| `anyagent_task_status` | `task_id` | Check task progress and result by ID. |
| `anyagent_task_cancel` | `task_id` | Cancel a queued, pending or running task. A running process is stopped on its worker. |
| `anyagent_context` | — | Read the operator's persistent context notes. |

**Blocking mode:** Set `timeout_ms` to wait for the result inline. Without it, tool calls return a `task_id` for polling via `anyagent_task_status`. If the client sends a `progressToken`, the worker's status and progress updates arrive as MCP progress notifications while it waits.

**Structured results:** Every tool declares an `outputSchema` and returns `structuredContent` alongside the text. Task results carry `taskId`, `status`, the same state in MCP Tasks vocabulary (`taskStatus`: `working` / `input_required` / `completed` / `failed` / `cancelled`), `pollIntervalMs` while unfinished, `ttlMs`, and the `agent` and `node` that ran it. Tools are annotated (`readOnlyHint`, `destructiveHint`, `openWorldHint`), so clients can skip confirmation for read-only calls and ask before running an agent.

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
| `tasks` | Last 10 tasks (compact view) |
| `history [task_id]` | Last 20 tasks, or full detail for one |
| `retry <id>` | Retry failed task |
| `cancel <id>` | Cancel queued task |
| `y` / `n` / `trust` | Approve / deny / trust pending task |
| `default [name\|off]` | Auto-start agent |
| `approve [off\|mcp\|always]` | Approval mode |
| `context [set\|add\|clear]` | Operator context |
| `revoke <node_id>` | Revoke worker |
| `review [approve <#\|name@alias>]` | Agents quarantined after their definition changed; approve one |
| `purge` | Clear task history |
| `events [watch]` | Recent worker/task events, or tail live |
| `net` | Recent outbound connections (requires `AUDIT_NETWORK=1`) |
| `audit [n]` | Recent MCP tool calls: token, tool, `agent@node`, outcome (full log in `hub/logs/audit.log`) |
| `token create <label> [--agents a,b@alias] [--readonly]` | Scoped MCP token (shown once). `token list`, `token revoke <label>` |
| `status` | Current status |

Any unrecognized text is forwarded as input to the active agent session.

### Telegram (optional — set `BOT_TOKEN`)

Same commands with `/` prefix: `/pair`, `/workers`, `/nodes`, `/agents`, `/call`, `/tasks`, `/history`, `/stop`, `/default`, `/approve`, `/context`, `/revoke`, `/review`, `/purge`, `/status`, `/switch`.

`/agents` and `/nodes` group by machine (each worker has an **alias** derived from its `WORKER_NAME` — `Spot.local` → `spot`). `/call <name>` lets the hub pick (oldest online pairing wins); `/call <name>@<alias>` targets a specific machine when multiple workers declare the same agent name.

Plus: inline buttons for pairing approval, task approval/deny/trust, retry, cancel, and agent selection. Live pinned status message auto-updates every 30 seconds and shows the agent count per machine.

---

## Configuration

### Hub

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | — | Telegram bot token. Omit to run CLI-only. |
| `ALLOWED_USER_ID` | — | Your Telegram user ID (numeric). Required only when `BOT_TOKEN` is set. |
| `WS_PORT` | `8080` | WebSocket port for workers |
| `WS_SECRET` | — | Shared secret for worker auth (recommended) |
| `MCP_PORT` | `3000` | MCP HTTP server port |
| `MCP_TOKEN` | — | Full-access ("admin") MCP bearer token. The MCP server starts if this is set or any scoped token exists. |
| `SESSION_TIMEOUT_MS` | `1800000` | Inactivity timeout (30 min) |
| `MAX_QUEUE_DEPTH` | `3` | Max queued tasks per worker |
| `AUTO_APPROVE_LOOPBACK` | — | Set `=1` to auto-approve pair requests from `127.0.0.1`/`::1`. Used by `quickstart.sh`; ignored for non-loopback connections. |
| `AGENT_REVIEW` | `changes` | Agent definition pinning. `changes`: an agent whose binary, args, description or capabilities change is hidden until you approve it with `review`. `all`: new agents need review too. `off`: accept changes automatically. |

### Scoped MCP tokens

`MCP_TOKEN` can call everything. To give an MCP client less, create a scoped token in the hub CLI:

```
anyagent> token create cursor-laptop --agents claude@laptop
anyagent> token create dashboard --readonly
anyagent> token create claude-anywhere --agents claude
```

- `claude@laptop` allows only that machine's agent (only the explicit `anyagent_claude_laptop` tool is listed).
- `claude` allows that agent on any machine, including the short-form `anyagent_claude`.
- `--readonly` lists agents and reads task status, but cannot run anything.

The client only sees tools it may call. `anyagent_route` picks only from in-scope agents. `anyagent_task_status` answers "not found" for tasks it may not see. Tokens are stored as SHA-256 hashes and shown once. Every call is recorded in `hub/logs/audit.log` under the token's label. Tokens are managed from the CLI only, so they never end up in Telegram chat history.

### Agent definition pinning

Agent descriptions become MCP tool descriptions that every connected client feeds to its model, so a compromised worker could use them for prompt injection ("tool poisoning"). The hub defends in two layers:

1. **Sanitization.** Invisible characters (zero-width, bidi, Unicode tag characters), HTML-like tags such as `<IMPORTANT>`, and oversized fields are stripped when a worker declares its agents. Invalid names or binaries are rejected, and the worker's log says why.
2. **Pinning.** Each agent's definition is hashed the first time the hub sees it. If a worker later declares something different, that agent is quarantined: it disappears from MCP, routing and `/agents`, and you get a notice in the CLI (and Telegram). `review` shows a before/after diff. If the change looks wrong, `revoke` the worker instead of approving.

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
| [Operations](docs/OPERATIONS.md) | systemd/launchd install, health endpoints, backup, upgrades |
| [Networking](docs/NETWORKING.md) | LAN / Tailscale / reverse-proxy / air-gapped patterns |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | 15 anchored fixes for common setup failures |
| [Privacy Model](docs/PRIVACY.md) | What Telegram sees, what stays local, retention policy |
| [Reliability Plan](docs/RELIABILITY-PLAN.md) | What improvements shipped and what's next |
| [Roadmap](docs/ROADMAP.md) | 6-phase plan from npm publish to community building |
| [Market Comparison](docs/MARKET-COMPARISON.md) | AnyAgent vs Manus, OpenClaw, AgentGateway, Claude Channels |
| [Product Requirements](docs/PRD-v2-agent-control-plane.md) | Goals, requirements, acceptance criteria |
| [User Personas](docs/USER-TESTING-personas.md) | 5 persona evaluations with actionable feedback |
| [Research](docs/RESEARCH-requirement-validation.md) | Market validation for the "Personal MCP Bridge" niche |

---

<p align="center">
  <strong>MIT License</strong>
</p>
