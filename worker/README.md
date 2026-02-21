# AnyAgent Worker

The Worker is a CLI agent that:
- Connects outbound to the Hub WebSocket server
- Authenticates via pairing or stored credentials
- Spawns PTY processes on demand from Hub commands

## Setup

1. Copy `.env.example` to `.env` and fill in values.
2. `npm install`
3. `npm run build`
4. `npm start`

## First-time Pairing

1. Run `/pair` on the Hub's Telegram bot to get a code.
2. Set `PAIR_CODE=<code>` in `.env` (and ensure `NODE_ID`/`PRIVATE_KEY_HEX` are NOT set).
3. Start the worker: `npm start`
4. Approve the request in Telegram.
5. Copy the printed `NODE_ID` and `PRIVATE_KEY_HEX` to `.env`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HUB_URL` | ✅ | WebSocket URL of the hub |
| `PAIR_CODE` | For new workers | One-time pairing code from `/pair` command |
| `NODE_ID` | For returning workers | Assigned node ID |
| `PRIVATE_KEY_HEX` | For returning workers | Hex-encoded private key |
