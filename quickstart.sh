#!/usr/bin/env bash
set -euo pipefail

# AnyAgent — Quickstart
#
# Zero-prompt single-machine setup:
#   - installs a CLI-only hub
#   - auto-detects an AI CLI on PATH (claude/codex/ollama/aider/gemini)
#   - auto-pairs a worker on 127.0.0.1
#   - wires anyagent into your Claude Code / Cursor config
#
# Use this if you want to try AnyAgent on your laptop with something already
# installed. For cross-machine or Telegram setups, use ./setup.sh + ./add-worker.sh.
#
# Usage:
#   ./quickstart.sh                     Run everything, zero prompts
#   ./quickstart.sh --no-wire           Don't touch MCP client configs
#   ./quickstart.sh --config PATH       Write the MCP entry to this file
#   ./quickstart.sh --binary BIN        Force this binary instead of auto-detect
#   ./quickstart.sh --stop              Stop the quickstart hub + worker

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

HUB_PID_FILE="/tmp/anyagent-quickstart-hub.pid"
WORKER_PID_FILE="/tmp/anyagent-quickstart-worker.pid"
HUB_LOG="$SCRIPT_DIR/hub/logs/quickstart-hub.log"
WORKER_LOG="$SCRIPT_DIR/worker/logs/quickstart-worker.log"

WIRE_MCP=1
FORCED_BINARY=""
MCP_CONFIG_PATH=""
DO_STOP=0

for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  case "$arg" in
    --no-wire)     WIRE_MCP=0 ;;
    --binary)      i=$((i+1)); FORCED_BINARY="${!i}" ;;
    --config)      i=$((i+1)); MCP_CONFIG_PATH="${!i}" ;;
    --stop)        DO_STOP=1 ;;
    --help|-h)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# --- Stop-mode: kill prior quickstart processes and exit ---------------------
if [ "$DO_STOP" = "1" ]; then
  for f in "$WORKER_PID_FILE" "$HUB_PID_FILE"; do
    if [ -f "$f" ]; then
      PID="$(cat "$f" 2>/dev/null || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        echo -e "${GREEN}✓${NC} stopped pid $PID ($(basename "$f" .pid))"
      fi
      rm -f "$f"
    fi
  done
  exit 0
fi

die() {
  echo -e "${RED}✗${NC} $1" >&2
  [ -n "${2:-}" ] && echo -e "  ${DIM}See docs/TROUBLESHOOTING.md#${2}${NC}" >&2
  exit 1
}

echo ""
echo -e "${BOLD}${CYAN}AnyAgent quickstart${NC} — local setup in ~60 seconds"
echo ""

# --- 1. Prereqs --------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 22+ (nvm install 22)." "nodejs-missing"
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VER" -lt 22 ] && die "Node $NODE_VER found, 22+ required (for built-in node:sqlite). Try: nvm install 22" "nodejs-too-old"
echo -e "${GREEN}✓${NC} Node $(node -v)"

# The hub has no native deps. The worker has node-pty, which ships prebuilds —
# so on a fresh machine the install usually skips gyp entirely.

# --- 2. Detect an AI CLI -----------------------------------------------------
declare_preset() {
  case "$1" in
    claude)  echo "coding,refactoring,testing,shell" ;;
    codex)   echo "coding,review,refactoring" ;;
    ollama)  echo "llm,chat,local" ;;
    aider)   echo "coding,git,refactoring" ;;
    gemini)  echo "coding,chat" ;;
    bash)    echo "shell,scripts,ops" ;;
    *)       echo "general" ;;
  esac
}

if [ -n "$FORCED_BINARY" ]; then
  AGENT_BINARY="$FORCED_BINARY"
  if ! command -v "$AGENT_BINARY" >/dev/null 2>&1; then
    die "Forced binary '$AGENT_BINARY' not on PATH." "binary-not-on-path"
  fi
else
  # First match wins. Order matters: prefer the coding-focused CLIs.
  AGENT_BINARY=""
  for bin in claude codex aider ollama gemini bash; do
    if command -v "$bin" >/dev/null 2>&1; then AGENT_BINARY="$bin"; break; fi
  done
fi

if [ -z "$AGENT_BINARY" ]; then
  echo -e "${YELLOW}No AI CLI detected on PATH.${NC}"
  echo "  Install one and re-run, or pass --binary <name>:"
  echo "    claude:  https://docs.claude.com/docs/claude-code/install"
  echo "    ollama:  brew install ollama    # macOS"
  echo "    aider:   pip install aider-chat"
  exit 1
fi
AGENT_PATH="$(command -v "$AGENT_BINARY")"
AGENT_CAPS="$(declare_preset "$AGENT_BINARY")"
echo -e "${GREEN}✓${NC} Found ${BOLD}${AGENT_BINARY}${NC} at ${DIM}${AGENT_PATH}${NC}"

# --- 3. Generate secrets -----------------------------------------------------
WS_SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')
MCP_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')

# --- 4. Build --------------------------------------------------------------
echo -e "${DIM}Building hub + sdk + worker...${NC}"
(cd sdk    && npm ci --silent && npm run build --silent) > /dev/null 2>&1 || die "SDK build failed. See docs/TROUBLESHOOTING.md" "sdk-build-failed"
(cd hub    && npm ci --silent && npm run build --silent) > /dev/null 2>&1 || die "Hub build failed." "hub-build-failed"
(cd worker && npm ci --silent && npm run build --silent) > /dev/null 2>&1 || die "Worker build failed." "worker-build-failed"
echo -e "${GREEN}✓${NC} Built"

# --- 5. Write hub/.env ------------------------------------------------------
mkdir -p hub/logs worker/logs
{
  echo "ALLOWED_USER_ID=0"
  echo "WS_PORT=8080"
  echo "WS_SECRET=$WS_SECRET"
  echo "MCP_PORT=3000"
  echo "MCP_TOKEN=$MCP_TOKEN"
  # The one line that lets the worker pair without human approval,
  # and only for 127.0.0.1 connections.
  echo "AUTO_APPROVE_LOOPBACK=1"
} > hub/.env
chmod 600 hub/.env

# --- 6. Start hub (background) ---------------------------------------------
if [ -f "$HUB_PID_FILE" ] && kill -0 "$(cat "$HUB_PID_FILE" 2>/dev/null)" 2>/dev/null; then
  echo -e "${YELLOW}⚠${NC}  A quickstart hub is already running (pid $(cat "$HUB_PID_FILE")). Run ./quickstart.sh --stop first."
  exit 1
fi

echo -e "${DIM}Starting hub...${NC}"
# Redirect stdin from /dev/null so the CLI sees EOF and doesn't fight for the tty.
(cd hub && nohup node dist/index.js < /dev/null >> "$HUB_LOG" 2>&1 & echo $! > "$HUB_PID_FILE")

# Wait for /health to respond (up to 10s)
for i in $(seq 1 20); do
  if curl -sSf http://127.0.0.1:3000/health > /dev/null 2>&1; then
    HUB_READY=1
    break
  fi
  sleep 0.5
done
if [ -z "${HUB_READY:-}" ]; then
  echo -e "${RED}✗${NC} Hub did not bind in 10s. Log tail:"
  tail -20 "$HUB_LOG"
  exit 1
fi
echo -e "${GREEN}✓${NC} Hub listening on :8080 (ws) and :3000 (mcp)"

# --- 7. Generate pair code ---------------------------------------------------
PAIR_CODE="$(node hub/dist/tools/gen-pair.js 2>/dev/null | tr -d '\r\n' | tail -c 50)"
if ! [[ "$PAIR_CODE" =~ ^[A-F0-9]{32}$ ]]; then
  die "Failed to generate pair code (got: '${PAIR_CODE}')"
fi
echo -e "${GREEN}✓${NC} Generated pair code"

# --- 8. Write worker/.env ---------------------------------------------------
AGENTS_JSON="[{\"name\":\"${AGENT_BINARY}\",\"binary\":\"${AGENT_BINARY}\",\"args\":[],\"description\":\"${AGENT_BINARY} on $(hostname)\",\"capabilities\":[\"${AGENT_CAPS//,/\",\"}\"]}]"

{
  echo "HUB_URL=ws://127.0.0.1:8080"
  echo "PAIR_CODE=$PAIR_CODE"
  echo "WS_SECRET=$WS_SECRET"
  echo "WORKER_NAME=$(hostname)"
  echo "WORKER_DESCRIPTION=Quickstart local worker"
  echo "WORKER_AGENTS=$AGENTS_JSON"
} > worker/.env
chmod 600 worker/.env

# --- 9. Start worker (background) -------------------------------------------
echo -e "${DIM}Starting worker + pairing...${NC}"
(cd worker && nohup node dist/index.js < /dev/null >> "$WORKER_LOG" 2>&1 & echo $! > "$WORKER_PID_FILE")

# Wait for worker to show up in /health (up to 15s — includes key generation)
for i in $(seq 1 30); do
  ONLINE=$(curl -sSf http://127.0.0.1:3000/health 2>/dev/null | grep -oE '"online":[0-9]+' | head -1 | cut -d: -f2 || echo "0")
  if [ "${ONLINE:-0}" -gt 0 ]; then
    WORKER_READY=1
    break
  fi
  sleep 0.5
done
if [ -z "${WORKER_READY:-}" ]; then
  echo -e "${RED}✗${NC} Worker did not pair in 15s. Log tail:"
  tail -20 "$WORKER_LOG"
  echo -e "${DIM}(Hub log: $HUB_LOG)${NC}"
  exit 1
fi
echo -e "${GREEN}✓${NC} Worker paired and online"

# --- 10. Wire MCP client config ---------------------------------------------
if [ "$WIRE_MCP" = "1" ]; then
  MCP_URL="http://127.0.0.1:3000"
  if [ -n "$MCP_CONFIG_PATH" ]; then
    node hub/dist/tools/wire-mcp.js --url "$MCP_URL" --token "$MCP_TOKEN" --config "$MCP_CONFIG_PATH"
  else
    node hub/dist/tools/wire-mcp.js --url "$MCP_URL" --token "$MCP_TOKEN"
  fi
else
  echo ""
  echo -e "${DIM}Skipped MCP client config (--no-wire). Snippet:${NC}"
  node hub/dist/tools/wire-mcp.js --url "http://127.0.0.1:3000" --token "$MCP_TOKEN" --print
fi

# --- 11. Done ---------------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}AnyAgent is running.${NC}"
echo ""
echo -e "  Agent ready:  ${CYAN}${AGENT_BINARY}${NC} (capabilities: $AGENT_CAPS)"
echo -e "  MCP endpoint: ${CYAN}http://127.0.0.1:3000${NC}"
echo -e "  Health check: ${CYAN}curl http://127.0.0.1:3000/health${NC}"
echo ""
echo -e "  ${BOLD}Try it:${NC} reopen your MCP client and call ${CYAN}anyagent_list_agents${NC}"
echo -e "         or prompt: ${DIM}\"use anyagent_route to run a quick test\"${NC}"
echo ""
echo -e "  Stop:          ${CYAN}./quickstart.sh --stop${NC}"
echo -e "  Promote to a service (survives reboot):"
echo -e "                 ${CYAN}./packaging/install-service.sh hub${NC}"
echo -e "                 ${CYAN}./packaging/install-service.sh worker${NC}"
echo -e "  Logs:          ${DIM}$HUB_LOG${NC}"
echo -e "                 ${DIM}$WORKER_LOG${NC}"
echo ""
