#!/usr/bin/env bash
# Uninstall AnyAgent system service.
#
# Usage:
#   ./packaging/uninstall-service.sh hub
#   ./packaging/uninstall-service.sh worker

set -e

COMPONENT="${1:-}"
if [ -z "$COMPONENT" ] || { [ "$COMPONENT" != "hub" ] && [ "$COMPONENT" != "worker" ]; }; then
  echo "Usage: $0 [hub|worker]" >&2
  exit 1
fi

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

OS="$(uname -s)"

if [ "$OS" = "Linux" ]; then
  UNIT="anyagent-$COMPONENT"
  if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
  $SUDO systemctl stop "$UNIT" 2>/dev/null || true
  $SUDO systemctl disable "$UNIT" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/$UNIT.service"
  $SUDO systemctl daemon-reload
  echo -e "${GREEN}✓${NC} $UNIT removed"
elif [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.anyagent.$COMPONENT.plist"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo -e "${GREEN}✓${NC} com.anyagent.$COMPONENT removed"
else
  echo -e "${YELLOW}Unsupported OS: $OS${NC}"
  exit 1
fi
