#!/usr/bin/env bash
set -e

# AnyAgent Worker — Interactive Setup
#
# Usage:
#   ./add-worker.sh
#   ./add-worker.sh --non-interactive   (reads all inputs from env vars)
#   ./add-worker.sh --verify             (boot briefly after install to confirm)
#   ./add-worker.sh --install-service    (install systemd/launchd at the end)
#
# First run connects a machine to your hub. Run this on each machine you want
# to expose as a worker.

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

NONINTERACTIVE=0
VERIFY=0
INSTALL_SERVICE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NONINTERACTIVE=1 ;;
    --verify)          VERIFY=1 ;;
    --install-service) INSTALL_SERVICE=1 ;;
    --help|-h)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

die() { echo -e "${RED}✗${NC} $1"; [ -n "${2:-}" ] && echo -e "  ${DIM}See docs/TROUBLESHOOTING.md#${2}${NC}"; exit 1; }

echo ""
echo -e "${BOLD}${CYAN}AnyAgent Worker${NC} — Connect this machine to your hub"
echo ""

# --- Prereqs ----------------------------------------------------------------

command -v node &> /dev/null || die "Node.js not found. Install Node 22+ (nvm install 22) and try again." "nodejs-missing"
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VER" -lt 20 ] && die "Node $NODE_VER found, 20+ required on the worker. Try: nvm install 22" "nodejs-too-old"
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# The worker still has ONE native module (node-pty), but it ships prebuilds for
# Node 20/22 on common platforms — only fall back to a source build if needed.
# The check below is advisory: if tools are missing, warn but continue.
need_build_tools=0
command -v python3 >/dev/null 2>&1 || need_build_tools=1
if ! (command -v make >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1) && ! command -v cc >/dev/null 2>&1; then
  need_build_tools=1
fi
if [ "$need_build_tools" = "1" ]; then
  echo -e "${YELLOW}⚠ ${NC} Build tools missing — only matters if node-pty's prebuilt binary isn't available for your Node version."
  case "$(uname -s)" in
    Darwin) echo "  If the install fails, run: xcode-select --install" ;;
    Linux)  echo "  If the install fails, run: sudo apt install python3 build-essential" ;;
  esac
else
  echo -e "${GREEN}✓${NC} Build tools available"
fi

# --- Step 1: Hub discovery or manual URL ------------------------------------

echo ""
echo -e "${BOLD}Step 1: Hub connection${NC}"

# Preserve HUB_URL if set in env (non-interactive callers rely on this).
HUB_URL="${HUB_URL:-}"
# Try mDNS discovery if we have a scanner. dns-sd (macOS) or avahi-browse (Linux).
# Skip in non-interactive mode — user can pass HUB_URL env directly.
if [ "$NONINTERACTIVE" != "1" ]; then
  if command -v dns-sd >/dev/null 2>&1; then
    echo "  Scanning LAN for hubs (3s)..."
    SCAN=$(timeout 3 dns-sd -B _anyagent._tcp. 2>/dev/null | awk 'NR>1 && /_anyagent._tcp/ {print $NF}' | sort -u || true)
  elif command -v avahi-browse >/dev/null 2>&1; then
    echo "  Scanning LAN for hubs (3s)..."
    SCAN=$(timeout 3 avahi-browse -rt _anyagent._tcp 2>/dev/null | awk '/address/ {gsub(/[\[\]]/,""); print $NF}' | sort -u || true)
  else
    SCAN=""
  fi
  if [ -n "$SCAN" ]; then
    echo "  Found:"
    i=1
    for host in $SCAN; do
      echo "    $i) ws://$host:8080"
      i=$((i+1))
    done
    read -p "  Pick a number, or press Enter to type manually: " SEL
    if [ -n "$SEL" ]; then
      HUB_URL="ws://$(echo "$SCAN" | sed -n "${SEL}p"):8080"
    fi
  fi
fi

if [ -z "$HUB_URL" ]; then
  if [ "$NONINTERACTIVE" = "1" ]; then
    HUB_URL="ws://localhost:8080"
  else
    echo "  Enter the hub's WebSocket URL (e.g. ws://192.168.1.5:8080)."
    read -p "  Hub URL [ws://localhost:8080]: " HUB_URL
    HUB_URL=${HUB_URL:-ws://localhost:8080}
  fi
fi

# --- Step 2: WS_SECRET ------------------------------------------------------

echo ""
echo -e "${BOLD}Step 2: Hub secret${NC}"
if [ "$NONINTERACTIVE" = "1" ]; then
  :
else
  echo "  Enter WS_SECRET from hub/.env on the hub machine (Enter to skip if not set)."
  read -p "  WS_SECRET: " WS_SECRET
fi

# --- Step 3: Pair code ------------------------------------------------------

echo ""
echo -e "${BOLD}Step 3: Pairing code${NC}"
if [ "$NONINTERACTIVE" != "1" ]; then
  echo "  In the hub CLI: type ${CYAN}pair${NC} (or ${CYAN}/pair${NC} in Telegram). Paste here."
  read -p "  Pairing code: " PAIR_CODE
fi
[ -z "${PAIR_CODE:-}" ] && die "Pairing code required." "pair-code-missing"

# --- Step 4: Worker identity ------------------------------------------------

echo ""
echo -e "${BOLD}Step 4: Worker identity${NC}"
HOSTNAME_DEFAULT=$(hostname)
if [ "$NONINTERACTIVE" = "1" ]; then
  WORKER_NAME="${WORKER_NAME:-$HOSTNAME_DEFAULT}"
  WORKER_DESC="${WORKER_DESCRIPTION:-}"
else
  read -p "  Worker name [${HOSTNAME_DEFAULT}]: " WORKER_NAME
  WORKER_NAME=${WORKER_NAME:-$HOSTNAME_DEFAULT}
  read -p "  Description (optional): " WORKER_DESC
fi

# --- Step 5: Agent detection + configuration --------------------------------

echo ""
echo -e "${BOLD}Step 5: Agents on this machine${NC}"

# Probe for known AI CLIs on PATH — each maps to a preset capability list
declare_preset() {
  case "$1" in
    claude) echo "coding,refactoring,testing,shell" ;;
    codex)  echo "coding,review,refactoring" ;;
    ollama) echo "llm,chat,local" ;;
    aider)  echo "coding,git,refactoring" ;;
    gemini) echo "coding,chat" ;;
    bash)   echo "shell,scripts,ops" ;;
    python3) echo "scripting,data" ;;
    *) echo "general" ;;
  esac
}

# AnyAgent runs each spawn as a one-shot MCP call: intent goes in, result comes
# back, process exits. These args put each known CLI into its non-interactive
# print-and-exit mode so the PTY spawn actually terminates. `-` tells codex to
# read the prompt from the PTY's stdin; --skip-git-repo-check disables codex's
# requirement that the cwd be a git repo (the worker's cwd is $HOME).
#
# JSON array elements, comma-separated, no quotes — assembled into the
# WORKER_AGENTS JSON below.
args_preset() {
  case "$1" in
    claude)  echo '"-p"' ;;
    codex)   echo '"exec","--skip-git-repo-check","-"' ;;
    gemini)  echo '"-p"' ;;
    aider)   echo '"--yes","--no-pretty"' ;;
    *)       echo "" ;;
  esac
}

CANDIDATES="claude codex ollama aider gemini bash python3"
DETECTED=""
for bin in $CANDIDATES; do
  if command -v "$bin" >/dev/null 2>&1; then
    DETECTED="$DETECTED $bin"
    echo -e "  ${GREEN}✓${NC} ${bin} (at $(command -v "$bin"))"
  fi
done

if [ -z "$DETECTED" ]; then
  echo -e "  ${YELLOW}No known AI CLIs detected on PATH.${NC}"
  echo "  You can still declare an agent manually — type the binary name below."
fi

if [ "$NONINTERACTIVE" = "1" ]; then
  AGENT_BINARY="${AGENT_BINARY:-claude}"
  AGENT_NAME="${AGENT_NAME:-$AGENT_BINARY}"
  AGENT_DESC="${AGENT_DESC:-${AGENT_NAME} agent}"
  AGENT_CAPS="${AGENT_CAPS:-$(declare_preset "$AGENT_BINARY")}"
else
  # Pick the first detected binary as default, else 'claude'
  DEFAULT_BIN=$(echo "$DETECTED" | awk '{print $1}')
  DEFAULT_BIN=${DEFAULT_BIN:-claude}
  echo ""
  read -p "  Binary to expose [${DEFAULT_BIN}]: " AGENT_BINARY
  AGENT_BINARY=${AGENT_BINARY:-$DEFAULT_BIN}

  # Health check the binary unless it's not on PATH (user may install later)
  if command -v "$AGENT_BINARY" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} ${AGENT_BINARY} is on PATH"
  else
    echo -e "  ${YELLOW}⚠${NC}  ${AGENT_BINARY} not on PATH — worker will error when the hub asks it to spawn."
    echo "     Install it before starting the worker."
  fi

  read -p "  Agent display name [${AGENT_BINARY}]: " AGENT_NAME
  AGENT_NAME=${AGENT_NAME:-$AGENT_BINARY}

  read -p "  Description [${AGENT_NAME} agent]: " AGENT_DESC
  AGENT_DESC=${AGENT_DESC:-"${AGENT_NAME} agent"}

  DEFAULT_CAPS=$(declare_preset "$AGENT_BINARY")
  echo ""
  echo -e "  ${DIM}Suggested capabilities for ${AGENT_BINARY}: ${DEFAULT_CAPS}${NC}"
  read -p "  Capabilities [${DEFAULT_CAPS}]: " AGENT_CAPS
  AGENT_CAPS=${AGENT_CAPS:-$DEFAULT_CAPS}
fi

# Sanitize — strip characters that break JSON
sanitize() { echo "$1" | tr -d '"\\`$\n\r'; }
AGENT_NAME=$(sanitize "$AGENT_NAME")
AGENT_BINARY=$(sanitize "$AGENT_BINARY")
AGENT_DESC=$(sanitize "$AGENT_DESC")
WORKER_NAME=$(sanitize "$WORKER_NAME")
WORKER_DESC=$(sanitize "$WORKER_DESC")

# Build capabilities JSON array
IFS=',' read -ra CAP_ARRAY <<< "$AGENT_CAPS"
CAPS_JSON="["
for i in "${!CAP_ARRAY[@]}"; do
  cap=$(echo "${CAP_ARRAY[$i]}" | tr -d '"\\`$\n\r ' )
  [ "$i" -gt 0 ] && CAPS_JSON="$CAPS_JSON,"
  CAPS_JSON="$CAPS_JSON\"$cap\""
done
CAPS_JSON="$CAPS_JSON]"

ARGS_PRESET=$(args_preset "$AGENT_BINARY")
# Allow override via AGENT_ARGS env var (comma-separated JSON-quoted strings, e.g. '"-p","foo"').
AGENT_ARGS="${AGENT_ARGS:-$ARGS_PRESET}"

AGENTS_JSON="[{\"name\":\"${AGENT_NAME}\",\"binary\":\"${AGENT_BINARY}\",\"args\":[${AGENT_ARGS}],\"description\":\"${AGENT_DESC}\",\"capabilities\":${CAPS_JSON}}]"

# --- Step 6: Write .env -----------------------------------------------------

echo ""
echo -e "${BOLD}Step 6: Installing worker...${NC}"

{
  printf 'HUB_URL=%s\n' "$HUB_URL"
  printf 'PAIR_CODE=%s\n' "$PAIR_CODE"
  printf 'WORKER_NAME=%s\n' "$WORKER_NAME"
  printf 'WORKER_DESCRIPTION=%s\n' "$WORKER_DESC"
  printf 'WORKER_AGENTS=%s\n' "$AGENTS_JSON"
  [ -n "${WS_SECRET:-}" ] && printf 'WS_SECRET=%s\n' "$WS_SECRET"
} > worker/.env
chmod 600 worker/.env

(cd sdk && npm ci --silent && npm run build) || die "SDK build failed." "sdk-build-failed"
echo -e "${GREEN}✓${NC} SDK built"

(cd worker && npm ci --silent && npm run build) || die "Worker build failed." "worker-build-failed"
echo -e "${GREEN}✓${NC} Worker built"

# node-pty ships prebuilt `spawn-helper` binaries but npm's tarball extraction
# doesn't always preserve the +x bit. Without it every pty.spawn() call fails
# with `posix_spawnp failed`. Set the bit defensively for every prebuilt we find.
find worker/node_modules/node-pty/prebuilds -type f -name 'spawn-helper' -exec chmod +x {} \; 2>/dev/null || true

# --- Step 7 (optional): verify --------------------------------------------

if [ "$VERIFY" = "1" ]; then
  echo ""
  echo -e "${BOLD}Verifying worker boot (3s)...${NC}"
  (cd worker && timeout 3 node dist/index.js > /tmp/anyagent-worker-verify.log 2>&1 &)
  sleep 2
  if grep -qE "(Connecting to hub|Authenticated|Sent pair request)" /tmp/anyagent-worker-verify.log; then
    echo -e "${GREEN}✓${NC} Worker starts and attempts to connect"
  else
    echo -e "${RED}✗${NC} Worker failed to start. Log:"
    tail -20 /tmp/anyagent-worker-verify.log
    die "Verification failed." "verify-failed"
  fi
fi

# --- Step 8 (optional): install as a service ------------------------------

if [ "$INSTALL_SERVICE" != "1" ] && [ "$NONINTERACTIVE" != "1" ]; then
  echo ""
  echo -e "${BOLD}Install as a system service?${NC}"
  echo "  Keeps the worker running across reboots / crashes."
  read -p "  Install? [y/N]: " SVC_YN
  [ "$SVC_YN" = "y" ] || [ "$SVC_YN" = "Y" ] && INSTALL_SERVICE=1 || true
fi

if [ "$INSTALL_SERVICE" = "1" ]; then
  echo ""
  ./packaging/install-service.sh worker
fi

# --- Done ------------------------------------------------------------------

echo ""
echo -e "${BOLD}${GREEN}Worker ready!${NC}"
echo ""
if [ "$INSTALL_SERVICE" = "1" ]; then
  echo -e "  Worker is running as a service."
else
  echo -e "  Start the worker:  ${CYAN}cd worker && npm start${NC}"
fi
echo ""
echo -e "  Then approve the pairing (${CYAN}y${NC} in hub CLI, or ✅ in Telegram)."
echo -e "  After approval, credentials auto-save — future restarts skip pairing."
echo ""
echo -e "  Health check the worker's config: ${CYAN}cd worker && npm run doctor${NC}"
echo ""
