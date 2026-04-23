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

# Capability preset per known CLI. Comma-separated tags — the routing layer
# matches intent keywords against these.
declare_preset() {
  case "$1" in
    claude)  echo "coding,refactoring,testing,shell" ;;
    codex)   echo "coding,review,refactoring" ;;
    ollama)  echo "llm,chat,local" ;;
    aider)   echo "coding,git,refactoring" ;;
    gemini)  echo "coding,chat" ;;
    bash)    echo "shell,scripts,ops" ;;
    python3) echo "scripting,data" ;;
    *)       echo "general" ;;
  esac
}

# One-shot arg preset per known CLI. AnyAgent spawns each CLI in PTY-one-shot
# mode: intent goes in via stdin (worker appends Ctrl+D so EOF-readers like
# `codex exec` actually process), result streams back, process exits. These
# args put each CLI into its print-and-exit mode:
#   codex exec --skip-git-repo-check -   # `-` ⇒ read prompt from stdin,
#                                         #   --skip-git-repo-check lets codex
#                                         #   run outside a git repo ($HOME)
#   claude -p                            # Claude "print mode"
# Elements are JSON-quoted strings, comma-separated; assembled into the
# final WORKER_AGENTS JSON further down.
args_preset() {
  case "$1" in
    claude)  echo '"-p"' ;;
    codex)   echo '"exec","--skip-git-repo-check","-"' ;;
    gemini)  echo '"-p"' ;;
    aider)   echo '"--yes","--no-pretty"' ;;
    *)       echo "" ;;
  esac
}

# Sanitise a free-form model name (e.g. "llama3.1:8b") into something legal
# as an MCP tool suffix: lowercase, alphanum-or-underscore only. The same
# routine is applied in mcpSafe() on the hub side, but we do it here so the
# WORKER_AGENTS JSON that the hub stores has the right shape from the start.
sanitize_model_id() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '_' | sed 's/^_*//; s/_*$//'
}

# Probe `ollama list` to find downloaded models. Each line after the header
# starts with a model id like "llama3.1:8b" — the second token is the SHA.
# Empty string when ollama is absent OR no models are present.
probe_ollama_models() {
  if ! command -v ollama >/dev/null 2>&1; then return; fi
  ollama list 2>/dev/null | awk 'NR>1 && NF>0 {print $1}' | head -20
}

# Build a single-agent JSON object from a spec. Specs we understand:
#   - bare CLI: `claude`, `codex`, `aider`, `gemini`, `bash`, `python3`
#   - ollama model: `ollama:llama3.1:8b` → agent "ollama-llama3_1_8b"
# The result is a JSON object (not an array) — the caller joins them into the
# WORKER_AGENTS JSON array.
build_agent_json() {
  local spec="$1"
  local binary name args caps model
  if [[ "$spec" == ollama:* ]]; then
    model="${spec#ollama:}"
    binary="ollama"
    name="ollama-$(sanitize_model_id "$model")"
    # `ollama run <model>` is one-shot when stdin is piped AND closed — matches
    # AnyAgent's PTY+EOF spawn pattern. The worker sends Ctrl+D after the intent.
    args="\"run\",\"${model}\""
    caps="llm,chat,local,${model%%:*}"
  else
    binary="$spec"
    name="$spec"
    args=$(args_preset "$spec")
    caps=$(declare_preset "$spec")
  fi

  # Build capabilities JSON array from the comma-separated preset
  local caps_json="["
  local first=1
  local cap
  local CAP_ARR
  IFS=',' read -ra CAP_ARR <<< "$caps"
  for cap in "${CAP_ARR[@]}"; do
    cap=$(echo "$cap" | tr -d '"\\`$\n\r ')
    [ -z "$cap" ] && continue
    [ "$first" -eq 0 ] && caps_json="$caps_json,"
    caps_json="$caps_json\"$cap\""
    first=0
  done
  caps_json="$caps_json]"

  local desc_text
  if [[ "$spec" == ollama:* ]]; then
    desc_text="ollama ${model} on $(hostname -s 2>/dev/null || hostname)"
  else
    desc_text="${name} on $(hostname -s 2>/dev/null || hostname)"
  fi

  printf '{"name":"%s","binary":"%s","args":[%s],"description":"%s","capabilities":%s}' \
    "$name" "$binary" "$args" "$desc_text" "$caps_json"
}

# Assemble the WORKER_AGENTS JSON array from a comma-separated spec list.
build_agents_json() {
  local binaries="$1"
  local out="["
  local first=1
  local spec
  local BIN_ARR
  IFS=',' read -ra BIN_ARR <<< "$binaries"
  for spec in "${BIN_ARR[@]}"; do
    spec=$(echo "$spec" | tr -d ' ')
    [ -z "$spec" ] && continue
    [ "$first" -eq 0 ] && out="$out,"
    out="$out$(build_agent_json "$spec")"
    first=0
  done
  out="$out]"
  printf '%s' "$out"
}

# Build the list of candidate specs we can show in the interactive picker:
# one entry per CLI on PATH, plus one entry per downloaded ollama model.
CANDIDATES="claude codex aider gemini bash python3"
DETECTED_SPECS=()
for bin in $CANDIDATES; do
  if command -v "$bin" >/dev/null 2>&1; then
    DETECTED_SPECS+=("$bin")
    echo -e "  ${GREEN}✓${NC} ${bin} (at $(command -v "$bin"))"
  fi
done
# Ollama: one agent per downloaded model, not one lumpy "ollama" agent.
if command -v ollama >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} ollama (at $(command -v ollama))"
  _ollama_models=$(probe_ollama_models)
  if [ -n "$_ollama_models" ]; then
    while IFS= read -r m; do
      [ -z "$m" ] && continue
      DETECTED_SPECS+=("ollama:$m")
      echo -e "      ${DIM}↳ ${m}${NC}"
    done <<< "$_ollama_models"
  else
    echo -e "      ${YELLOW}(no models downloaded — run \`ollama pull <model>\` first)${NC}"
  fi
fi

if [ "${#DETECTED_SPECS[@]}" -eq 0 ]; then
  echo -e "  ${YELLOW}No known AI CLIs detected on PATH.${NC}"
  echo "  You can still declare one manually via AGENT_BINARIES=<name> and re-run with --non-interactive."
fi

# --- Pick which agents to declare ------------------------------------------

# AGENT_BINARIES is the v2.1 multi-agent entrypoint. Accepts a comma-separated
# list of specs (see build_agent_json). AGENT_BINARY is the v2.0 legacy single-
# agent fallback. If neither is set in non-interactive mode, default to every
# detected spec.
SELECTED_SPECS=()
if [ -n "${AGENT_BINARIES:-}" ]; then
  IFS=',' read -ra SELECTED_SPECS <<< "$AGENT_BINARIES"
elif [ -n "${AGENT_BINARY:-}" ]; then
  SELECTED_SPECS=("$AGENT_BINARY")
elif [ "$NONINTERACTIVE" = "1" ]; then
  if [ "${#DETECTED_SPECS[@]}" -gt 0 ]; then
    SELECTED_SPECS=("${DETECTED_SPECS[@]}")
  else
    SELECTED_SPECS=("claude") # last-ditch default
  fi
else
  # Interactive multi-select menu.
  echo ""
  echo "  Pick agents to expose (comma-separated numbers, or Enter for all detected):"
  for i in "${!DETECTED_SPECS[@]}"; do
    echo "    $((i+1))) ${DETECTED_SPECS[$i]}"
  done
  read -p "  Selection: " _picks
  if [ -z "$_picks" ]; then
    SELECTED_SPECS=("${DETECTED_SPECS[@]}")
  else
    IFS=',' read -ra _pick_arr <<< "$_picks"
    for _p in "${_pick_arr[@]}"; do
      _p=$(echo "$_p" | tr -d ' ')
      # Allow free-form specs too (e.g. the user types "ollama:gemma2" directly)
      if [[ "$_p" =~ ^[0-9]+$ ]]; then
        _idx=$((_p-1))
        if [ "$_idx" -ge 0 ] && [ "$_idx" -lt "${#DETECTED_SPECS[@]}" ]; then
          SELECTED_SPECS+=("${DETECTED_SPECS[$_idx]}")
        fi
      elif [ -n "$_p" ]; then
        SELECTED_SPECS+=("$_p")
      fi
    done
  fi
fi

if [ "${#SELECTED_SPECS[@]}" -eq 0 ]; then
  die "No agents selected. Set AGENT_BINARIES or AGENT_BINARY, or pick from the menu." "no-agents-selected"
fi

# Health-check every selected binary; warn but don't fail for missing ones — the
# user might install later, and the worker reports spawn errors on first use.
echo ""
echo -e "  ${BOLD}Declaring:${NC}"
for spec in "${SELECTED_SPECS[@]}"; do
  spec=$(echo "$spec" | tr -d ' ')
  [ -z "$spec" ] && continue
  if [[ "$spec" == ollama:* ]]; then
    MODEL_ID="${spec#ollama:}"
    if command -v ollama >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC} ollama-$(sanitize_model_id "$MODEL_ID") ${DIM}(model=${MODEL_ID})${NC}"
    else
      echo -e "    ${YELLOW}⚠${NC}  ollama-$(sanitize_model_id "$MODEL_ID") — ollama not on PATH, spawns will fail until installed"
    fi
  else
    if command -v "$spec" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC} ${spec}"
    else
      echo -e "    ${YELLOW}⚠${NC}  ${spec} not on PATH — worker will error on spawn until installed"
    fi
  fi
done

# Sanitize worker-identity strings — strip chars that would break JSON encoding.
sanitize() { echo "$1" | tr -d '"\\`$\n\r'; }
WORKER_NAME=$(sanitize "$WORKER_NAME")
WORKER_DESC=$(sanitize "$WORKER_DESC")

# Build the final array. Joined via commas; no trailing comma; no blanks.
_joined=$(IFS=','; echo "${SELECTED_SPECS[*]}")
AGENTS_JSON=$(build_agents_json "$_joined")

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
