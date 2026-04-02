# AnyAgent v2 — Product Requirements Document

## Personal MCP Bridge for Distributed Agents

**Author:** Product
**Status:** Final (research-validated)
**Date:** 2026-04-02
**Target:** v2.0

---

## Problem Statement

Developers running AI agents across multiple machines (Claude Code on a laptop, a local LLM on a Linux box, custom tools on a VPS) have no simple way to make those agents available as **MCP tools** to each other and to the broader AI ecosystem. Today, Claude Code on your laptop cannot call an agent on your GPU server. Each machine is an island.

The infrastructure to solve this exists — AgentGateway (Linux Foundation), IBM ContextForge — but it's all enterprise-grade, requiring RBAC policies, Cedar/CEL policy languages, JWT configuration, and Kubernetes deployment. There is nothing for a single developer who wants to run one command per machine and have their agents composable.

Meanwhile, "remote agent access via chat" is already solved: Claude Code Remote Control bridges sessions to mobile, Manus does AI agents in Telegram with full reasoning. AnyAgent v1's TTY relay cannot compete with either.

**Who is affected:** Technical power users (developers, researchers, DevOps) who self-host 2-5 machines with different AI agents and want them to work together as MCP tools, managed from Telegram without enterprise overhead.

**Cost of not solving:** Agents remain siloed per machine. Users either manually copy-paste between agents, set up enterprise gateways they don't need, or accept that their distributed agents can't compose.

---

## Goals

1. **G1: MCP tool federation.** Every agent on every connected worker is automatically exposed as an MCP tool. Any MCP client (Claude Code, Cursor, etc.) can call them. Target: agent discoverable as MCP tool within 30 seconds of worker connecting.

2. **G2: Task tracking.** Every request (from Telegram or MCP) becomes a persistent task with lifecycle and result. Target: users can see status and results of any task from the last 30 days.

3. **G3: Telegram as management plane.** Workers are paired, approved, monitored, and managed via Telegram. Task alerts and results are pushed to Telegram. Target: full system management without SSH.

4. **G4: Zero-config worker setup.** A worker declares its agents on startup and they appear everywhere — as Telegram bot agents AND as MCP tools. Target: worker setup is one env file + one command.

5. **G5: Privacy-first self-hosting.** All data stays on user infrastructure. No external API calls required. Zero telemetry. Target: fully air-gapped deployment possible.

---

## Non-Goals

- **Multi-agent orchestration / task decomposition.** Research shows 41-86% failure rate for multi-agent systems in production with 17.2x error amplification. AnyAgent routes to ONE agent per task. Decomposition is a v3+ concern after single-agent reliability is proven. (Source: ICLR 2026 multi-agent reliability research)

- **LLM-based intent routing.** Adds latency, cost, and failure modes. V2 uses rules-based capability matching + human selection when ambiguous. LLM routing is v3. (Source: Gartner — 40%+ of agentic AI projects cancelled due to complexity)

- **Agent-to-agent delegation.** Same risk profile as decomposition. Requires typed handoffs and state contracts that don't exist yet. V3+.

- **Auto-retry on failure.** Cascading failure risk when agents retry with bad state. V2 has manual retry (user taps button). Auto-retry is v3 after error patterns are understood.

- **Web dashboard / Telegram Mini App.** No evidence of need. Telegram chat + pinned status is sufficient. Revisit in v2.1 if data warrants.

- **Competing with Claude Code Remote or Manus.** AnyAgent is not a "chat with AI" product. It's MCP infrastructure. Telegram is for management, not execution.

---

## User Stories

### Primary Persona: The Multi-Machine Developer

A developer with Claude Code on their laptop, a local LLM on a home server, and scripts on a VPS. Wants them to work together.

- **US-1:** As a developer, I want Claude Code on my laptop to call my GPU server's agent as an MCP tool, so that I can offload heavy tasks without manually SSH-ing.

- **US-2:** As a developer, I want to run `anyagent-worker` on a new machine, approve it in Telegram, and have its agents appear as MCP tools everywhere within a minute.

- **US-3:** As a developer, I want to see in Telegram which workers are online, what tasks are running, and get notified when tasks complete or fail, so that I have visibility without checking each machine.

- **US-4:** As a developer, I want to trigger tasks from Telegram when I'm away from my laptop, so that I can kick off work from my phone and check results later.

- **US-5:** As a developer, I want failed tasks to show me the error and let me retry with one tap, so that transient failures don't require re-typing.

- **US-6:** As a developer, I want queued tasks to start automatically when the busy agent finishes, so that I can batch requests without babysitting.

### Secondary Persona: The Returning User

Comes back after days away. Needs to see what happened and what's available.

- **US-7:** As a returning user, I want to see recent task history and results, so that I know what my agents did while I was away.

- **US-8:** As a returning user, I want to type what I need in Telegram and have the hub pick the right agent, so that I don't need to remember agent names.

---

## Requirements

### Must-Have (P0) — Ship These or Don't Ship

#### P0-1: Worker SDK Package

A library that workers import instead of writing raw WebSocket code. Foundation for everything else.

**Acceptance Criteria:**
- [ ] New package: `sdk/` directory in monorepo (not published to npm yet)
- [ ] Exports `createWorker(hubUrl, config)` — handles connection, auth, pairing, declare, reconnect
- [ ] Exports structured output helpers: `sendStatus(text)`, `sendProgress(current, total, label?)`, `sendResult(markdown)`, `sendError(message)`
- [ ] Exports `onSpawn(handler)` — callback when hub requests agent spawn
- [ ] Legacy PTY mode: workers that use the SDK can still spawn PTY processes and stream binary TTY
- [ ] The existing `worker/` package is refactored to use the SDK internally
- [ ] Config type: `{ name, description, agents: [{ name, binary, args, description, capabilities }] }`
- [ ] Capabilities array added to agent declaration (e.g., `["coding", "shell", "research"]`)

#### P0-2: Task Model

Every request (Telegram or MCP) becomes a tracked, persistent task.

**Acceptance Criteria:**
- [ ] New `tasks` table: `task_id` (TEXT PK), `source` ("telegram" | "mcp"), `chat_id` (nullable — null for MCP tasks), `intent` (user's original text), `status` ("submitted" | "queued" | "routed" | "running" | "complete" | "failed" | "timeout"), `agent_name`, `node_id`, `result_summary`, `error`, `created_at`, `updated_at`
- [ ] Every user text message creates a task (unless routed as input to a running interactive task)
- [ ] MCP tool calls create tasks with `source: "mcp"`
- [ ] Tasks persist in SQLite, survive hub restarts
- [ ] `/tasks` command shows last 10 tasks with status emoji and one-line summary
- [ ] Completed/failed tasks retained for 30 days (cleanup cron)
- [ ] `capabilities` column added to `agents` table (TEXT, JSON array)

#### P0-3: MCP Server Mode (Core Differentiator)

The hub exposes all registered agents as MCP tools. This is the product.

**Acceptance Criteria:**
- [ ] Hub runs an MCP server using Streamable HTTP transport on configurable port (`MCP_PORT` env, default 3000)
- [ ] Each declared agent becomes an MCP tool:
  - Tool name: agent name (e.g., `claude`, `shell`, `researcher`)
  - Tool description: agent description from `declare`
  - Input schema: `{ intent: string }` — natural language description of what to do
- [ ] One aggregated meta-tool `anyagent_route`: accepts intent string, hub picks the best agent by capability matching
- [ ] MCP tool calls create tasks (`source: "mcp"`) and route to the appropriate worker
- [ ] Task results returned as MCP tool results (text content from `result_summary`)
- [ ] If worker is busy, tool call returns queued status with task_id; client can poll via `anyagent_task_status` tool
- [ ] Auth: bearer token via `MCP_TOKEN` env (required)
- [ ] `anyagent_list_agents` tool: returns all registered agents with capabilities and online status
- [ ] `anyagent_task_status` tool: returns task status and result by task_id
- [ ] User notified in Telegram when MCP client triggers a task: "MCP: 'run tests on staging' → shell-agent on vps-01"
- [ ] When no MCP_PORT is set, MCP server does not start (opt-in)

#### P0-4: Structured Agent Output

Agents communicate results through structured messages. Output format designed to serve both Telegram rendering and MCP tool results.

**Acceptance Criteria:**
- [ ] New JSON-RPC method `output` from worker to hub: `{ task_id, type, payload }`
- [ ] Types: `"status"` (text), `"progress"` (current, total, label), `"result"` (markdown text), `"error"` (message)
- [ ] Hub renders for Telegram:
  - `status` — italic text
  - `progress` — edited-in-place message with step count
  - `result` — markdown rendered to Telegram HTML (final message)
  - `error` — error block with Retry button
- [ ] Hub stores `result` payload as `tasks.result_summary` — this becomes the MCP tool result
- [ ] Raw TTY mode preserved as fallback: if worker sends binary frames instead of `output` RPCs, hub uses existing ANSI-strip + `<pre>` rendering
- [ ] Auto-detect: first message type determines mode per task (structured vs TTY)

#### P0-5: Capability-Based Routing

Hub matches tasks to agents by capability, with human fallback when ambiguous.

**Acceptance Criteria:**
- [ ] Workers declare capabilities per agent in `declare` RPC: `capabilities: string[]`
- [ ] Routing logic (rules-based, no LLM):
  1. If default agent is set and online → route there
  2. If only one agent online → route there
  3. If task comes from MCP via a specific agent tool → route to that agent
  4. If task comes from MCP via `anyagent_route` or from Telegram → match intent keywords against agent capabilities
  5. If multiple agents match → Telegram: show inline buttons to pick. MCP: pick highest-specificity match.
  6. If no agents match → Telegram: suggest available agents. MCP: return error with available capabilities.
- [ ] Keyword matching: hub scans intent for words that overlap with agent capabilities (e.g., intent contains "deploy" → matches agent with capability "deployment")
- [ ] `/call <agent>` bypasses routing (explicit override)
- [ ] Routing decision logged on task: `routing_method` ("default" | "single" | "matched" | "explicit" | "user_selected")

#### P0-6: Task Queue

Handle busy workers gracefully.

**Acceptance Criteria:**
- [ ] When routed worker has a running task, new task enters `queued` status
- [ ] User notified: "Agent busy. Task queued (position #N)."
- [ ] Queued tasks auto-start when current task on that worker completes (FIFO)
- [ ] User can cancel queued tasks via inline button
- [ ] Queue depth per worker capped at 3 (configurable via `MAX_QUEUE_DEPTH`)
- [ ] MCP tool calls for busy agents return: `{ status: "queued", task_id: "..." }` — client can poll

#### P0-7: Failure Recovery (Manual Retry)

Failed tasks are clearly reported with a one-tap retry.

**Acceptance Criteria:**
- [ ] On task failure (crash, disconnect, spawn error): set `status: "failed"`, store `error`
- [ ] Telegram notification with error detail and inline "Retry" button
- [ ] Retry creates a new task with same intent, error injected as context prefix: "Previous attempt failed: [reason]."
- [ ] Worker disconnect mid-task: hub waits 60 seconds for reconnection before marking failed
- [ ] Max 3 retries per original task
- [ ] MCP tool calls for failed tasks return error with `retry_task_id` field

#### P0-8: Live Status Pinned Message

Push-based system visibility via Telegram.

**Acceptance Criteria:**
- [ ] On `/start`, hub sends and pins a status message
- [ ] Auto-updates every 30 seconds showing:
  - Workers: online/total count with names
  - MCP server: running/stopped, port number
  - Running tasks: agent name, elapsed time, source (Telegram/MCP)
  - Last completed task: one-line result
  - Default agent if set
- [ ] Immediate update on: task start/complete/fail, worker connect/disconnect
- [ ] If pinned message deleted, `/status` re-creates and pins it

#### P0-9: Context Carry (Simplified)

Carry the last task's result to the next task for basic continuity.

**Acceptance Criteria:**
- [ ] When routing a new task, hub prepends the `result_summary` of the last completed task in the same chat as a context line: `"[Context from previous task: {summary}]"`
- [ ] Only the single most recent completed task's summary is carried (not multiple tasks)
- [ ] Context carry only for Telegram tasks (MCP clients manage their own context)
- [ ] Max 500 chars of context (truncate if longer)
- [ ] Agents that declare `context_aware: false` skip context injection

---

### Nice-to-Have (P1) — Fast Follows

#### P1-1: Task History

- [ ] `/history` shows last 20 tasks with status, agent, source, and one-line result
- [ ] `/history <task_id>` shows full detail
- [ ] Inline keyboard with task buttons for quick detail view

#### P1-2: File and Artifact Handling

- [ ] New `artifact` RPC from worker: `{ task_id, filename, mime_type, data_base64 }`
- [ ] Hub sends files as Telegram documents in the task reply chain
- [ ] MCP tool results include artifact references (filename + size)
- [ ] Artifacts stored on disk, linked to tasks in DB

#### P1-3: Agent Health Monitoring

- [ ] Workers send periodic `health` RPC: `{ cpu, memory, active_processes }`
- [ ] Hub shows health in worker detail view (tap worker in `/workers`)
- [ ] Alert user if thresholds exceeded

#### P1-4: Telegram Topics for Parallel Tasks

- [ ] In group/supergroup with topics enabled: each task gets its own topic
- [ ] Main topic shows status overview
- [ ] In DM mode: reply-chain threading

---

### Future Considerations (P2)

#### P2-1: A2A Protocol Support
Hub publishes an Agent Card. Design constraint: capability schema must be A2A-compatible.

#### P2-2: Multi-User with Roles
Replace `ALLOWED_USER_ID` with users table. Design constraint: queries already scope by `chat_id`.

#### P2-3: Concurrent Tasks per Worker
Binary frame multiplexing with task_id headers. Design constraint: include `task_id` in spawn/output from v2.

#### P2-4: LLM-Based Routing
Add `ROUTING_MODE=api` for Claude Haiku intent parsing. Design constraint: routing interface is already abstracted.

#### P2-5: Task Decomposition
Multi-step tasks across agents. Design constraint: task schema supports `parent_task_id` nullable column addition later.

---

## Success Metrics

### Leading Indicators (1-4 weeks)

| Metric | Target | Stretch | Measurement |
|--------|--------|---------|-------------|
| MCP tool discovery | Agents appear as MCP tools within 30s of worker connecting | 10s | Time from `declare` RPC to MCP tool listing |
| MCP task completion | 70% of MCP-initiated tasks complete successfully | 85% | `tasks WHERE source='mcp' AND status='complete'` |
| Telegram task completion | 70% of Telegram-initiated tasks complete | 85% | `tasks WHERE source='telegram' AND status='complete'` |
| Routing accuracy | 80% of tasks routed without manual `/call` | 90% | `tasks WHERE routing_method != 'explicit'` |
| Worker pairing time | < 2 minutes from `/pair` to agent available | < 1 min | Manual test |

### Lagging Indicators (1-3 months)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Worker fleet size | 3+ workers connected | `SELECT count(*) FROM nodes` |
| MCP adoption | 50%+ of tasks originate from MCP clients | `tasks WHERE source='mcp' / total` |
| Daily active usage | 5+ days/week with tasks | Distinct task-days per week |
| TTY fallback rate | < 30% of tasks use legacy TTY mode | Tasks with binary output vs structured |

---

## Open Questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| 1 | MCP transport: Streamable HTTP (standard) or stdio proxy for local use? Both? | Engineering | Yes — determines MCP server implementation |
| 2 | Should MCP tool calls be synchronous (block until result) or async (return task_id, client polls)? Long tasks may timeout MCP clients. | Engineering | Yes — affects tool schema design |
| 3 | Capability keyword matching: exact match only, or substring/fuzzy? How to handle overlapping capabilities? | Engineering | No — start with substring, refine with usage data |
| 4 | Should pinned status include MCP server connection info (URL, token hint) for easy client setup? | Product | No — convenience feature |
| 5 | Worker SDK: TypeScript only, or also provide a Python SDK for non-Node workers? | Engineering | No — TypeScript first, Python is P1 |

---

## Phasing

### Phase A — Foundation + MCP (The Product)

- P0-1: Worker SDK with capabilities declaration
- P0-2: Task model in DB
- P0-3: MCP server exposing agents as tools
- P0-4: Structured output protocol
- Extend `declare` with `capabilities` and `protocol_version`
- This phase delivers the core product: workers connect, agents appear as MCP tools

### Phase B — Management Intelligence

- P0-5: Capability-based routing
- P0-6: Task queue
- P0-7: Failure recovery (manual retry)
- P0-8: Pinned status message
- P0-9: Context carry
- This phase makes Telegram a proper management plane

### Phase C — Fast Follows

- P1-1: Task history
- P1-2: File/artifact handling
- P1-3: Health monitoring
- P1-4: Telegram Topics

### Migration Path

- v2 hub MUST handle v1 workers (no capabilities = all tools manual-only, TTY output mode)
- v2 workers backward-compatible with v1 hubs (send `declare` without capabilities, no `output` RPC)
- `protocol_version` field in `declare` enables version detection

---

## Appendix: v1 vs v2

| Dimension | v1 (Current) | v2 (Target) |
|-----------|-------------|-------------|
| Core identity | Telegram-to-TTY relay | Personal MCP Bridge |
| Execution interface | Telegram only | MCP (primary) + Telegram (secondary) |
| Management interface | Telegram commands | Telegram (sole management plane) |
| Unit of work | Session (process lifetime) | Task (persistent, multi-source) |
| Ecosystem integration | Island (custom JSON-RPC) | MCP server (97M+ monthly downloads ecosystem) |
| Routing | Manual: `/call <name>` | Capability matching + human fallback |
| Output | Raw TTY `<pre>` blocks | Structured: status, progress, result, error |
| Context | Fresh every session | Last-result carry |
| Worker integration | Raw WebSocket code | `@anyagent/worker-sdk` |
| Agent metadata | name, binary, args, description | + capabilities[], protocol_version |
| Failure handling | Silent exit | Error detail + manual retry button |
| Busy handling | Undefined | Task queue (FIFO, cap 3) |
| Status | Pull (`/status` command) | Push (pinned auto-updating message) |
