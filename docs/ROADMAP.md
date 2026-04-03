# AnyAgent Roadmap — Owning the Personal MCP Bridge Niche

## Strategic Context

**Window:** ~6 months before OpenClaw adds "bring your own binary" or Anthropic ships multi-instance Claude Code coordination.

**Goal:** Become THE default tool developers reach for when they want to make agents on their machines available as MCP tools. Distribution beats features.

**TAM:** ~5,000-16,000 developers (self-hosters who run agents on 2+ machines and want MCP federation).

**Competitor to beat:** MCPJungle (941 GitHub stars, Go-based MCP gateway/registry). They aggregate existing MCP servers. We wrap arbitrary processes into MCP tools. Different but adjacent.

---

## Phase 0: Ship & Distribute (Weeks 1-2)

**Goal:** Get v2 out of the repo and into people's hands.

### 0.1 — Publish to npm
- [ ] Publish `@anyagent/hub` to npm with `bin` entry → `npx @anyagent/hub`
- [ ] Publish `@anyagent/worker` to npm → `npx @anyagent/worker --hub ws://... --pair ABC`
- [ ] Publish `@anyagent/sdk` to npm for third-party worker authors
- [ ] One-command install: `npm install -g @anyagent/hub @anyagent/worker`

### 0.2 — Docker Hub images
- [ ] Push `anyagent/hub` and `anyagent/worker` to Docker Hub
- [ ] `docker run anyagent/hub` just works with -e flags
- [ ] Tag with version numbers, `latest`, and `v2`

### 0.3 — Get listed everywhere
- [ ] Submit to PulseMCP server directory (11,000+ servers listed)
- [ ] Submit to mcp.directory
- [ ] Submit to MCP Market
- [ ] Submit to MintMCP
- [ ] Submit to Awesome MCP Servers GitHub list
- [ ] Post on HN ("Show HN: AnyAgent — make any process on any machine an MCP tool")
- [ ] Post on r/selfhosted, r/LocalLLaMA, r/ClaudeAI

### 0.4 — Write the canonical tutorial
- [ ] "5-Minute Multi-Machine MCP Setup" blog post
- [ ] Video walkthrough: laptop Claude Code calling GPU server agent
- [ ] Include `.mcp.json` snippets for Claude Code, Cursor, Windsurf

---

## Phase 1: Remove Telegram as Gate (Weeks 3-4)

**Goal:** 4-5x the addressable market by making Telegram optional.

### 1.1 — CLI management mode
- [ ] `anyagent-hub --mode cli` starts without Telegram
- [ ] CLI shows: worker status, agent list, task history, live logs
- [ ] Pairing via CLI: hub prints code, worker connects, hub auto-approves (or prompts in terminal)
- [ ] All functionality available without BOT_TOKEN

### 1.2 — Make Telegram a plugin, not core
- [ ] Refactor bot.ts into a separate module imported only when BOT_TOKEN is set
- [ ] Hub works with: CLI only, Telegram only, or both
- [ ] Document "Telegram setup (optional)" as a separate guide

### 1.3 — Web status page (minimal)
- [ ] Hub serves a simple read-only HTML page on MCP_PORT/status
- [ ] Shows: workers, agents, recent tasks, MCP connection info
- [ ] No auth required (same bearer token as MCP, or public read-only)
- [ ] Not a full dashboard — just enough to see what's happening

---

## Phase 2: Python Workers (Weeks 5-6)

**Goal:** Unlock the ML/research community (the largest underserved segment).

### 2.1 — Python Worker SDK
- [ ] `pip install anyagent-worker`
- [ ] Same protocol as TypeScript SDK (JSON-RPC + binary frames over WebSocket)
- [ ] `anyagent.create_worker(hub_url, config)` with same API surface
- [ ] Structured output helpers: `worker.send_status()`, `worker.send_result()`, etc.
- [ ] Auto-pairing and credential storage to `.env`

### 2.2 — Python agent examples
- [ ] Ollama wrapper (expose local LLM as MCP tool)
- [ ] Generic HTTP API wrapper (any REST API → MCP tool)
- [ ] Shell command agent (simple bash executor)

---

## Phase 3: Agent Recipes (Weeks 7-8)

**Goal:** Create switching costs through community content.

### 3.1 — Recipe format
- [ ] Define `anyagent-recipe.json` spec: name, description, binary, args, capabilities, setup instructions
- [ ] `anyagent-worker --recipe ollama` auto-configures from recipe
- [ ] Recipes for: Claude Code, Ollama, bash, Python, ComfyUI, Stable Diffusion, code-server

### 3.2 — Recipe registry
- [ ] GitHub repo `anyagent/recipes` with community PRs
- [ ] `anyagent-worker --recipe <name>` fetches from registry
- [ ] Listed on the AnyAgent README and docs

### 3.3 — One-liner per use case
- [ ] "Make your GPU server's Ollama available as an MCP tool": `npx @anyagent/worker --hub ws://... --recipe ollama`
- [ ] "Make Claude Code on your VPS an MCP tool": `npx @anyagent/worker --hub ws://... --recipe claude`
- [ ] Each recipe is a single copy-paste command

---

## Phase 4: Model-Agnostic Positioning (Weeks 9-10)

**Goal:** Differentiate from Anthropic (they'll never federate non-Claude agents).

### 4.1 — HTTP agent type
- [ ] Workers can wrap HTTP APIs (not just spawned processes)
- [ ] Config: `{"name":"my-api","type":"http","url":"http://localhost:11434/api/generate","capabilities":["inference"]}`
- [ ] Hub calls the HTTP endpoint instead of spawning a process
- [ ] No PTY, no binary, just HTTP — works with any REST API

### 4.2 — Multi-model demo
- [ ] Blog post / video: "Claude Code + Ollama + custom Python agent, all as MCP tools"
- [ ] Show the routing: "analyze this" → Claude, "generate image" → Stable Diffusion, "run tests" → shell
- [ ] This is the use case no single-vendor solution can match

---

## Phase 5: Community & Ecosystem (Weeks 11-12)

### 5.1 — Discord community
- [ ] AnyAgent Discord server
- [ ] Channels: #general, #show-your-setup, #recipes, #help, #development
- [ ] Share multi-machine setups, worker configs, use cases

### 5.2 — Contributor onboarding
- [ ] CONTRIBUTING.md with architecture guide
- [ ] "Good first issue" labels on GitHub
- [ ] Clear module boundaries for new contributors

### 5.3 — Integrations
- [ ] Discord bot management plugin (same as Telegram, for Discord users)
- [ ] Slack bot management plugin
- [ ] VS Code extension that shows AnyAgent status in sidebar

---

## Phase 6: Hardening (Months 4-6)

### 6.1 — TLS support
- [ ] Native wss:// support in hub (not just reverse proxy)
- [ ] Auto-TLS with Let's Encrypt for public-facing hubs
- [ ] MCP server on HTTPS

### 6.2 — A2A protocol support
- [ ] Hub publishes A2A Agent Card describing aggregate capabilities
- [ ] Other A2A-speaking agents can discover and delegate to AnyAgent
- [ ] Positions AnyAgent at the intersection of MCP (tool calling) and A2A (agent coordination)

### 6.3 — Multi-user
- [ ] Replace single ALLOWED_USER_ID with users table
- [ ] Roles: admin, operator, viewer
- [ ] Scoped MCP tokens per user

---

## Success Metrics

| Milestone | Target | Timeline |
|-----------|--------|----------|
| npm published | Available via npx | Week 2 |
| GitHub stars | 100 | Week 4 |
| MCP directory listed | 4+ directories | Week 2 |
| HN front page | 1 post | Week 3 |
| GitHub stars | 500 | Week 8 |
| Python SDK published | pip install | Week 6 |
| Agent recipes | 10+ recipes | Week 8 |
| GitHub stars | 1,000 | Week 12 |
| Discord members | 100+ | Week 12 |
| Monthly active users | 500+ | Month 4 |

## What NOT to Build

- **Plugin marketplace** — We're infrastructure, not an app store
- **Built-in AI reasoning** — Agents bring their own intelligence
- **Multi-agent orchestration** — Research shows 41-86% failure rate. Stay single-agent-per-task.
- **Cloud hosting** — Self-hosted is the positioning. Cloud would compete with Manus on their turf.
- **Mobile app** — Telegram/Discord is enough for mobile management
- **Complex UI** — The product is the MCP bridge. Keep management minimal.
