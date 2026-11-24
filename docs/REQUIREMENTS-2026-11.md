# AnyAgent — Market-Driven Requirements (November 2026)

**Date:** 2026-11-24
**Supersedes:** nothing. This refreshes the April 2026 research (`RESEARCH-requirement-validation.md`, `MARKET-COMPARISON.md`) with what changed since then.
**Scope:** the hub's MCP surface, worker trust, and discovery. Distribution and community work is tracked in `ROADMAP.md`.

---

## 1. What changed in the market since April 2026

| # | Trend | Evidence | Why it matters to AnyAgent |
|---|---|---|---|
| T1 | **MCP 2026-07-28 spec: stateless core.** `initialize`/`initialized` and `Mcp-Session-Id` are gone. Version, client info and capabilities ride in each request's `_meta`. New `server/discover`. Streamable HTTP requests carry `Mcp-Method` / `Mcp-Name` headers. List results get `ttlMs`/`cacheScope`. Roots, Sampling and Logging are deprecated. | [MCP blog: 2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | The hub is pinned to `@modelcontextprotocol/sdk` 1.29 (protocol 2025-11-25). New-spec support only exists in the v2 packages (`@modelcontextprotocol/server` 2.x, `createMcpHandler` with a legacy fallback). |
| T2 | **Tasks became an official MCP extension** (`io.modelcontextprotocol/tasks`, SEP-2663). Long calls return `resultType: "task"` with `taskId`, `ttlMs`, `pollIntervalMs`; clients poll `tasks/get` and can `tasks/cancel`. | [MCP Tasks extension docs](https://modelcontextprotocol.io/extensions/tasks/overview), [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) | AnyAgent already has a durable task model, but exposes it through a bespoke `anyagent_task_status` tool. There is no cancel, and blocking calls are capped at 120 s. |
| T3 | **Tool metadata is the main injection surface.** OWASP says to treat the whole tool schema as untrusted, pin reviewed definitions by hash, and re-review on change. A 2026 study found most MCP clients (including Claude Desktop/Code) weak against tool poisoning. | [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html), [CSA Agentic MCP guide](https://labs.cloudsecurityalliance.org/agentic/agentic-mcp-security-best-practices-v1/), [client study, arXiv 2603.22489](https://arxiv.org/abs/2603.22489) | Worker-declared descriptions become MCP tool descriptions **verbatim**. A compromised worker can poison every MCP client connected to the hub. |
| T4 | **Self-hosted gateways compete on governance**: audit trails, per-agent allowlists, scoped credentials. Docker moved its MCP gateway behind its governance product. OpenClaw community guides warn that every agent on a gateway can reach every MCP server by default and recommend per-agent allowlists. | [Mastra gateway roundup](https://mastra.ai/articles/best-mcp-gateways), [Speakeasy](https://www.speakeasy.com/blog/best-mcp-gateways-for-enterprise-2026) (vendor comparisons; no independent adoption survey found) | AnyAgent has one shared bearer token with full access and no audit of MCP calls. |
| T5 | **A2A v1.0** (May 2026) now sits beside MCP under the Agentic AI Foundation. 150+ organisations, native in Google/Microsoft/AWS. Agent Cards are served at `/.well-known/agent-card.json` with `supportedInterfaces`. The consensus is "MCP inside an agent, A2A between agents". | [Linux Foundation press release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), `@a2a-js/sdk` 1.3.0 types | AnyAgent is already a fleet of agents. An Agent Card makes the fleet discoverable by A2A orchestrators at low cost. |
| T6 | **Discovery documents** are emerging but not settled: MCP Server Cards (SEP-2127, experimental, `<mcp-url>/server-card`) and competing `.well-known` drafts. | [SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards), [IETF draft](https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/) | Cheap to publish, but the path may still change. Ship it opt-in. |
| T7 | **Anthropic closed the Claude-only multi-machine gap.** Claude Code Remote Control (Feb 2026), then self-hosted environments and cross-session messaging (Aug 2026, Team/Enterprise; secondary source). | [DevOps.com](https://devops.com/claude-code-remote-control-keeps-your-agent-local-and-puts-it-in-your-pocket/), [Digital Applied](https://www.digitalapplied.com/blog/claude-code-self-hosted-runners-cross-session-agent-messaging) | The roadmap's "6-month window" has closed for Claude-only users. AnyAgent's defensible position is now **model-agnostic** (Codex, Gemini CLI, Ollama, aider, scripts), **free**, and **personal**. Security and governance are what make it trustworthy enough to run. |
| T8 | **Tool annotations and structured output are mainstream.** `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`), `title`, `outputSchema` and `structuredContent` have been in the spec since 2025-06-18, and clients use them to decide when to ask for confirmation. | MCP spec 2025-06-18 / 2025-11-25 | Every AnyAgent tool returns plain text with no annotations, so clients cannot tell a read-only status query from "run a shell agent on my server". |

Two research sources (`aaif.io`, `a2a-protocol.org`) were blocked by the research environment's network policy. A2A field names were taken from the official `@a2a-js/sdk` type definitions instead.

---

## 2. Requirements

Priority: **P0** = credibility or security gap, ship first. **P1** = expected by users of a 2026 MCP gateway. **P2** = differentiation, opt-in.
Effort: **S** < 1 day, **M** 1–3 days, **L** > 3 days.

### AR-0 — Automated tests and CI *(enabler)*
The repo has no automated tests, so security work cannot be shipped credibly without regression coverage.
- [ ] `npm test` in `hub/` runs `node:test` suites via `tsx`, each run against an isolated `ANYAGENT_HUB_DIR`.
- [ ] `tsconfig.json` compiles `src/` only, so tests never land in `dist/`.
- [ ] `.github/workflows/ci.yml` builds hub, sdk and worker and runs hub tests on every push and PR.

**P0 · S**

### AR-1 — Spec-current MCP tool metadata *(T8)*
- [ ] Every tool has a human `title` and `annotations`. Status/list/context tools: `readOnlyHint: true`. Agent and route tools: `destructiveHint: true, openWorldHint: true`.
- [ ] `anyagent_list_agents`, `anyagent_task_status`, `anyagent_route` and the agent tools declare an `outputSchema` and return matching `structuredContent`, alongside the existing text content for older clients.

**P0 · S**

### AR-2 — Sanitize worker-declared metadata *(T3)*
- [ ] On `declare`, agent names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. Agents that fail are rejected and logged.
- [ ] Descriptions are stripped of control, zero-width and bidi-override characters, whitespace is collapsed, and length is capped (300 chars).
- [ ] Capabilities are lower-cased, restricted to `[a-z0-9_-]`, max 32 chars each, max 16 items. Node name and description get the same treatment.
- [ ] Every change made by sanitization emits a `worker.metadata_sanitized` event.

**P0 · S**

### AR-3 — Agent definition pinning (rug-pull protection) *(T3)*
- [ ] Each agent's definition (binary, args, description, capabilities, context-aware flag) is hashed (SHA-256) and pinned on first sight (trust on first use).
- [ ] If a later `declare` changes the hash, the agent is **quarantined**: hidden from MCP `tools/list`, routing and `/agents`, until the operator approves it with CLI `review` or Telegram `/review`. Quarantine emits `agent.quarantined`.
- [ ] `AGENT_REVIEW=changes` (default) quarantines changed definitions only. `all` also quarantines new agents. `off` restores the previous behaviour.
- [ ] Re-declaring an unchanged definition preserves `trusted` and `created_at` (fixes reconnect churn).
- [ ] Trust is per `(name, node)`. Trusting `claude@laptop` no longer trusts `claude@other`.

**P0 · M**

### AR-4 — MCP audit trail *(T4)*
- [ ] Every MCP tool call emits an `mcp.call` event with tool name, resolved `agent@node`, token label, task id, outcome, duration, and a SHA-256 prefix of the intent. Intent text is not logged by default (privacy-first); `AUDIT_LOG_INTENT=1` opts in.
- [ ] CLI `audit [n]` prints recent MCP calls.

**P1 · S**

### AR-5 — Scoped MCP tokens *(T4)*
- [ ] Named tokens are stored as SHA-256 hashes in SQLite. The plaintext is shown once, at creation.
- [ ] Each token has an agent allowlist (`*` or names) and an optional read-only scope.
- [ ] `tools/list` shows only what the token may call, and calls outside scope are refused.
- [ ] CLI: `token create <label> [--agents a,b] [--readonly]`, `token list`, `token revoke <label>`.
- [ ] `MCP_TOKEN` keeps working as the full-access admin token. The MCP server starts if `MCP_TOKEN` is set **or** any scoped token exists.

**P1 · M**

### AR-6 — Task handles aligned with MCP Tasks *(T2)*
- [ ] Async responses return a structured handle: `{ taskId, status, pollIntervalMs, ttlMs }`, using the extension's vocabulary (`working`, `input_required`, `completed`, `failed`, `cancelled`).
- [ ] New `anyagent_task_cancel` tool cancels queued, pending-approval or running tasks. Running tasks are killed on the worker.
- [ ] New first-class `cancelled` task status across the DB, CLI and Telegram.
- [ ] During blocking calls, worker `status`/`progress` output is relayed as `notifications/progress` when the client supplied a `progressToken`.

**P1 · M**

### AR-7 — MCP 2026-07-28 dual-stack *(T1)*
- [ ] Serve 2026-07-28 clients (stateless, `server/discover`, header routing, `ttlMs` on lists) while keeping 2025-11-25 clients working, via `@modelcontextprotocol/server` v2 `createMcpHandler` + legacy fallback.
- [ ] Native `io.modelcontextprotocol/tasks` extension backed by the AR-6 task model.

**P1 · L** — depends on AR-1 and AR-6 (tool definitions and task model ported once).

### AR-8 — A2A Agent Card + minimal A2A binding *(T5)*
- [ ] With `A2A_ENABLED=1`, the hub serves `/.well-known/agent-card.json` in A2A v1.0 shape (`supportedInterfaces`, `capabilities`, `securitySchemes`, one skill per agent). Quarantined agents are excluded.
- [ ] Minimal JSON-RPC binding (`SendMessage`, `GetTask`, `CancelTask`) mapped onto the hub's task model and protected by the same bearer tokens.

**P2 · M**

### AR-9 — MCP Server Card *(T6)*
- [ ] With `MCP_SERVER_CARD=1`, serve an SEP-2127 server card at `/mcp/server-card` and `/.well-known/mcp/server-card.json`. Off by default because the paths are not final.

**P2 · S**

### AR-10 — Refresh positioning *(T7)*
- [ ] Update `MARKET-COMPARISON.md` for the November 2026 landscape (Anthropic multi-machine, OpenClaw MCP mode, governance gateways).
- [ ] Sync `ROADMAP.md` checkboxes with what has shipped, and link this document.

**P1 · S**

---

## 3. Order of work

1. AR-0 (enables everything else).
2. AR-1 → AR-2 → AR-3: security and metadata, the P0 credibility gap.
3. AR-4 → AR-5: governance.
4. AR-6: task semantics, a prerequisite for AR-7.
5. AR-8 / AR-9: discovery, opt-in.
6. AR-10: docs.
7. AR-7: the largest change. Last, so it ports finished tool definitions instead of moving targets.

## 4. Status

| ID | Status |
|---|---|
| AR-0 | planned |
| AR-1 | planned |
| AR-2 | planned |
| AR-3 | planned |
| AR-4 | planned |
| AR-5 | planned |
| AR-6 | planned |
| AR-7 | planned |
| AR-8 | planned |
| AR-9 | planned |
| AR-10 | planned |

## 5. Explicitly not doing

- **LLM-based routing, multi-agent orchestration** — unchanged from the April research (high failure rates). Still out.
- **Hosted/cloud offering** — self-hosted remains the position.
- **Adopting deprecated MCP features** (Roots, Sampling, Logging, HTTP+SSE) — the 2026-07-28 spec deprecates them.
