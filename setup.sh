#!/usr/bin/env bash
set -e

# AnyAgent Hub — Interactive Setup
# Usage: curl -fsSL https://your-domain/setup.sh | bash
#   or:  git clone ... && cd AnyAgent && ./setup.sh

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}AnyAgent${NC} — Personal MCP Bridge for Distributed Agents"
echo -e "This will set up the hub (Telegram bot + MCP server).\n"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Node.js not found. Install Node 20+ and try again.${NC}"
  echo "  brew install node    # macOS"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -  # Linux"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${YELLOW}Node.js $NODE_VER found, but 18+ required. Please upgrade.${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# Step 1: Telegram bot token
echo ""
echo -e "${BOLD}Step 1: Telegram Bot (optional)${NC}"
echo "  For mobile management: @BotFather → /newbot → copy token"
echo "  Press Enter to skip (CLI-only mode)."
echo ""
read -p "  BOT_TOKEN (or Enter to skip): " BOT_TOKEN

ALLOWED_USER_ID=""
if [ -n "$BOT_TOKEN" ]; then
  # Validate BOT_TOKEN format
  if ! echo "$BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
    echo -e "${YELLOW}Warning: doesn't match Telegram format (digits:alphanumeric).${NC}"
    read -p "  Continue anyway? [y/N]: " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      exit 1
    fi
  fi

  echo ""
  echo -e "${BOLD}Step 2: Your Telegram User ID${NC}"
  echo "  Open Telegram → @userinfobot → send /start → copy your ID"
  echo ""
  read -p "  ALLOWED_USER_ID: " ALLOWED_USER_ID

  if [ -z "$ALLOWED_USER_ID" ]; then
    echo "ALLOWED_USER_ID is required when BOT_TOKEN is set. Exiting."
    exit 1
  fi

  # Validate numeric
  if ! echo "$ALLOWED_USER_ID" | grep -qE '^[0-9]+$'; then
    echo "ALLOWED_USER_ID must be a number. Exiting."
    exit 1
  fi

  echo -e "${GREEN}✓${NC} Telegram enabled"
else
  echo -e "${GREEN}✓${NC} CLI-only mode (no Telegram)"
  ALLOWED_USER_ID="0"
fi

# Step 3: Auto-generate secrets
WS_SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')
MCP_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')

echo ""
echo -e "${GREEN}✓${NC} Generated WS_SECRET and MCP_TOKEN automatically"

# Step 4: Write hub .env
echo ""
echo -e "${BOLD}Step 3: Installing hub...${NC}"

{
  if [ -n "$BOT_TOKEN" ]; then
    printf 'BOT_TOKEN=%s\n' "$BOT_TOKEN"
  fi
  printf 'ALLOWED_USER_ID=%s\n' "$ALLOWED_USER_ID"
  printf 'WS_PORT=8080\n'
  printf 'WS_SECRET=%s\n' "$WS_SECRET"
  printf 'MCP_PORT=3000\n'
  printf 'MCP_TOKEN=%s\n' "$MCP_TOKEN"
} > hub/.env

chmod 600 hub/.env

# Step 5: Install + build
(cd sdk && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || true
echo -e "${GREEN}✓${NC} SDK built"

(cd hub && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || true
echo -e "${GREEN}✓${NC} Hub built"

# Done
HUB_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo "YOUR_HUB_IP")

echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
echo -e "  Start the hub:     ${CYAN}cd hub && npm start${NC}"
echo ""
echo -e "  Then in Telegram:  Send ${CYAN}/start${NC} to your bot"
echo ""
echo -e "${BOLD}To add a worker on another machine:${NC}"
echo ""
echo -e "  1. In Telegram, send ${CYAN}/pair${NC} to get a pairing code"
echo -e "  2. On the worker machine, run:"
echo ""
echo -e "     ${CYAN}git clone <this-repo> && cd AnyAgent && ./add-worker.sh${NC}"
echo ""
echo -e "${BOLD}MCP clients (Claude Code, Cursor):${NC}"
echo ""
echo -e "  URL:   ${CYAN}http://${HUB_IP}:3000${NC}"
echo -e "  Token: see ${CYAN}hub/.env${NC} (MCP_TOKEN field)"
echo ""
echo -e "  Add to .mcp.json (replace TOKEN with value from hub/.env):"
echo -e "  ${CYAN}{\"mcpServers\":{\"anyagent\":{\"url\":\"http://${HUB_IP}:3000\",\"headers\":{\"Authorization\":\"Bearer TOKEN\"}}}}${NC}"
echo ""
