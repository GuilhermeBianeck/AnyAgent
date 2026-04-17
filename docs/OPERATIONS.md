# Operations

How to run AnyAgent so it stays up across reboots, crashes, and network flaps.

---

## Keep the hub running

### Linux (systemd)

```bash
./packaging/install-service.sh hub
```

Installs `/etc/systemd/system/anyagent-hub.service` with `Restart=always`,
enables it, and starts it. Idempotent — re-run to update.

```bash
systemctl status anyagent-hub          # state
journalctl -u anyagent-hub -f          # logs
sudo systemctl restart anyagent-hub    # reload env / new build
sudo systemctl stop anyagent-hub       # halt
./packaging/uninstall-service.sh hub   # remove
```

The unit runs as the user who installed it, reads `hub/.env`, and is sandboxed with
`ProtectSystem=strict` + `NoNewPrivileges=true`. Writable paths are limited to
`hub/data/` (SQLite) and `hub/logs/` (rotating log + events log).

### macOS (launchd)

```bash
./packaging/install-service.sh hub
```

Installs `~/Library/LaunchAgents/com.anyagent.hub.plist` with `KeepAlive`. Logs
land in `hub/logs/hub.out.log` + `hub/logs/hub.err.log`.

```bash
launchctl list | grep anyagent         # state
tail -f hub/logs/hub.out.log           # logs
launchctl unload ~/Library/LaunchAgents/com.anyagent.hub.plist   # stop
```

### Docker

`docker-compose.yml` already sets `restart: unless-stopped`. No extra work.

---

## Keep the worker running

Same commands, swap `hub` for `worker`:

```bash
./packaging/install-service.sh worker
./packaging/uninstall-service.sh worker
```

Before first start, run the self-check:

```bash
cd worker && npm run doctor
```

Catches: `.env` missing, credentials absent, hub hostname unresolvable,
declared binaries not on PATH, WS_SECRET missing.

---

## Health endpoints

The MCP HTTP server exposes three unauthenticated endpoints for supervisors:

| Path | Status | Meaning |
|------|--------|---------|
| `GET /health` | `200` | Hub is alive. Returns version, uptime, worker count. |
| `GET /ready` | `200` or `503` | `200` only if at least one worker is online (override with `READY_ALLOW_EMPTY=1`) |
| `GET /metrics` | `200` or `404` | Prometheus text format. `404` unless `ENABLE_METRICS=1` is set. |

Example:
```bash
curl -s http://localhost:3000/health | jq
# { "ok": true, "version": "1.0.0", "node": "v20.11.0",
#   "uptime_s": 3421, "workers": { "total": 2, "online": 2 } }
```

Kubernetes liveness/readiness:
```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
  initialDelaySeconds: 10
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
```

---

## Logs

- **Hub log:** `hub/logs/hub.log` — JSON lines, rotated at 10MB × 5 files.
  Mirrors everything sent to `console.log` / `console.warn` / `console.error`.
- **Event log:** `hub/logs/events.log` — JSON lines, worker state transitions
  (`worker.online`, `worker.offline`, `worker.heartbeat_miss`, `worker.flapping`,
  `task.complete`, `task.failed`, `hub.started`). Rotated at 5MB × 3 files.
- **Network audit:** `hub/logs/network.log` — outbound connections when
  `AUDIT_NETWORK=1`. Use this if you need proof that the hub talks only to
  Telegram (or nothing at all with `AIRGAP=1`).

Tail live events from the CLI:
```
anyagent> events watch
```

---

## Environment flags

| Variable | Default | Effect |
|----------|---------|--------|
| `HEARTBEAT_INTERVAL_MS` | `30000` | Ping workers this often. Clamped to [5s, 5min]. |
| `SESSION_TIMEOUT_MS` | `1800000` | Idle session timeout (30 min). |
| `MAX_QUEUE_DEPTH` | `3` | Max tasks queued per worker. |
| `ENABLE_METRICS` | unset | Set `=1` to expose `/metrics`. |
| `READY_ALLOW_EMPTY` | unset | Set `=1` so `/ready` returns 200 with no workers (bootstrap). |
| `AUDIT_NETWORK` | unset | Log every outbound connection to `network.log`. |
| `AIRGAP` | unset | Refuse non-loopback outbound connections. Fails fast if `BOT_TOKEN` is set. |
| `LOG_MAX_BYTES` | `10485760` | Rotation threshold for `hub.log`. |
| `LOG_MAX_FILES` | `5` | How many rotated files to keep. |

---

## Backup

The entire durable state is in `hub/data/anyagent.db`. Back it up with any
SQLite-aware tool:

```bash
# Hot-copy while hub is running (SQLite handles concurrent reads):
sqlite3 hub/data/anyagent.db ".backup '/backups/anyagent-$(date +%F).db'"
```

Contents: nodes (workers), agents, tasks, sessions, default-agent + approval
config. No secrets — `WS_SECRET`/`MCP_TOKEN` live in `hub/.env`, not the DB.

---

## Upgrades

```bash
git pull
(cd sdk && npm ci && npm run build)
(cd hub && npm ci && npm run build)
sudo systemctl restart anyagent-hub    # or launchctl unload/load
```

Running tasks will fail with `error = 'Hub restarted'` on startup. Queued tasks
are preserved and re-dispatched to workers as they reconnect.

---

## Failure modes & recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/ready` returns 503 | No workers connected | Check worker logs, run `npm run doctor` on worker |
| Tasks stuck in `running` after reboot | (fixed in v1.1) | Hub now marks these `failed` with `error='Hub restarted'` on startup |
| Worker keeps reconnecting | Auth failure, WS_SECRET mismatch | `journalctl -u anyagent-worker`; check both `.env` files |
| `worker.flapping` event fires | 3+ reconnects in 10min | Fix network/watchdog; worker-side logs show the cause |
| Hub crashes on start | Bad .env, port already bound | `hub/logs/hub.log` captures the stack trace |
| MCP client gets 401 | Token mismatch | `curl http://HUB:3000/health` works unauthed; check `Authorization: Bearer <MCP_TOKEN>` |

---

## Observability checklist (production)

- [ ] `/health` polled by your monitor every 30s
- [ ] `/ready` used as the LB readiness probe
- [ ] `ENABLE_METRICS=1` + Prometheus scrape on `/metrics`
- [ ] `journalctl`/launchd logs shipped to your log aggregator
- [ ] `hub/data/anyagent.db` backed up daily
- [ ] Alert on `worker.flapping` events in `events.log`
- [ ] Firewall pinned to the necessary ports only (8080 for workers, 3000 for MCP clients)
