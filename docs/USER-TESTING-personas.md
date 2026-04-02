# AnyAgent v2 — User Persona Testing

## Date: 2026-04-02

Five technical personas evaluate AnyAgent from their perspective. Each has different needs, infrastructure, and expectations. Feedback is raw and honest.

---

## Persona 1: Marcus — The Solo Indie Hacker

**Background:** Full-stack dev, solo founder of a SaaS product. Runs Claude Code on his MacBook for daily coding. Has a $20/mo Hetzner VPS for staging. Ships code 7 days a week.

**Machines:** MacBook Pro (primary), Hetzner VPS (staging/CI)

**What he wants:** "I'm constantly SSH-ing into my VPS to run Claude Code there for heavy refactors so my laptop stays responsive. I want Claude Code on my laptop to just... call the VPS agent when I need GPU-level work."

### Marcus's Setup Attempt

> I read the README, cloned the repo. Creating the Telegram bot was easy — I already had one from a monitoring project. Hub setup took 3 minutes. Nice.
>
> Worker setup on the VPS — this is where it got annoying. I generated the pair code, but then I had to SSH into my VPS (the thing I'm trying to avoid), edit .env, install deps, build, start. The pair code expired while I was fixing a Node version issue. Had to `/pair` again.
>
> **Question: Why can't the worker be a single binary I just download and run with one flag?** `curl ... | bash` or a Docker one-liner. Having to clone a repo, npm install, npm build on every machine defeats the purpose.

### Marcus's Usage Feedback

> MCP integration is the killer feature. I added AnyAgent to my Claude Code `.mcp.json` and suddenly my VPS agent appeared as `anyagent_claude_vps`. Claude Code on my laptop can now offload tasks to the VPS. This is what I wanted.
>
> But the MCP tool calls are async — Claude Code calls `anyagent_route`, gets back "Task started, poll with anyagent_task_status." Then it has to poll. This is **ugly**. Claude Code calls task_status 5 times before the task finishes. My conversation fills up with polling tool calls. I wish the tool call could just block until done, at least for short tasks.

### Marcus's Verdict

> **7/10. The MCP bridge concept is genuinely useful — nobody else does this.** But the worker setup is too heavy for what it is. I need a Docker image or a curl-to-run binary. And MCP polling is clunky — needs a blocking mode for short tasks.

### Key Issues Identified
- No Docker image or single-binary distribution for workers
- MCP tool calls are always async; no blocking mode for short tasks
- Pair code expiry (10 min) too short for remote machine setup
- No `curl | bash` installer for workers

---

## Persona 2: Priya — The ML Research Engineer

**Background:** PhD student in ML. Runs experiments on a university GPU cluster (4 machines with A100s). Uses local LLMs (Ollama with Llama 3) for code review and a custom Python agent for data pipeline management.

**Machines:** MacBook Air (daily), 4x GPU nodes (shared cluster, SSH access)

**What she wants:** "I want to dispatch training jobs from my phone while commuting. I also want my code review agent on one GPU node to call my data pipeline agent on another node automatically."

### Priya's Setup Attempt

> The Worker SDK is TypeScript-only. My agents are Python scripts. I had to write a Node.js wrapper around my Python agent just to use AnyAgent. **This is a dealbreaker for half my use case.**
>
> For Ollama, I declared it as a binary agent (`binary: "ollama"`, `args: ["run", "llama3"]`), which sort of works — it spawns the Ollama CLI and I can chat via Telegram. But Ollama's output includes ANSI spinners that look ugly even after stripping.
>
> On the GPU cluster, I can't run long-lived processes — SLURM kills anything not submitted as a job. AnyAgent assumes the worker stays running forever (reconnect loop). Doesn't fit.

### Priya's Usage Feedback

> The capability routing is surprisingly useful. I declared one agent with `["ml", "training", "pytorch"]` and another with `["data", "pipeline", "etl"]`. When I type "run the training job on the new dataset" from Telegram, it correctly routes to the training agent. Impressive for keyword matching.
>
> Context carry is nice in theory but doesn't work for my workflows. My tasks produce large outputs (training logs, metrics). The 500-char context truncation means the next task gets "Epoch 24/100, loss: 0.0032, acc: 0.987..." which is useless context. I'd rather have no context than truncated garbage.
>
> **The biggest miss: no agent-to-agent communication.** My code review agent finds a bug → I want it to tell the data pipeline agent to re-run. Currently I have to manually copy the result and paste it as a new task. The PRD says this was cut for v2 due to "41-86% failure rate" research. I get it. But for my use case it's THE feature.

### Priya's Verdict

> **4/10 for me specifically. 6/10 for the TypeScript/Node.js crowd.** The Python SDK gap makes it a non-starter for the ML community. The MCP bridge is cool but I can't use it because my agents aren't Node.js. The Telegram management is genuinely nice for mobile dispatching — that part works.

### Key Issues Identified
- No Python Worker SDK — TypeScript only
- Context carry's 500-char limit produces useless truncated context
- No agent-to-agent delegation (cut from v2)
- Worker assumes long-lived process — incompatible with job schedulers (SLURM, K8s Jobs)
- ANSI stripping incomplete for animated CLI output (spinners)

---

## Persona 3: Jake — The DevOps Engineer

**Background:** Platform engineer at a 50-person startup. Manages 12 servers. Already uses Telegram bots for alerting (Grafana → Telegram). Comfortable with infrastructure.

**Machines:** MacBook (daily), 3 prod servers, 2 staging, 1 CI runner, home lab (Proxmox)

**What he wants:** "I want to run shell commands on any of my servers from Telegram when I'm on-call. Also want Claude Code to be able to SSH-equivalent into my servers as MCP tools for automated remediation."

### Jake's Setup Attempt

> I loved the Ed25519 pairing flow. As a DevOps person, the fact that workers authenticate with signed challenges and the key pair is auto-saved — chef's kiss. I trusted this immediately.
>
> Setup was smooth because I'm used to deploying Node services. I made a `docker-compose.yml` for my hub in 10 minutes. For workers, I wrote a systemd unit file. **But why isn't this already provided?** Everyone deploying this will need systemd/Docker configs.
>
> **Security review finding:** The `.env.example` still shows `"args":["--dangerously-skip-permissions"]` for Claude. I know the PTY env is sanitized now, but that flag in the example normalizes dangerous practices. New users will copy-paste this without understanding the implications.

### Jake's Usage Feedback

> The pinned status message is perfect for ops. I pin it in my team's monitoring Telegram group and it auto-updates every 30 seconds. Workers going offline shows instantly. This replaces a whole Grafana panel for me.
>
> The task queue is a great concept but **max 3 is too low for ops use.** I sometimes need to run 10 quick commands across servers in a row. I set `MAX_QUEUE_DEPTH=10` which works, but the docs don't explain the trade-offs.
>
> **The WS_SECRET issue:** I spent 30 minutes debugging why my remote workers couldn't connect. Turns out the SDK now sends `WS_SECRET` from the worker's env, but I had only set it on the hub side and forgot to set it on the workers. The error was "connection closed" with no explanation. **Need a clear error message when WS_SECRET mismatch happens.**
>
> MCP is interesting for my use case but incomplete. I want Claude Code to be able to run a command on server X, check the output, then decide whether to run something else on server Y. That's the decomposition feature that was cut. For now I chain tool calls manually in Claude Code, which works but is fragile.

### Jake's Verdict

> **8/10 for Telegram management of remote shells. 5/10 for MCP-driven automation.** The Telegram side is genuinely production-quality for ops. Pinned status, queue, retry — all well-thought-out. The MCP side needs blocking tool calls and better error messages. Provide Docker Compose + systemd examples out of the box.

### Key Issues Identified
- No Docker Compose or systemd examples provided
- `.env.example` normalizes `--dangerously-skip-permissions`
- WS_SECRET mismatch produces silent connection close — needs clear error
- MAX_QUEUE_DEPTH=3 too low for ops use; undocumented trade-offs
- MCP async-only is limiting for sequential remediation workflows

---

## Persona 4: Sofia — The AI Tinkerer / Early Adopter

**Background:** Product designer who codes on the side. Runs Claude Code, GPT-CLI, and a local Stable Diffusion agent. Loves trying new AI tools. Not deeply technical but can follow docs.

**Machines:** iMac (primary), Raspberry Pi (running local LLM), old gaming PC (Stable Diffusion)

**What she wants:** "I want to talk to all my AI agents from one place — Telegram. I don't want to remember which machine has which tool. Just describe what I need and the right thing happens."

### Sofia's Setup Attempt

> The README assumes I know what WebSocket means, what Ed25519 is, what MCP is. I had to Google everything. **There's no "Getting Started for Humans" guide.** The setup process requires editing `.env` files, running npm commands, understanding port forwarding.
>
> I got the hub running on my iMac. Connecting the Raspberry Pi worker took an hour because I didn't realize `ws://localhost:8080` means "this machine" not "the hub machine." The error message when it couldn't connect was just the worker retrying silently every 5 seconds. **I thought it was working. It wasn't.**
>
> Never got the gaming PC connected because it's on a different network and I don't know how to do port forwarding.

### Sofia's Usage Feedback

> Once things were connected, the Telegram experience was great. I set Claude as my default agent and just typed naturally. "Write a blog post about AI agents" — it routed to Claude and started working. The progress edits showing Claude's output in real-time were delightful.
>
> **The `/agents` list with capabilities was confusing.** My Claude agent shows `[coding, refactoring, testing]` but I use it for writing too. The capabilities are static and I declared them at setup — I can't change them without restarting the worker. **Capabilities should be editable from Telegram.**
>
> The retry button saved me multiple times. Agent crashed mid-task → tap Retry → it remembers what I asked. Very nice UX.
>
> **What I desperately wanted but couldn't do:** Send a photo to the Telegram bot and have it routed to my Stable Diffusion agent. The bot ignores non-text messages completely. No voice messages either.

### Sofia's Verdict

> **6/10.** The Telegram UX once running is genuinely nice — best of any AI tool I've used from mobile. But getting TO that point requires DevOps skills I don't have. I need: one-click install, auto-discovery on local network, photo/voice support, and editable capabilities. This product will only work for developers until the setup is dramatically simplified.

### Key Issues Identified
- No beginner-friendly setup guide
- Worker retry loop is silent — no indication that connection failed
- Port forwarding required for cross-network, not documented
- Capabilities are static (requires worker restart to change)
- No photo, voice, or file message support in Telegram
- No way to edit capabilities from Telegram

---

## Persona 5: Daniel — The Privacy-Conscious Power User

**Background:** Security researcher. Runs everything self-hosted. Uses Tailscale for networking. Has Claude Code (air-gapped with API key), local Llama via Ollama, and various custom security tools. Paranoid about data leakage.

**Machines:** ThinkPad (daily), home server (Proxmox VMs), cloud VPS (disposable)

**What he wants:** "I need to orchestrate agents across my Tailscale network without any data touching third-party servers. Telegram is a trade-off I accept for the mobile convenience, but everything else must be self-hosted."

### Daniel's Setup Attempt

> First thing I did was security audit the code. Findings:
>
> The PTY env sanitization is correct — `PRIVATE_KEY_HEX` stripped from child processes. Good.
>
> MCP token uses `timingSafeEqual` now — good.
>
> `.env` written with `mode: 0o600` — good.
>
> Binary allowlist on worker — good.
>
> **But the WebSocket server has no TLS.** The hub creates `new WebSocketServer({ port })` — plain WS, no encryption. On my Tailscale network this is acceptable (WireGuard encrypts everything), but the code should at least support `wss://` natively for people on regular networks. Right now you MUST put a reverse proxy in front for TLS.
>
> Pairing codes are now 128-bit (16 bytes) — solid. The old 24-bit codes were embarrassing.

### Daniel's Usage Feedback

> The privacy model is exactly right for me. All data stays on my machines. SQLite database is local. The only external dependency is the Telegram API, which I accept.
>
> **Concern: task intents are stored in plaintext in SQLite for 30 days.** If I type "connect to production database at postgres://admin:hunter2@prod.internal:5432", that password sits in `hub/data/anyagent.db` for a month. The `cleanOldTasks(30)` is good but I want `/purge` to clear everything immediately.
>
> **The Telegram channel itself is a leakage vector.** Every task intent, every result summary, flows through Telegram's servers. Telegram claims end-to-end encryption in Secret Chats, but bots can't use Secret Chats. So Telegram has access to everything I type to my agents. For truly sensitive work, I need a non-Telegram management interface — but the PRD explicitly says that's a non-goal for v2.
>
> MCP server on my local network is brilliant. Claude Code on my ThinkPad calls agents on my home server via Tailscale. The bearer token auth is minimal but sufficient for a trusted network. I'd want mTLS for production, but for personal use this is fine.

### Daniel's Verdict

> **8/10 for the self-hosted privacy story. 6/10 overall.** This is the most privacy-respecting agent orchestration tool I've found. No cloud dependency beyond Telegram. But: add native TLS support to the WebSocket server, add a `/purge` command for task history, and document the Telegram-as-leakage-vector trade-off honestly. The MCP bridge over Tailscale is genuinely the use case nobody else serves.

### Key Issues Identified
- No native TLS/wss:// support — requires reverse proxy
- Task intents stored 30 days in plaintext SQLite — needs `/purge` command
- Telegram bot API doesn't support end-to-end encryption — all data visible to Telegram
- No documentation about the Telegram privacy trade-off
- Would benefit from optional non-Telegram interface for sensitive work

---

## Cross-Persona Issue Frequency

| Issue | Marcus | Priya | Jake | Sofia | Daniel | Count |
|-------|--------|-------|------|-------|--------|-------|
| No Docker/binary distribution | ✓ | | ✓ | ✓ | | 3 |
| No Python SDK | | ✓ | | | | 1 |
| MCP async-only (no blocking) | ✓ | | ✓ | | | 2 |
| Worker setup too heavy | ✓ | | | ✓ | | 2 |
| No beginner docs | | | | ✓ | | 1 |
| No photo/voice/file support | | | | ✓ | | 1 |
| No agent-to-agent | | ✓ | ✓ | | | 2 |
| WS_SECRET mismatch silent | | | ✓ | | | 1 |
| No native TLS | | | | | ✓ | 1 |
| No /purge for task history | | | | | ✓ | 1 |
| Context carry truncation useless | | ✓ | | | | 1 |
| Capabilities not editable from Telegram | | | | ✓ | | 1 |
| .env.example normalizes dangerous flags | | | ✓ | | | 1 |
| Pair code expiry too short | ✓ | | | | | 1 |

## Top 5 Improvements by Impact (Across All Personas)

1. **Docker image / single-binary worker** — 3 personas blocked or frustrated by worker setup. A `docker run anyagent-worker --hub ws://... --pair-code ABC` would eliminate the biggest friction point.

2. **MCP blocking mode for short tasks** — 2 personas need this. The poll-loop pattern fills up Claude Code conversations with noise. Add a `timeout` parameter: if task completes within N seconds, return result inline.

3. **Python Worker SDK** — 1 persona blocked, but represents the entire ML/data science community. Python is where agents live.

4. **Better error messages** — Silent retry loops (Sofia), silent WS_SECRET mismatches (Jake), generic "connection closed" errors affect every persona's first experience.

5. **`/purge` command + Telegram privacy docs** — Security-conscious users (Daniel's persona) need to manage data retention and understand the trust model.

## Would It Make Their Lives Easier?

| Persona | Current Impact | With Top 5 Fixes |
|---------|---------------|-------------------|
| **Marcus** (Indie Hacker) | Yes — MCP bridge saves him SSH-ing daily | Significantly yes — Docker worker + blocking MCP |
| **Priya** (ML Researcher) | No — Python gap is a blocker | Maybe — Python SDK would unlock her |
| **Jake** (DevOps) | Yes — Telegram ops management is real value | Strong yes — Docker + better errors |
| **Sofia** (AI Tinkerer) | Partially — great once running, painful to set up | Yes — Docker + beginner docs |
| **Daniel** (Privacy User) | Yes — only self-hosted option in this space | Strong yes — /purge + TLS docs |

**Net assessment: AnyAgent makes life easier for 3 out of 5 personas today, and could reach 5/5 with Docker distribution + Python SDK + MCP blocking mode.**
