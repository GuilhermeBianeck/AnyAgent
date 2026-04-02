# AnyAgent v2 — Requirement Validation Research

## Date: 2026-04-02

---

## Executive Summary

After deep market research, several PRD requirements are **overengineered for the wrong niche**. The spec tries to build a "personal agent control plane" — but Claude Code Remote already does that, Manus already does Telegram agents, and multi-agent orchestration has a 41-86% production failure rate.

The real niche is narrower and more valuable: **Personal MCP Bridge** — make any process on any of your machines discoverable as an MCP tool, managed via Telegram. Nobody does this simply. The infrastructure exists (AgentGateway, ContextForge) but it's all enterprise-grade complexity. AnyAgent should be the simple, self-hosted, personal version.

This changes what's P0, what's P2, and what should be cut entirely.

---

## Market Reality Check

### Finding 1: Claude Code Already Solves Remote Agent Access

Claude Code (as of March 2026) natively supports:
- **Remote Control**: bridge local CLI sessions to mobile via claude.ai/code, iOS/Android apps
- **Headless mode**: run programmatically on VPS, no terminal needed
- **Agent Teams**: one session coordinates multiple agents via shared task list
- **Background agents**: sub-tasks in independent git worktrees
- **Remote Sessions**: WebSocket-based, outbound HTTPS only, no exposed ports

**Impact on AnyAgent:** The "talk to Claude via Telegram" use case is directly solved by Claude Code Remote Control. AnyAgent competing here offers less functionality than the native tool.

### Finding 2: Multi-Agent Orchestration Fails at Alarming Rates

Research data from 2026:
- Multi-agent LLM systems fail **41-86% of the time** in production
- **40%** of multi-agent pilots fail within 6 months of production deployment
- Unstructured multi-agent networks amplify errors **17.2x** vs single-agent baselines
- 5 agents at 95% individual reliability = **77% system reliability** (compounding)
- Gartner: **40%+** of agentic AI projects will be cancelled by end of 2027
- Agent effectiveness degrades after **35 minutes** of continuous operation
- Doubling task duration **quadruples** the failure rate

**Impact on AnyAgent:** Task decomposition (P0-6) and agent-to-agent delegation (P1-5) are extremely high-risk features. Building them before single-agent tasks are reliable is premature. The "hierarchical decomposition" pattern only works with typed handoffs and explicit state contracts (GitHub's finding) — not with raw text piping.

### Finding 3: MCP Is the Ecosystem — And Nobody Does Personal MCP Bridge Simply

MCP status in 2026:
- **97M+ monthly SDK downloads** (Python + TypeScript)
- Adopted by **every major AI provider**: Anthropic, OpenAI, Google, Microsoft, Amazon
- Under the **Linux Foundation** (AAIF) — not a vendor play anymore
- Every modern AI tool (Claude Code, Cursor, Windsurf, etc.) is an MCP client

MCP gateway/proxy landscape:
- **AgentGateway** (Linux Foundation): enterprise-grade, Rust-based, requires understanding of CEL policies, RBAC, JWT, TLS
- **IBM ContextForge**: 3,500+ stars, federates MCP+A2A+REST — enterprise complexity
- **Solo.io AgentGateway**: commercial platform for MCP/A2A management
- **mcp-proxy**: simple stdio↔SSE bridge, but only proxies one server at a time
- **mcpo**: converts one MCP server to REST OpenAPI

**The gap:** There is NO simple, self-hosted tool that says: "I have agents on 3 machines. I want them all available as MCP tools from my laptop." AgentGateway is the closest but requires enterprise setup. mcp-proxy does single-server bridging. Nobody does **multi-machine MCP tool federation for personal use**.

**Impact on AnyAgent:** MCP Server Mode should be THE core feature, not a P1 afterthought. AnyAgent's hub already has: multi-machine WebSocket connections, agent registry with capabilities, authenticated routing. Adding MCP tool exposure on top is the highest-value, lowest-complexity move.

### Finding 4: Telegram Has Hard Limitations

Confirmed rate limits:
- **1 message/second** to same individual chat
- **20 message edits/minute** per group chat
- **30 messages/second** across different chats
- No adaptive limits yet (2026 beta testing, tied to bot reputation)

**Impact on AnyAgent:** The edit-in-place output strategy (P0-3) will hit the 20 edits/min ceiling for any agent that produces frequent output. Structured output needs to batch aggressively. Also: long-running tasks with streaming output don't map well to Telegram's model. Telegram is better as a MANAGEMENT interface (start task, get final result) than an EXECUTION interface (stream every line of output).

### Finding 5: What Users Actually Want

2026 survey data:
- **81%** concerned about AI using personal data → privacy-first positioning is correct
- **51%** of tech workers demand customization → self-hosted + configurable is correct
- **34%** want AI to act only with approval for each action → human-in-the-loop is correct
- **38%** use human-in-the-loop as primary agent management approach
- Only **6%** of consumers have actually used an AI agent → the market is early-adopter only
- Primary desire: agents that handle "annoying parts" — not complex orchestration

**Impact on AnyAgent:** The target user wants simple, controllable, private agents — NOT multi-step task decomposition with autonomous routing. Keep it simple. Human-in-the-loop. Approval-based. The "just type and it works" vision is aspirational but not what real users are asking for yet.

---

## Requirement-by-Requirement Validation

### P0-1: Task Model — VALIDATED, KEEP AS P0

**Evidence:** Every competing product has persistent tasks. Claude Code has background tasks with tracking. Manus tracks tasks end-to-end. This is table stakes.

**Verdict:** Keep. But simplify — tasks don't need decomposition support in the schema. Just: `task_id`, `chat_id`, `source` (telegram/mcp), `intent`, `status`, `agent_name`, `node_id`, `result_summary`, `error`, `created_at`, `updated_at`. Remove `parent_task_id` — decomposition is cut from v2.

---

### P0-2: Intent-Based Routing — DESCOPE TO CAPABILITY MATCHING

**Evidence:** LLM-based intent parsing adds a failure mode to every request. Multi-agent routing has a 41-86% failure rate. The "rules" mode (keyword matching on capabilities) is the right default. But the spec implies the hub should understand natural language intent — that requires an LLM and introduces latency, cost, and failure modes.

**Verdict:** Keep the concept, but reframe. V2 routing should be **capability matching**, not "intent parsing." The flow is:
1. User types a message
2. If a default agent is set → route there (most common case)
3. If only one agent is online → route there
4. If multiple agents with different capabilities → show inline buttons: "Which agent should handle this?"
5. `/call <name>` still works as explicit override

Cut: LLM-based routing (`ROUTING_MODE=local` and `ROUTING_MODE=api`). These are v3. The `rules` mode with simple keyword-to-capability matching is sufficient. Human-in-the-loop selection when ambiguous.

**Priority change:** Remains P0 but dramatically simpler.

---

### P0-3: Structured Agent Output — VALIDATED, KEEP AS P0

**Evidence:** Raw TTY is confirmed bad. Telegram rate limits (1 msg/sec, 20 edits/min) make streaming TTY impractical for production use. Structured output with batched final results fits Telegram's model better.

**Verdict:** Keep. But add: the structured output protocol should be designed as a superset of what MCP tool results look like. When the hub serves MCP tools (P0 priority, see below), the structured output from workers becomes the MCP tool result directly. Design once, use twice.

**Key addition to spec:** Output types should include `tool_result` (for MCP consumption) in addition to the existing status/progress/result/error/markdown types.

---

### P0-4: Context Injection — DESCOPE TO SIMPLE LAST-RESULT CARRY

**Evidence:** The 35-minute degradation problem means agents lose effectiveness with long contexts. Injecting too much prior context can HURT performance. GitHub's finding: typed handoffs with explicit state contracts work; unstructured context piping doesn't.

**Verdict:** Simplify drastically. V2 context injection is:
1. Carry the `result_summary` of the last completed task as a one-line preamble
2. Nothing more. No "last 3 tasks artifacts." No 2000-char context assembly.
3. Agent can request more context via a new `get_context` RPC if it's smart enough to ask

Cut: `task_context` table. Cut: multi-task context assembly. These require LLM summarization to work well, and add failure modes.

**Priority change:** Remains P0 but 80% simpler implementation.

---

### P0-5: Pinned Status Message — VALIDATED, KEEP AS P0

**Evidence:** Push-based status is good UX. Telegram supports editing pinned messages. Rate limit (20 edits/min in groups, 1/sec in DM) is fine for a 30-second update interval.

**Verdict:** Keep as-is. One concern: in 1:1 DM, pinned message editing is limited to 1/sec — fine. In group chat, 20 edits/min — also fine at 30-second intervals. No changes needed.

---

### P0-6: Task Decomposition — CUT FROM V2, MOVE TO V3+

**Evidence:** This is the hardest requirement and the research says it fails most of the time:
- 41-86% failure rate for multi-agent systems
- 17.2x error amplification in unstructured multi-agent networks
- 40% of pilot projects fail within 6 months
- Requires "typed handoffs and explicit state contracts" (GitHub) — not raw text piping

AnyAgent's workers communicate via raw TTY or simple structured output. There is no typed handoff system. Building decomposition on this foundation would produce exactly the kind of unstructured multi-agent system that fails 86% of the time.

**Verdict:** **CUT entirely from v2.** Not P1, not P2 — actively harmful to build before the single-agent task model is proven reliable. Revisit only after: (a) single-agent tasks hit 90%+ completion rate, (b) structured output with typed results is stable, (c) agent capabilities are well-defined enough to route sub-tasks correctly.

---

### P0-7: Task Queue — SIMPLIFY, KEEP AS P0

**Evidence:** Queuing is needed — without it, sending a task when an agent is busy has undefined behavior. But the "offer to reroute to alternative worker" UI flow adds complexity for a rare case.

**Verdict:** Keep, but simplify:
1. If target worker is busy → task enters `queued` status
2. User notified: "Agent busy. Your task is queued."
3. Queue auto-starts when current task completes
4. Queue depth capped at 3
5. User can cancel queued tasks

Cut: "Route to alternative worker?" inline buttons. Cut: estimated wait time calculation. These are v3 polish.

---

### P0-8: Failure Recovery — SIMPLIFY, KEEP AS P0

**Evidence:** The research shows cascading failures when agents auto-retry with bad state. Manual retry is safer. But having a "Retry" button is essential UX.

**Verdict:** Keep, but:
1. **Manual retry only** — user taps a "Retry" button, hub creates new task with same intent + error context
2. Cut: auto-retry policy, `retry_count`, `retry_delay_ms`
3. Cut: "Retry on different worker?" flow
4. Keep: reconnection grace period (60 seconds before marking failed)
5. Max 3 manual retries per task

Auto-retry is a v3 feature after error patterns are understood from real usage data.

---

### P0-9: Worker SDK — VALIDATED, KEEP AS P0

**Evidence:** If structured output is P0, workers need a library. The current raw WebSocket code in `worker/src/connection.ts` is 240 lines of protocol handling that every worker reimplements. This is the right abstraction boundary.

**Verdict:** Keep. But scope it tightly:
- Exports: `connect(hubUrl, config)`, `onSpawn(handler)`, `sendStatus()`, `sendProgress()`, `sendResult()`, `sendError()`
- The existing worker becomes the reference implementation using the SDK
- No `onTask` high-level API yet — that requires the routing engine to send structured task objects, which is premature

---

### P1-5: Agent-to-Agent Delegation — CUT, MOVE TO V3+

**Evidence:** Same data as P0-6. Agent-to-agent delegation IS multi-agent orchestration. Same failure rates apply. Additionally, the hub has no mechanism to validate that an agent's delegation request is sensible — a hallucinating agent could create infinite delegation loops.

**Verdict:** **CUT from v2.** Too dangerous without typed contracts, validation, and proven single-agent reliability.

---

### P1-6: Telegram Mini App — DEFER TO V2.1

**Evidence:** No user has asked for this. It's a solution looking for a problem. The pinned status message handles the "at a glance" case. If real usage reveals a gap that chat UI can't fill, add it then.

**Verdict:** Defer. Don't spend time on it until v2 is live and there's evidence the chat UI is insufficient.

---

### P1-7: MCP Server Mode — PROMOTE TO P0, HIGHEST PRIORITY

**This is the most important finding of the research.**

**Evidence:**
1. MCP has 97M+ monthly downloads. Every AI tool is an MCP client.
2. Claude Code already does remote sessions — AnyAgent can't compete as a "remote agent terminal."
3. Manus already does Telegram agents — AnyAgent can't compete as a "chat with AI via Telegram."
4. Nobody does "make my self-hosted agents on multiple machines available as MCP tools" simply.
5. AgentGateway exists but requires enterprise-grade setup (RBAC, CEL policies, JWT, TLS).
6. AnyAgent already has: multi-machine WebSocket connections, agent registry, auth, health monitoring.

**The realization:** AnyAgent's unique value is NOT "talk to agents via Telegram." It's **"make your distributed agents available to the MCP ecosystem, managed via Telegram."**

The user flow becomes:
1. You pair your machines via Telegram (existing flow — already good)
2. Workers declare their agents with capabilities (existing flow — extend with MCP tool schemas)
3. AnyAgent hub runs an MCP server that exposes each agent as a callable tool
4. **Claude Code on your laptop calls your GPU server's agent as an MCP tool** — AnyAgent handles routing
5. Telegram is where you MANAGE the system: see what's connected, approve pairings, check task history, get alerts

Telegram is the management plane. MCP is the execution plane. This is the niche nobody fills simply.

**Verdict:** **Promote to P0. Make it the core feature.** Re-scope as:
- Hub runs an MCP server (Streamable HTTP transport) on configurable port
- Each declared agent becomes an MCP tool with: name, description, input schema (natural language `intent` string)
- MCP tool calls create tasks in the same `tasks` table (source: "mcp")
- Results returned as MCP tool results
- Auth via bearer token (MCP_TOKEN env)
- Telegram notifications when MCP clients trigger tasks

---

## Revised Priority Stack

Based on the research, here's what v2 should actually look like:

### Tier 1 — The Product (ship these or don't ship at all)

| # | Requirement | Rationale |
|---|------------|-----------|
| P0-9 | Worker SDK | Foundation — everything else builds on this |
| P0-1 | Task Model | Every task (Telegram or MCP) needs tracking |
| P0-3 | Structured Output | Agents must communicate results, not dump TTY |
| **NEW P0** | **MCP Server Mode** | **THE differentiator — this is the product** |
| P0-5 | Pinned Status | Management visibility for Telegram |

### Tier 2 — Makes It Good (ship within weeks of Tier 1)

| # | Requirement | Rationale |
|---|------------|-----------|
| P0-2 | Capability Matching (simplified) | Smart-enough routing without LLM complexity |
| P0-4 | Last-Result Context Carry (simplified) | Basic continuity, not full context assembly |
| P0-7 | Task Queue (simplified) | Handle busy agents gracefully |
| P0-8 | Manual Retry | Failure recovery with user control |

### Tier 3 — Makes It Complete (v2.x)

| # | Requirement | Rationale |
|---|------------|-----------|
| P1-1 | Task History | Useful after enough tasks accumulate |
| P1-2 | Telegram Topics | Parallel task organization |
| P1-3 | File/Artifact Handling | Needed for real workflows |
| P1-4 | Health Monitoring | Worker observability |

### Cut from v2 entirely

| # | Requirement | Reason |
|---|------------|--------|
| P0-6 | Task Decomposition | 41-86% failure rate. Prove single-agent first. |
| P1-5 | Agent-to-Agent Delegation | Same risk as decomposition. V3+ at earliest. |
| P1-6 | Telegram Mini App | No evidence of need. Defer to v2.1 if data warrants. |
| | LLM-based routing | Adds failure modes, latency, cost. Rules-based is enough for v2. |
| | Auto-retry | Cascading failure risk. Manual retry is safer. |

---

## The Niche (Refined)

**Before research:** "Personal Agent Control Plane"
**After research:** "Personal MCP Bridge for Distributed Agents"

**One-line pitch:** AnyAgent makes every agent on every machine you own available as an MCP tool — managed from Telegram.

**Why this niche:**
- Claude Code Remote does "remote agent access" better — don't compete
- Manus does "AI agent via Telegram" better — don't compete
- AgentGateway does "enterprise MCP proxy" better — don't compete
- NOBODY does "personal, self-hosted, multi-machine MCP tool federation" simply

**The user:**
A developer with Claude Code on their laptop, a local LLM on their Linux box, and custom scripts on a VPS. They want Claude Code to be able to call any of those as MCP tools. They don't want to set up AgentGateway with RBAC and Cedar policies. They want to run `anyagent-worker` on each machine, approve it in Telegram, and have their agents appear as MCP tools everywhere.

**Why Telegram:**
Telegram is the management layer, not the execution layer. You pair workers, approve tasks, get alerts, check history — via Telegram. But the actual WORK flows through MCP, where it composes with Claude Code, Cursor, and the broader AI ecosystem.

This inversion — Telegram for management, MCP for execution — solves the Telegram rate limit problem (management messages are infrequent) and puts AnyAgent where the market is going (MCP is the standard).

---

## Sources

- [Self-Hosting AI in 2026](https://dev.to/kevinzy189/self-hosting-ai-in-2026-privacy-control-and-the-case-for-running-your-own-59ek)
- [Personal AI Agents in 2026: Complete Landscape](https://rywalker.com/openclaw-alternatives-2026)
- [MCP Gateway: Best Options 2026](https://toolradar.com/blog/mcp-gateway)
- [AgentGateway — Linux Foundation](https://agentgateway.dev/)
- [IBM ContextForge](https://ibm.github.io/mcp-context-forge/)
- [Beyond SSH: WebSocket for AI Coding Agents](https://clauderc.com/blog/2026-02-28-beyond-ssh-websocket-for-ai-coding/)
- [Claude Code Remote Control Guide](https://claudefa.st/blog/guide/development/remote-control-guide)
- [Claude Code Agent Teams](https://claudefa.st/blog/guide/agents/agent-teams)
- [Long-Running AI Agents and Task Decomposition](https://zylos.ai/research/2026-01-16-long-running-ai-agents)
- [Why Multi-Agent LLM Systems Fail](https://futureagi.substack.com/p/why-do-multi-agent-llm-systems-fail)
- [Multi-Agent System Reliability](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/)
- [The Multi-Agent Trap](https://towardsdatascience.com/the-multi-agent-trap/)
- [What ICLR 2026 Taught About Multi-Agent Failures](https://llmsresearch.substack.com/p/what-iclr-2026-taught-us-about-multi)
- [Personal AI Agent Usage 2026 Survey](https://brainroad.com/how-people-actually-use-personal-ai-agents-in-2026/)
- [PwC AI Agent Survey](https://www.pwc.com/us/en/tech-effect/ai-analytics/ai-agent-survey.html)
- [What People Actually Want from AI (2026 Report)](https://shift.com/blog/what-do-people-actually-want-from-ai-the-2026-ai-insights-report-is-here/)
- [Telegram Bot Rate Limits](https://grammy.dev/advanced/flood)
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq)
- [Manus Agents for Telegram](https://manus.im/blog/manus-agents-telegram)
- [Cloudflare Moltworker](https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/)
- [AI Agent Scaling Gap 2026](https://www.digitalapplied.com/blog/ai-agent-scaling-gap-march-2026-pilot-to-production)
- [150+ AI Agent Statistics 2026](https://masterofcode.com/blog/ai-agent-statistics)
