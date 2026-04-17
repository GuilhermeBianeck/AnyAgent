# Reliability & UX Improvement Plan

Addresses the six weak points surfaced in the "is it noise or not" audit:

1. Local / self-hosted — already strong, small polish
2. How it calls AI models (Claude CLI, Codex, Ollama) — discoverability gap
3. Cross-machine setup — workable, but friction
4. Always-online guarantees — **biggest gap**
5. Setup difficulty — prerequisites, error UX
6. Heartbeat / presence — works, needs observability

Each item lists: **problem**, **target**, **concrete work**, **files**, **effort**, **priority**.

Priority scale: **P0** = blocks adoption, **P1** = high friction, **P2** = polish.
Effort scale: **S** = <1 day, **M** = 1–3 days, **L** = 3–7 days.

---

## 1. Local / self-hosted — prove it

**Problem.** Users have to take our word that nothing leaks. "Zero outbound calls" is in the README but not verifiable at runtime.

**Target.** A user can run one command and see every outbound connection the process opens. A privacy-conscious user can run in a fully air-gapped mode with confidence.

**Work:**

- [ ] `hub/src/netlog.ts` — optional outbound-connection logger. Gated on `AUDIT_NETWORK=1`. Wraps `ws`, `http`, `https`, `dgram` to log every remote address (not payload) to `hub/data/network.log`.
- [ ] CLI command `net` — prints the last 50 outbound connections with timestamp, host, port, reason ("telegram-poll", "none if BOT_TOKEN unset").
- [ ] `AIRGAP=1` env flag — hard-fails if BOT_TOKEN is set, refuses to dial anything outside `WS_PORT`/`MCP_PORT` loopback. Useful for regulated environments.
- [ ] Docs: `docs/PRIVACY.md` gains a "verify it yourself" section with `lsof -i -p <pid>` and `tcpdump` one-liners.

**Files:** new `hub/src/netlog.ts`, edits to `hub/src/index.ts`, `hub/src/cli.ts`, `docs/PRIVACY.md`.
**Effort:** M. **Priority:** P2.

---

## 2. How it calls AI models — discoverability

**Problem.** New users don't know that AnyAgent spawns the *CLI*, not the API. They ask "where do I put my Anthropic API key" (nowhere — the Claude CLI handles its own auth). Declaring `WORKER_AGENTS` JSON is also the friction point of setup.

**Target.** `add-worker.sh` detects installed CLIs and offers them. Users never hand-write JSON.

**Work:**

- [ ] Add `detect_binaries()` to `add-worker.sh` — `command -v` probe for `claude`, `codex`, `ollama`, `aider`, `gemini`, `gh copilot`, `bash`, `python3`. Present a checklist: `[x] claude (found at /usr/local/bin/claude)`.
- [ ] Each detected binary gets a preset capability list (e.g., `claude` → `coding,refactoring,testing`). User can override.
- [ ] After declaring an agent, run a 2-second health check: `<binary> --version` (with timeout). If it fails, warn "binary not on PATH — worker will error at spawn time."
- [ ] `worker --doctor` subcommand — enumerates declared agents, checks each binary is on PATH, prints OAuth status hint ("run `claude /login` if not authenticated").
- [ ] README: add explicit "AnyAgent does not handle model API keys — each CLI authenticates itself" callout in the Quick Start.

**Files:** `add-worker.sh`, `worker/src/index.ts` (add `--doctor`), `README.md`.
**Effort:** M. **Priority:** P1.

---

## 3. Cross-machine setup — reduce friction

**Problem.** The hub URL defaults to `ws://localhost:8080`, which is wrong for every real deployment. Users have to know their hub's LAN IP, open a firewall port, and paste a pair code within 10 minutes.

**Target.** The worker can find the hub on the LAN without typing an IP. Firewall guidance is in-band.

**Work:**

- [ ] **mDNS broadcast** from hub: `anyagent._ws._tcp.local`. `hub/src/mdns.ts` using `bonjour-service`. Broadcasts hub name + port on the LAN.
- [ ] **mDNS discovery** in `add-worker.sh`: if no `HUB_URL` typed, scan for 3 seconds and list found hubs. User picks one.
- [ ] **Firewall hint** in `setup.sh`: print OS-specific commands (`sudo ufw allow 8080/tcp`, `sudo firewall-cmd --add-port=8080/tcp`, macOS System Settings instructions).
- [ ] **Pair code lifetime**: 10 minutes is fine, but show a live countdown in the hub CLI and extend on demand (`pair --extend`).
- [ ] **QR code option**: `pair --qr` prints a QR of `ws://ip:port#CODE`. Worker `add-worker.sh --qr` accepts a pasted string. Phones / clipboards only, still fully offline.
- [ ] Docs: new `docs/NETWORKING.md` covering LAN / VPN / Tailscale / reverse-proxy / public-domain patterns with TLS.

**Files:** new `hub/src/mdns.ts`, edits to `setup.sh`, `add-worker.sh`, `hub/src/cli.ts`, new `docs/NETWORKING.md`.
**Effort:** L. **Priority:** P1.

---

## 4. Always-online — the biggest gap

**Problem.** The hub process has no supervisor. A crash = down until someone sshes in. Worker reconnects if hub flaps but also has no self-supervisor. "Always online" is currently delegated to the user's OS skills.

**Target.** A fresh install on any common OS results in both processes surviving reboots, crashes, and OOMs. Health is observable.

### 4a. Ship real process-manager integration

- [ ] `packaging/systemd/anyagent-hub.service` — unit file with `Restart=always`, `RestartSec=5`, `LimitNOFILE=65536`, `WorkingDirectory`, user/group, env-file reference.
- [ ] `packaging/systemd/anyagent-worker.service` — same for worker.
- [ ] `packaging/launchd/com.anyagent.hub.plist` — macOS LaunchAgent with `KeepAlive`, stdout/stderr paths.
- [ ] `packaging/launchd/com.anyagent.worker.plist`.
- [ ] `setup.sh` / `add-worker.sh` — final step: "Install as a service? [y/N]". If yes, detect `systemctl` vs `launchctl` and install the right unit. Prompts for password only if needed.
- [ ] `packaging/install-service.sh` and `packaging/uninstall-service.sh` — idempotent.

### 4b. Health & self-check

- [ ] `GET /health` on the MCP server — returns JSON `{ok, uptime_s, workers_online, last_heartbeat_ms, build}`. No auth required (it's just liveness).
- [ ] `GET /ready` — returns 200 only if at least one worker is online OR explicitly in "allow empty" mode. Used by orchestrators.
- [ ] CLI `status` gains: "Hub uptime: 3d 4h. Memory: 48MB RSS. Workers online: 2/3. Last crash: none."
- [ ] Hub logs to `hub/data/hub.log` with rotation (10MB × 5 files) via `pino` or a 30-line hand-rolled rotator.

### 4c. Worker self-supervision

- [ ] The worker process currently loses its PTY children on its own crash. Add a one-line `process.on('uncaughtException', …)` → log + exit(1). Trust the service manager to restart.
- [ ] **Task persistence on hub**: if the hub restarts mid-task, the task row stays `running` forever. Add a startup sweep: any task `running` with no active session → mark `failed` with reason `hub_restarted`.
- [ ] **Worker queue persistence**: queued tasks are already in SQLite, but the active session is in memory. On hub start, re-offer queued tasks to reconnecting workers.

### 4d. Observability

- [ ] Prometheus `/metrics` endpoint (optional, `ENABLE_METRICS=1`). Counters: `anyagent_tasks_total{status}`, `anyagent_worker_reconnects_total`, gauges: `anyagent_workers_online`, histogram: `anyagent_task_duration_seconds`.
- [ ] Docs: `docs/OPERATIONS.md` with "how to deploy for 99.9%" — systemd + metrics + log rotation + backup the SQLite file.

**Files:** new `packaging/` tree, new `hub/src/health.ts`, `hub/src/metrics.ts`, edits to `hub/src/mcp.ts`, `hub/src/index.ts`, `hub/src/db.ts`, `worker/src/index.ts`, new `docs/OPERATIONS.md`.
**Effort:** L (~1 week). **Priority:** **P0** — this is the single biggest credibility gap.

---

## 5. Setup difficulty — prerequisites & error UX

**Problem.** First-run failures are native-module build failures (`better-sqlite3`, `node-pty` need python3 + make + g++). The scripts detect the missing tools but don't offer to install them. Setup also bails on the first error with no rollback.

**Target.** A clean Ubuntu/macOS box with nothing but Node.js gets through setup without SSH-ing docs.

**Work:**

- [ ] `setup.sh` — on missing build tools, offer to run the install command (`xcode-select --install`, `sudo apt install -y python3 build-essential`) with user confirmation. Don't just print and exit.
- [ ] Detect Node < 18 and offer to guide the user through `nvm install 20` instead of failing.
- [ ] `--non-interactive` flag for both scripts → reads from env vars, no prompts. Needed for automation/CI.
- [ ] `--verify` flag — after install, spawn the hub / worker for 5 seconds, confirm it binds the port and exits cleanly. Catches "build succeeded but node-pty is broken" silently.
- [ ] Better error UX: every `exit 1` in the scripts prints a one-line "if this is wrong, see docs/TROUBLESHOOTING.md#<anchor>".
- [ ] `docs/TROUBLESHOOTING.md` — top-10 failures with copy-paste fixes. Seed it with: native build failure, firewall blocking 8080, pair code expired, binary not on PATH, CLI not authenticated, port already in use.
- [ ] One-command remote install (optional, security-sensitive): `curl -fsSL anyagent.dev/install | bash` → pinned checksum, prints what it will do, requires confirmation. Not a priority until a domain exists, but structure the scripts so it's trivial later.

**Files:** `setup.sh`, `add-worker.sh`, new `docs/TROUBLESHOOTING.md`.
**Effort:** M. **Priority:** P1.

---

## 6. Heartbeat / presence — observability

**Problem.** Heartbeat works (30s ping/pong + 60s grace), but it's invisible to operators. When a worker flaps, the only signal is a task silently failing.

**Target.** Operators see worker state changes in real time. Flapping workers are flagged before users hit them.

**Work:**

- [ ] Emit an event log on every worker state transition: `worker.online`, `worker.offline`, `worker.heartbeat_miss`, `worker.auth_fail`. Written to `hub/data/events.log` as JSON lines.
- [ ] CLI `workers --watch` — tail of the above, pretty-printed.
- [ ] Telegram push: already notifies on pairing requests; extend to `worker went offline > 5 min` (rate-limited, one notification per flap not per ping).
- [ ] Flap detection: if a worker reconnects 3+ times in 10 min, log `worker.flapping` and suggest `revoke` + re-pair in the CLI.
- [ ] **Adjustable heartbeat** — `HEARTBEAT_INTERVAL_MS` env var. 30s is fine for LAN, too slow for flaky WAN links, too fast for battery-powered laptops. Default stays 30s.
- [ ] Status bar on the CLI prompt: `anyagent (3↑ 0↓)>` — green number online, red number offline.

**Files:** `hub/src/gateway.ts`, `hub/src/cli.ts`, `hub/src/bot.ts`, new `hub/src/events.ts`.
**Effort:** M. **Priority:** P2.

---

## Sequencing

Do them in this order:

**Milestone 1 — "Survives production" (P0)** → item 4 in full. Until this lands, everything else is polish on a process that might not be running.

**Milestone 2 — "Easy to set up" (P1)** → items 2, 3, 5. Each reduces first-run abandonment.

**Milestone 3 — "Easy to operate" (P2)** → items 1, 6. Observability and air-gap polish for mature users.

Rough total effort: 3–4 weeks of focused work. Milestone 1 alone is ~1 week and gives the biggest credibility jump — a hobby project becomes something a team is willing to run.

## Out of scope

Deliberately not in this plan:

- Multi-hub federation (let multiple hubs share workers). Interesting, but no validated demand and large architectural change.
- Built-in model API wrapper (bypass the CLIs, call Anthropic/OpenAI directly). Violates the "local router, zero lock-in" positioning.
- Web UI. CLI + Telegram covers both personas. A web UI is a support surface we don't want yet.
- Hot worker-code updates. OS-level process managers handle restart-on-deploy better than we would.
