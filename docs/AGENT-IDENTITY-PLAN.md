# Agent Identity & Multi-Machine Naming — Plan

**Status:** ✅ Shipped on `main` (all 5 phases)
**Date:** 2026-04-23
**Target:** v2.1

---

## Problem

Today, when multiple workers declare an agent called `claude`, the user can't tell them apart:

- **Telegram `/agents`** — shows a flat list of names ([bot.ts:438](../hub/src/bot.ts#L438) builds the button label without `node_id`).
- **MCP `anyagent_list_agents`** — returns `"🟢 claude — Claude Code on Spot"` with no node info ([mcp.ts:91](../hub/src/mcp.ts#L91)).
- **MCP tool registry** — registers one `anyagent_<name>` per row; the loop has no dedup, so the second worker's registration silently overwrites the first ([mcp.ts:145-160](../hub/src/mcp.ts#L145)).
- **Routing (`getAgentByName`)** — `SELECT * FROM agents WHERE name = ?` with no `ORDER BY` → undefined which node gets picked ([db.ts:192](../hub/src/db.ts#L192)).
- **No collision warning** — second worker's identical declaration succeeds silently ([gateway.ts:583-588](../hub/src/gateway.ts#L583)).

Simultaneously: `add-worker.sh` only declares ONE agent per install (even when `claude`, `codex`, `ollama`, `bash`, `python3` are all on PATH) — everything beyond the first is a manual `worker/.env` edit. Local LLMs (ollama / gemma) have no first-class story.

**The DB is already correct:** [db.ts:88-89](../hub/src/db.ts#L88) migrates the `agents` index to `(name, node_id)` unique. The fix is everywhere the code reads or displays agents — not the schema.

---

## Goals

1. **Identify the machine** for every agent visible in Telegram, CLI, and MCP outputs.
2. **Address a specific machine's agent** from an MCP client without guessing.
3. **Install multiple agents per machine** in one pass — including several ollama models as separate agents.
4. **Preserve the short form** — `anyagent_claude` still works for the common case (only one machine has it, or the user doesn't care which).

## Non-goals

- LLM-based disambiguation ("which claude did you mean?"). Use deterministic rules.
- Load balancing across machines — pick one deterministically; load-aware routing is v3.
- Per-user agent access control. Keep `ALLOWED_USER_ID` scope for now.

---

## Design decisions

### 1. Node alias as the display handle

Workers already send `WORKER_NAME` (e.g. `Spot.local`). We'll derive a **node_alias** = lowercased, stripped suffix (`.local`), non-alphanum → `_`. `Spot.local` → `spot`. Store it on `nodes.alias` (new column, nullable, backfilled from `name`).

The display handle users see everywhere is `<agent_name>@<node_alias>` — e.g. `claude@spot`, `codex@beacon`, `ollama-llama3.1@spot`.

### 2. MCP tools: short form + explicit form, both registered

For every `(name, node_alias)` pair register **two** tools:

```
anyagent_<name>                      # short form, hub picks
anyagent_<name>_<node_alias>         # explicit, addresses ONE node
```

With 2 Macs × 2 CLIs = 4 explicit + 2 short = 6 MCP tools total. Scales fine to personal-scale (5 machines × 5 agents = 30 tools, still under MCP practical limits).

Short-form picking rule (deterministic):
1. If chat has a `default_agent` matching on name+node → use it
2. Else: online agents first, then `ORDER BY created_at ASC` (oldest pairing wins — stable)
3. Log the decision: `[router] anyagent_claude → claude@spot (node_b033c0f0)`

### 3. `anyagent_list_agents` output: grouped by node

```
🟢 spot (Guilherme primary Mac)
   🟢 claude         [coding, refactoring, testing, shell]
   🟢 codex          [coding, review, refactoring]
   🟢 ollama-gemma2  [llm, chat, local]
🟢 beacon (Guilherme travel Mac)
   🟢 claude         [coding, refactoring, testing, shell]
   🟢 codex          [coding, review, refactoring]

Call short form (hub picks): anyagent_claude
Call specific node:          anyagent_claude_spot
```

### 4. Telegram `/agents` grouped view

Same grouping. Button labels: `🟢 claude@spot`, `🟢 codex@beacon`. Tapping a button still starts a session with that exact agent on that exact node. Add `/nodes` as a shortcut to list just the machines.

### 5. Collision warning on declare

In `gateway.ts` during `declare`, log a warning when a declared agent name already exists on *another* online node — not an error, just surface the fact:

```
[gateway] Node <this> declared "claude" — also present on node_<other>.
           MCP will expose anyagent_claude_<this> and anyagent_claude_<other>.
```

Non-blocking. Users who intend the collision (multiple identical Macs as a fleet) see it's working.

### 6. Multiple agents per `add-worker.sh` install

Replace single-binary prompt with a multi-select. Non-interactive: read comma-separated list from env.

**Interactive flow (new):**
```
Detected AI CLIs on PATH:
  1) claude   (at /.../claude)            [coding, refactoring, testing, shell]
  2) codex    (at /.../codex)             [coding, review, refactoring]
  3) ollama   (at /opt/homebrew/bin/ollama)
     Local models:
       a) llama3.1:8b   (4.7 GB, downloaded)
       b) gemma2:9b     (5.4 GB, downloaded)
       c) qwen2.5:7b    (4.4 GB, downloaded)
  4) aider    (at /opt/homebrew/bin/aider)

Pick agents to expose [1,2,3a,3b, Enter for all]:
```

**Non-interactive:** `AGENT_BINARIES="claude,codex,ollama:llama3.1,ollama:gemma2"` → declares four agents. The `ollama:<model>` syntax tells `add-worker.sh` to use `args_preset_ollama <model>` which produces `["run", "<model>"]`.

### 7. Local LLMs as first-class

Add ollama to `args_preset()` with model-aware form:
```bash
args_preset_ollama() { echo '"run","'"$1"'"'; }   # ["run","<model>"]
```

Agent name: `ollama-<model-sanitized>` — e.g. `llama3.1:8b` → `ollama-llama3_1_8b`. Capability preset: `[llm, chat, local, <model>]`.

Pre-flight check: verify `ollama list` succeeds (server running). If not, doctor emits a warning with `ollama serve` as the suggested fix.

### 8. Routing metadata returned in the response

When the hub dispatches via short form, include the resolved node in the MCP response's `task_id` payload so the user knows where it ran. Today's "Task completed" turns into "Task completed on spot." Low effort, high signal.

---

## Implementation phases

Each phase ships independently and is reversible.

### Phase 1 — Visibility (~1 day)

No new routing, no schema changes. Just show node info where the user looks.

- [x] `db.ts`: add `alias` column to `nodes`; auto-derive from `name` on insert; SELECT returns it
- [x] `manager.ts`: `getAgentList()` already returns `nodeId` — add `nodeAlias`
- [x] `mcp.ts`: `anyagent_list_agents` output grouped by node, uses alias
- [x] `bot.ts`: `/agents` groups by node; button labels `name@alias`
- [x] `cli.ts`: `agents` command grouped too
- [x] TROUBLESHOOTING anchor `agents-same-name` explaining the new display

**Exit criterion:** user can tell which machine every agent is on, everywhere.

### Phase 2 — Explicit addressing (~1 day)

- [x] `mcp.ts`: register both `anyagent_<name>` and `anyagent_<name>_<alias>`
- [x] Short-form tool handler uses new deterministic picker (online → created_at)
- [x] Log every routing decision at `info` level
- [x] Update `anyagent_list_agents` output footer to show both tool forms

**Exit criterion:** `anyagent_claude_spot` and `anyagent_claude_beacon` both callable; short form logs its pick.

### Phase 3 — Installer multi-agent (~1-2 days)

- [x] `add-worker.sh`: multi-select UI; `AGENT_BINARIES` env for non-interactive
- [x] `args_preset` table gains ollama row
- [x] `ollama:<model>` syntax in AGENT_BINARIES
- [x] `worker/dist/doctor` (existing) gains ollama server check
- [x] Update `docs/SETUP-WITH-AI.md` W section to reflect multi-agent flow

**Exit criterion:** one `./add-worker.sh --non-interactive --agents claude,codex,ollama:gemma2` run produces three live agents.

### Phase 4 — Telegram UX (~half day)

- [x] `/nodes` command — list machines, online/offline, with inline buttons to `/agents <node>`
- [x] Pinned status message includes node count + per-node agent count
- [x] `/call <name>` accepts `name@alias` syntax

**Exit criterion:** same visibility in Telegram as in the MCP list.

### Phase 5 — Polish (~half day)

- [x] Collision warning log on `declare` when name already online elsewhere
- [x] Task response includes resolved node
- [x] Re-run installer on second Mac to validate the multi-agent + ollama path
- [x] Update `docs/PRD-v2-agent-control-plane.md` to reflect shipped design

---

## Migration notes

- **DB:** add `nodes.alias` column nullable; write a one-time migration that backfills from `nodes.name`. Zero downtime.
- **Existing workers:** keep working without change. Short-form MCP tool names (`anyagent_claude`) stay valid — they just gain siblings.
- **MCP clients:** need to re-list tools (Claude Code does this on session start). No reconfiguration.
- **Old `worker/.env` files:** still valid. Users can add more agents manually or re-run `./add-worker.sh --reconfigure` (new flag).

## Open questions

1. **Alias collisions** — two machines named "Spot"? Proposal: on declare, if alias clashes with a *different* online node, append `-2`. Persisted on `nodes.alias`.
2. **Privacy of hostnames** — `Spot.local` leaks the Mac's name into MCP responses. Make `--worker-name` explicit in install flow so users can pick a neutral alias.
3. **Capability-based short-form** — should `anyagent_route` with `intent="refactor this"` pick by capability across *all* nodes, or prefer one node? Current answer: it already picks by capability; ambiguity resolution follows §2 rules.
4. **Hot reconfigure** — today adding an agent requires editing `worker/.env` and restarting. Add `/reconfigure` RPC? Low priority.

---

## Not in this plan

- Multi-user / per-user agents → `docs/PRD-v2-agent-control-plane.md` P2-2
- A2A protocol compatibility → PRD P2-1
- Load-aware routing → v3
- LLM-based intent routing → PRD P2-4
