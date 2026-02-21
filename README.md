# AnyAgent

AnyAgent is a Hub-and-Spoke remote agent system controlled via Telegram.

## Architecture

```
Telegram Bot  ←→  Hub (Node.js)  ←→  Worker(s) (Node.js)
                       ↕
                   SQLite DB
```

### Hub (`/hub`)
The central server that:
- Runs a Telegram bot for operator control
- Hosts a WebSocket server workers connect to
- Manages worker pairing, authentication, and session routing
- Persists worker and agent state in SQLite
- Streams TTY output from agents to Telegram and routes Telegram text as input

### Worker (`/worker`)
A CLI agent that:
- Connects outbound to the Hub
- Authenticates via one-time pairing code or stored Ed25519 key pair
- Spawns PTY processes (e.g. `bash`, `claude`) on Hub command
- Streams terminal I/O bidirectionally over WebSocket
- Auto-reconnects on disconnect (always available)

## Quick Start

### Hub

```bash
cd hub
cp .env.example .env
# Edit .env with your BOT_TOKEN and ALLOWED_USER_ID
npm install
npm run build
npm start
```

### Worker

```bash
cd worker
cp .env.example .env
# Set HUB_URL and PAIR_CODE (get code from /pair Telegram command)
npm install
npm run build
npm start
```

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Show available commands |
| `/pair` | Generate a one-time pairing code for a new worker |
| `/list` | List all registered workers with online/offline status |
| `/agents` | List all registered agents with their node status |
| `/register <name> <node_id> <binary> [args...]` | Register a named agent on a worker node |
| `/unregister <name>` | Remove a registered agent |
| `/call <agent_name>` | Start an interactive session with a registered agent |
| `/call <node_id> <binary> [args...]` | Directly spawn a process on a specific worker |
| `/stop` | End the active agent session |

### Agent Registration Workflow

1. **Pair a worker**: Use `/pair` to get a code, configure the worker, and approve via Telegram
2. **Register an agent**: `/register claude node_abc123 claude` maps the name "claude" to the `claude` binary on that node
3. **Call the agent**: `/call claude` spawns the process and connects I/O to Telegram
4. **Interact**: Send plain text messages to the Telegram chat — they are forwarded as terminal input
5. **Stop**: Use `/stop` to end the session

### Example: Register Claude CLI

```
/list                              → see your node IDs
/register claude node_abc123 claude  → register Claude CLI on that node
/call claude                        → start interactive session
Hello, can you help me?             → sent to claude as stdin
/stop                               → end session
```

## Protocol

Control messages use JSON-RPC 2.0 over text WebSocket frames. TTY data uses raw binary WebSocket frames.

| Message | Direction | Description |
|---|---|---|
| `pair` | Worker→Hub | Initial pairing with code and public key |
| `pair_result` | Hub→Worker | Pairing approval result with node ID |
| `auth` | Worker→Hub | Authentication request |
| `auth_challenge` | Hub→Worker | Challenge for Ed25519 signing |
| `auth_response` | Worker→Hub | Signed challenge response |
| `auth_result` | Hub→Worker | Authentication result |
| `spawn` | Hub→Worker | Spawn a PTY process |
| `spawn_result` | Worker→Hub | Spawn confirmation with PID |
| `resize` | Hub→Worker | Terminal resize event |
| `exit` | Worker→Hub | PTY process exited |

## Security

- All Telegram commands restricted to `ALLOWED_USER_ID`
- Workers authenticate with Ed25519 key pairs (Node.js built-in `crypto`)
- Optional `WS_SECRET` header for WebSocket connections
- One-time pairing codes with 10-minute expiry
- Human approval via Telegram inline keyboard required for new workers
