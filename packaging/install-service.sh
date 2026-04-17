#!/usr/bin/env bash
# Install AnyAgent as a system service.
#
# Usage:
#   ./packaging/install-service.sh hub       # installs hub service
#   ./packaging/install-service.sh worker    # installs worker service
#
# Detects OS and picks systemd (Linux) or launchd (macOS).
# Templates /packaging/systemd/*.service or /packaging/launchd/*.plist with:
#   @USER@    — current user (systemd only)
#   @GROUP@   — current group (systemd only)
#   @WORKDIR@ — absolute path to AnyAgent checkout
#   @NODE@    — absolute path to the `node` binary
#
# Re-running is idempotent (overwrites the existing unit).

set -e

COMPONENT="${1:-}"
if [ -z "$COMPONENT" ] || { [ "$COMPONENT" != "hub" ] && [ "$COMPONENT" != "worker" ]; }; then
  echo "Usage: $0 [hub|worker]" >&2
  exit 1
fi

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo -e "${YELLOW}Node.js not on PATH. Install Node 20+ and re-run.${NC}" >&2
  exit 1
fi

# Sanity check: build output exists
DIST="$WORKDIR/$COMPONENT/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo -e "${YELLOW}Missing $DIST.${NC}"
  echo "  Build first:  (cd $COMPONENT && npm run build)"
  exit 1
fi

# Sanity check: .env exists (we reference it in the unit file)
ENVFILE="$WORKDIR/$COMPONENT/.env"
if [ ! -f "$ENVFILE" ]; then
  echo -e "${YELLOW}Missing $ENVFILE.${NC} Run ./setup.sh (hub) or ./add-worker.sh (worker) first."
  exit 1
fi

# Ensure log dir exists (launchd won't create it)
mkdir -p "$WORKDIR/$COMPONENT/logs"

OS="$(uname -s)"

if [ "$OS" = "Linux" ]; then
  # --- systemd ---
  if ! command -v systemctl >/dev/null 2>&1; then
    echo -e "${YELLOW}systemctl not found. This script only supports systemd on Linux.${NC}"
    echo "For other init systems, run manually:  $NODE_BIN $DIST"
    exit 1
  fi

  UNIT_SRC="$SCRIPT_DIR/systemd/anyagent-$COMPONENT.service"
  UNIT_DST="/etc/systemd/system/anyagent-$COMPONENT.service"

  echo -e "${BOLD}Installing systemd unit:${NC} $UNIT_DST"

  # Template the unit
  TMP_UNIT="$(mktemp)"
  sed \
    -e "s|@USER@|$(id -un)|g" \
    -e "s|@GROUP@|$(id -gn)|g" \
    -e "s|@WORKDIR@|$WORKDIR|g" \
    -e "s|@NODE@|$NODE_BIN|g" \
    "$UNIT_SRC" > "$TMP_UNIT"

  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  else
    SUDO="sudo"
    echo "  (sudo required to write to /etc/systemd/system)"
  fi

  $SUDO install -m 644 "$TMP_UNIT" "$UNIT_DST"
  rm -f "$TMP_UNIT"

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "anyagent-$COMPONENT"
  $SUDO systemctl restart "anyagent-$COMPONENT"

  echo -e "${GREEN}✓${NC} anyagent-$COMPONENT enabled and started"
  echo ""
  echo -e "  Status:  ${CYAN}systemctl status anyagent-$COMPONENT${NC}"
  echo -e "  Logs:    ${CYAN}journalctl -u anyagent-$COMPONENT -f${NC}"
  echo -e "  Stop:    ${CYAN}sudo systemctl stop anyagent-$COMPONENT${NC}"

elif [ "$OS" = "Darwin" ]; then
  # --- launchd ---
  PLIST_SRC="$SCRIPT_DIR/launchd/com.anyagent.$COMPONENT.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.anyagent.$COMPONENT.plist"

  echo -e "${BOLD}Installing launchd agent:${NC} $PLIST_DST"

  mkdir -p "$HOME/Library/LaunchAgents"

  sed \
    -e "s|@WORKDIR@|$WORKDIR|g" \
    -e "s|@NODE@|$NODE_BIN|g" \
    "$PLIST_SRC" > "$PLIST_DST"

  # Unload first (ignore failure — it may not be loaded yet)
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST"

  echo -e "${GREEN}✓${NC} com.anyagent.$COMPONENT loaded"
  echo ""
  echo -e "  Status:  ${CYAN}launchctl list | grep anyagent${NC}"
  echo -e "  Logs:    ${CYAN}tail -f $WORKDIR/$COMPONENT/logs/$COMPONENT.out.log${NC}"
  echo -e "  Stop:    ${CYAN}launchctl unload $PLIST_DST${NC}"

else
  echo -e "${YELLOW}Unsupported OS: $OS. Only Linux (systemd) and macOS (launchd) are supported.${NC}"
  exit 1
fi
