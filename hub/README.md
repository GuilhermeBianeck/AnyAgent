# AnyAgent Hub

The Hub is the central server that:
- Runs a Telegram bot for operator control
- Hosts a WebSocket server for worker connections
- Manages worker pairing, authentication, and session routing

## Setup

1. Copy `.env.example` to `.env` and fill in values.
2. `npm install`
3. `npm run build`
4. `npm start`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram Bot token |
| `ALLOWED_USER_ID` | ✅ | Telegram user ID allowed to use commands |
| `WS_PORT` | ❌ | WebSocket port (default: 8080) |
| `WS_SECRET` | ❌ | Optional shared secret for worker connections |
