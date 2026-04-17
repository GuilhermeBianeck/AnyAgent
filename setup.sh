#!/usr/bin/env bash
set -e

# AnyAgent Hub — Interactive Setup
# Usage:
#   ./setup.sh                  — interactive
#   ./setup.sh --non-interactive — reads BOT_TOKEN/ALLOWED_USER_ID from env, skips prompts
#   ./setup.sh --verify          — after install, spawn hub briefly to confirm it boots
#   ./setup.sh --install-service — at end, install systemd (Linux) / launchd (macOS) unit

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

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

# --- trouble helper -----------------------------------------------------------
# Every exit point points operators at docs/TROUBLESHOOTING.md so "setup failed"
# doesn't mean "read the source".
die() {
  echo -e "${RED}✗${NC} $1"
  if [ -n "${2:-}" ]; then
    echo -e "  ${DIM}See docs/TROUBLESHOOTING.md#${2}${NC}"
  fi
  exit 1
}

# --- OS-specific package installer helper ------------------------------------
# Returns the command that installs $1 on this OS, or empty if unknown.
install_cmd_for() {
  local pkg="$1"
  case "$(uname -s)" in
    Darwin)
      case "$pkg" in
        build-tools) echo "xcode-select --install" ;;
        *) echo "" ;;
      esac
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        case "$pkg" in
          build-tools) echo "sudo apt-get install -y python3 build-essential" ;;
          *) echo "" ;;
        esac
      elif command -v dnf >/dev/null 2>&1; then
        case "$pkg" in
          build-tools) echo "sudo dnf install -y python3 gcc gcc-c++ make" ;;
          *) echo "" ;;
        esac
      elif command -v apk >/dev/null 2>&1; then
        case "$pkg" in
          build-tools) echo "sudo apk add python3 build-base" ;;
          *) echo "" ;;
        esac
      fi
      ;;
  esac
}

# Offer to run the install command; confirm unless --non-interactive.
offer_install() {
  local pkg="$1"
  local cmd
  cmd="$(install_cmd_for "$pkg")"
  if [ -z "$cmd" ]; then return 1; fi
  echo -e "  ${CYAN}Suggested:${NC} $cmd"
  if [ "$NONINTERACTIVE" = "1" ]; then return 1; fi
  read -p "  Run it now? [y/N]: " YN
  if [ "$YN" = "y" ] || [ "$YN" = "Y" ]; then
    eval "$cmd"
    return $?
  fi
  return 1
}

echo ""
echo -e "${BOLD}${CYAN}AnyAgent${NC} — Personal MCP Bridge for Distributed Agents"
echo -e "This will set up the hub (Telegram bot + MCP server).\n"

# --- Prerequisite checks ------------------------------------------------------

if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Node.js not found.${NC}"
  echo "  macOS:  brew install node@22"
  echo "  Linux:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
  echo "  nvm:    nvm install 22"
  die "Install Node 22+ and re-run." "nodejs-missing"
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 22 ]; then
  die "Node.js $NODE_VER found, 22+ required (for built-in node:sqlite). Try: nvm install 22" "nodejs-too-old"
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# The hub no longer needs a native compiler — node:sqlite is built in.
# The worker still uses node-pty, which ships prebuilds for all common platforms;
# we only check for build tools if we'll actually need them for worker setup.
# (quickstart.sh's subset of checks skips this entirely.)

# --- Step 1: Telegram bot (optional) -----------------------------------------

echo ""
echo -e "${BOLD}Step 1: Telegram Bot (optional)${NC}"
echo "  For mobile management: @BotFather → /newbot → copy token"
echo "  Press Enter to skip (CLI-only mode)."

if [ "$NONINTERACTIVE" = "1" ]; then
  BOT_TOKEN="${BOT_TOKEN:-}"
  ALLOWED_USER_ID="${ALLOWED_USER_ID:-0}"
else
  echo ""
  read -p "  BOT_TOKEN (or Enter to skip): " BOT_TOKEN
  ALLOWED_USER_ID=""
  if [ -n "$BOT_TOKEN" ]; then
    if ! echo "$BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
      echo -e "${YELLOW}Warning: doesn't match Telegram format (digits:alphanumeric).${NC}"
      read -p "  Continue anyway? [y/N]: " CONFIRM
      [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && die "Setup cancelled." "telegram-token-format"
    fi
    echo ""
    echo -e "${BOLD}Step 2: Your Telegram User ID${NC}"
    echo "  Open Telegram → @userinfobot → /start → copy your ID"
    echo ""
    read -p "  ALLOWED_USER_ID: " ALLOWED_USER_ID
    [ -z "$ALLOWED_USER_ID" ] && die "ALLOWED_USER_ID is required when BOT_TOKEN is set." "telegram-user-id"
    echo "$ALLOWED_USER_ID" | grep -qE '^[0-9]+$' || die "ALLOWED_USER_ID must be a number." "telegram-user-id"
    echo -e "${GREEN}✓${NC} Telegram enabled"
  else
    echo -e "${GREEN}✓${NC} CLI-only mode (no Telegram)"
    ALLOWED_USER_ID="0"
  fi
fi

# --- Step 3: Auto-generate secrets -------------------------------------------

WS_SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')
MCP_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')
echo ""
echo -e "${GREEN}✓${NC} Generated WS_SECRET and MCP_TOKEN"

# --- Step 4: Write .env ------------------------------------------------------

echo ""
echo -e "${BOLD}Step 3: Installing hub...${NC}"

{
  [ -n "$BOT_TOKEN" ] && printf 'BOT_TOKEN=%s\n' "$BOT_TOKEN"
  printf 'ALLOWED_USER_ID=%s\n' "$ALLOWED_USER_ID"
  printf 'WS_PORT=8080\n'
  printf 'WS_SECRET=%s\n' "$WS_SECRET"
  printf 'MCP_PORT=3000\n'
  printf 'MCP_TOKEN=%s\n' "$MCP_TOKEN"
} > hub/.env
chmod 600 hub/.env

# --- Step 5: Install + build --------------------------------------------------

(cd sdk && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || die "SDK build failed. Check Node version and build tools." "sdk-build-failed"
echo -e "${GREEN}✓${NC} SDK built"

(cd hub && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || die "Hub build failed. See docs/TROUBLESHOOTING.md#hub-build-failed" "hub-build-failed"
echo -e "${GREEN}✓${NC} Hub built"

# --- Step 6: (optional) verify boot -------------------------------------------

if [ "$VERIFY" = "1" ]; then
  echo ""
  echo -e "${BOLD}Verifying hub boot (3s)...${NC}"
  # Start hub, wait for it to bind ports, then kill. If it crashes in 3s, setup failed.
  (cd hub && timeout 3 node dist/index.js > /tmp/anyagent-verify.log 2>&1 &)
  sleep 2
  if grep -q "WebSocket gateway on port" /tmp/anyagent-verify.log; then
    echo -e "${GREEN}✓${NC} Hub boots cleanly"
  else
    echo -e "${RED}✗${NC} Hub failed to bind. Log:"
    tail -20 /tmp/anyagent-verify.log
    die "Verification failed." "verify-failed"
  fi
fi

# --- Step 7: (optional) install as a system service --------------------------

if [ "$INSTALL_SERVICE" != "1" ] && [ "$NONINTERACTIVE" != "1" ]; then
  echo ""
  echo -e "${BOLD}Install as a system service?${NC}"
  echo "  Yes = systemd (Linux) / launchd (macOS) keeps the hub running across reboots"
  read -p "  Install? [y/N]: " SVC_YN
  [ "$SVC_YN" = "y" ] || [ "$SVC_YN" = "Y" ] && INSTALL_SERVICE=1 || true
fi

if [ "$INSTALL_SERVICE" = "1" ]; then
  echo ""
  ./packaging/install-service.sh hub
fi

# --- Done --------------------------------------------------------------------

HUB_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo "YOUR_HUB_IP")

echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
if [ "$INSTALL_SERVICE" = "1" ]; then
  echo -e "  Hub is running as a service. ${CYAN}status${NC} command shows state."
else
  echo -e "  Start the hub:     ${CYAN}cd hub && npm start${NC}"
fi
echo ""
[ -n "$BOT_TOKEN" ] && echo -e "  Telegram:          Send ${CYAN}/start${NC} to your bot"
echo ""
echo -e "${BOLD}Add a worker on another machine:${NC}"
echo -e "  1. In hub CLI:     ${CYAN}pair${NC}   (or ${CYAN}/pair${NC} in Telegram)"
echo -e "  2. On that machine: ${CYAN}git clone <this-repo> && cd AnyAgent && ./add-worker.sh${NC}"
echo ""
echo -e "${BOLD}MCP clients (Claude Code, Cursor):${NC}"
echo -e "  URL:    ${CYAN}http://${HUB_IP}:3000${NC}"
echo -e "  Token:  see ${CYAN}hub/.env${NC} (MCP_TOKEN)"
echo -e "  Health: ${CYAN}http://${HUB_IP}:3000/health${NC} (no auth)"
echo ""
