#!/usr/bin/env bash
set -e

# AnyAgent Worker — Interactive Setup
# Run this on each machine where you want to run agents.

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}AnyAgent Worker${NC} — Connect this machine to your hub"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Node.js not found. Install Node 20+ and try again.${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# Check build tools
if ! command -v python3 &> /dev/null; then
  echo -e "${YELLOW}python3 not found. Install build tools first:${NC}"
  echo "  macOS: xcode-select --install"
  echo "  Ubuntu: sudo apt install python3 build-essential"
  exit 1
fi
echo -e "${GREEN}✓${NC} Build tools available"

# Step 1: Hub URL
echo ""
echo -e "${BOLD}Step 1: Hub connection${NC}"
echo "  Enter the hub's WebSocket URL (the machine running the hub)."
echo ""
read -p "  Hub URL [ws://localhost:8080]: " HUB_URL
HUB_URL=${HUB_URL:-ws://localhost:8080}

# Step 2: WS_SECRET
echo ""
echo -e "${BOLD}Step 2: Hub secret${NC}"
echo "  Enter the WS_SECRET from the hub's .env (leave empty if not set)."
echo ""
read -p "  WS_SECRET: " WS_SECRET

# Step 3: Pair code
echo ""
echo -e "${BOLD}Step 3: Pairing code${NC}"
echo "  In the hub CLI type ${CYAN}pair${NC} (or send ${CYAN}/pair${NC} in Telegram) and paste the code here."
echo ""
read -p "  Pairing code: " PAIR_CODE

if [ -z "$PAIR_CODE" ]; then
  echo "Pairing code required. Exiting."
  exit 1
fi

# Step 4: Worker name
echo ""
echo -e "${BOLD}Step 4: Worker identity${NC}"
HOSTNAME_DEFAULT=$(hostname)
read -p "  Worker name [${HOSTNAME_DEFAULT}]: " WORKER_NAME
WORKER_NAME=${WORKER_NAME:-$HOSTNAME_DEFAULT}

read -p "  Description (optional): " WORKER_DESC

# Step 5: Agent setup
echo ""
echo -e "${BOLD}Step 5: Agent configuration${NC}"
echo "  Which binary should this worker expose as an agent?"
echo "  Examples: claude, bash, python, ollama"
echo ""
read -p "  Binary name [claude]: " AGENT_BINARY
AGENT_BINARY=${AGENT_BINARY:-claude}

read -p "  Agent display name [${AGENT_BINARY}]: " AGENT_NAME
AGENT_NAME=${AGENT_NAME:-$AGENT_BINARY}

read -p "  Description [${AGENT_NAME} agent]: " AGENT_DESC
AGENT_DESC=${AGENT_DESC:-"${AGENT_NAME} agent"}

echo ""
echo "  Capabilities help the hub route tasks to the right agent."
echo "  Enter comma-separated keywords (e.g., coding,testing,shell)"
echo ""
read -p "  Capabilities [general]: " AGENT_CAPS
AGENT_CAPS=${AGENT_CAPS:-general}

# Sanitize inputs — strip characters that break JSON
sanitize() { echo "$1" | tr -d '"\\`$\n\r'; }
AGENT_NAME=$(sanitize "$AGENT_NAME")
AGENT_BINARY=$(sanitize "$AGENT_BINARY")
AGENT_DESC=$(sanitize "$AGENT_DESC")
WORKER_NAME=$(sanitize "$WORKER_NAME")
WORKER_DESC=$(sanitize "$WORKER_DESC")

# Build capabilities JSON array safely
IFS=',' read -ra CAP_ARRAY <<< "$AGENT_CAPS"
CAPS_JSON="["
for i in "${!CAP_ARRAY[@]}"; do
  cap=$(echo "${CAP_ARRAY[$i]}" | tr -d '"\\`$\n\r ' )
  if [ "$i" -gt 0 ]; then CAPS_JSON="$CAPS_JSON,"; fi
  CAPS_JSON="$CAPS_JSON\"$cap\""
done
CAPS_JSON="$CAPS_JSON]"

# Build WORKER_AGENTS JSON
AGENTS_JSON="[{\"name\":\"${AGENT_NAME}\",\"binary\":\"${AGENT_BINARY}\",\"args\":[],\"description\":\"${AGENT_DESC}\",\"capabilities\":${CAPS_JSON}}]"

# Step 6: Write .env
echo ""
echo -e "${BOLD}Step 6: Installing worker...${NC}"

{
  printf 'HUB_URL=%s\n' "$HUB_URL"
  printf 'PAIR_CODE=%s\n' "$PAIR_CODE"
  printf 'WORKER_NAME=%s\n' "$WORKER_NAME"
  printf 'WORKER_DESCRIPTION=%s\n' "$WORKER_DESC"
  printf 'WORKER_AGENTS=%s\n' "$AGENTS_JSON"
  if [ -n "$WS_SECRET" ]; then
    printf 'WS_SECRET=%s\n' "$WS_SECRET"
  fi
} > worker/.env

chmod 600 worker/.env

# Install + build
(cd sdk && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || true
echo -e "${GREEN}✓${NC} SDK built"

(cd worker && npm ci --silent && npm run build) 2>&1 | grep -v "^$" || true
echo -e "${GREEN}✓${NC} Worker built"

# Done
echo ""
echo -e "${BOLD}${GREEN}Worker ready!${NC}"
echo ""
echo -e "  Start the worker:  ${CYAN}cd worker && npm start${NC}"
echo ""
echo -e "  Then approve the pairing in Telegram (tap ✅ Approve)."
echo ""
echo -e "  After approval, the worker will auto-save its credentials."
echo -e "  Future restarts won't need a pairing code."
echo ""
