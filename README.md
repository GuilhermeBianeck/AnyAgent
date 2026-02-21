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
- Persists worker state in SQLite

### Worker (`/worker`)
A CLI agent that:
- Connects outbound to the Hub
- Authenticates via one-time pairing code or stored Ed25519 key pair
- Spawns PTY processes (e.g. `bash`, `claude`) on Hub command
- Streams terminal I/O bidirectionally over WebSocket

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
