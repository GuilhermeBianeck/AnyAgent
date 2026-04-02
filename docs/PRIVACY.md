# AnyAgent Privacy Model

## What stays on your infrastructure

All agent execution, task storage, and MCP tool traffic stays on your machines. The hub, workers, and SQLite database are entirely self-hosted. There are no analytics, telemetry, or external API calls (unless you configure an agent that makes them).

MCP traffic between clients (Claude Code, Cursor) and the hub travels over your local network or Tailscale/VPN. It never touches external servers.

## What flows through Telegram

The Telegram bot is the management interface. These items flow through Telegram's servers:

- **Task intents** — what you type as requests (e.g., "fix the auth bug in src/login.ts")
- **Task results** — summaries of what agents produced
- **Agent names and status** — which workers are online, which agents are available
- **Pairing codes** — one-time codes for worker registration
- **Error messages** — when tasks fail

Telegram bot messages are **not end-to-end encrypted**. Telegram has access to the content of messages between you and your bot. Secret Chats (which are E2E encrypted) are not available for bots.

## Recommendations

- **Do not type secrets directly to agents.** Instead of "set the API key to sk-abc123", use environment variables or config files on the worker machine.
- **Use `/purge` to clear task history.** This deletes all stored intents and results from the local SQLite database.
- **For sensitive workflows, use MCP instead of Telegram.** MCP traffic stays entirely local — no Telegram involvement.
- **Set strong tokens.** Both `WS_SECRET` (worker auth) and `MCP_TOKEN` (MCP client auth) should be long random strings.

## Data retention

- Task intents and results are stored in SQLite for **30 days** by default, then auto-deleted.
- Use `/purge` in Telegram to delete all history immediately.
- The retention period is not currently configurable (hardcoded in `cleanOldTasks(30)`).

## Worker security

- Workers authenticate using Ed25519 key pairs (challenge-response, no passwords transmitted).
- Private keys are stored in the worker's `.env` file with owner-only permissions (0600).
- Spawned agent processes do NOT receive the worker's private key or connection secrets — these are stripped from the child process environment.
- Workers only execute binaries that are explicitly declared in their `WORKER_AGENTS` configuration (allowlist).
