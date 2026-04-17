#!/usr/bin/env bash
#
# AnyAgent one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/GuilhermeBianeck/AnyAgent/main/packaging/sea/install.sh | bash
#
# Detects OS + arch, downloads the matching binary from the latest GitHub
# Release, verifies its SHA256, drops it at:
#
#   ~/.local/bin/anyagent   (default; falls back to /usr/local/bin if writable)
#
# Optional environment variables:
#   ANYAGENT_VERSION=v1.2.3    Install a specific release tag (default: latest)
#   ANYAGENT_BIN_DIR=/opt/bin  Install directory override
#   ANYAGENT_REPO=user/fork    Use a different source repo (default: upstream)

set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

REPO="${ANYAGENT_REPO:-GuilhermeBianeck/AnyAgent}"
VERSION="${ANYAGENT_VERSION:-latest}"

die() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# --- 1. detect OS / arch ------------------------------------------------------
case "$(uname -s)" in
  Darwin)  OS="darwin" ;;
  Linux)   OS="linux" ;;
  *) die "Unsupported OS: $(uname -s). Windows users: see docs/OPERATIONS.md." ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "Unsupported arch: $(uname -m)." ;;
esac

TRIPLE="${OS}-${ARCH}"
BIN_NAME="anyagent-${TRIPLE}"
echo -e "${BOLD}AnyAgent installer${NC}  (target: ${TRIPLE})"

# --- 2. pick install directory ------------------------------------------------
if [ -n "${ANYAGENT_BIN_DIR:-}" ]; then
  BIN_DIR="$ANYAGENT_BIN_DIR"
elif [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
elif [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  BIN_DIR="$HOME/.local/bin"
else
  die "No writable install directory. Set ANYAGENT_BIN_DIR=/path/you/can/write."
fi
echo -e "  install dir: ${CYAN}${BIN_DIR}${NC}"

# Path hint — the user might need to add BIN_DIR to $PATH
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo -e "  ${YELLOW}note:${NC} $BIN_DIR is not on your \$PATH. Add this to your shell rc:"
    echo -e "         ${DIM}export PATH=\"$BIN_DIR:\$PATH\"${NC}"
    ;;
esac

# --- 3. resolve latest version via GitHub API (if "latest") ------------------
if [ "$VERSION" = "latest" ]; then
  echo -en "  resolving latest release... "
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
  # Use -fsSL; fail on HTTP error so we don't silently install a stub.
  VERSION_JSON="$(curl -fsSL "$API_URL" 2>/dev/null || true)"
  if [ -z "$VERSION_JSON" ]; then
    die "Couldn't reach GitHub API. Set ANYAGENT_VERSION=v1.0.0 to pin a version."
  fi
  # Minimal JSON-parse via sed — avoids a jq dependency.
  VERSION=$(echo "$VERSION_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$VERSION" ]; then
    die "Couldn't parse latest release tag. Set ANYAGENT_VERSION=v1.0.0 explicitly."
  fi
  echo -e "${GREEN}${VERSION}${NC}"
fi

# --- 4. download binary + checksum -------------------------------------------
DL_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BIN_NAME}"
SUM_URL="${DL_URL}.sha256"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo -e "  downloading ${DIM}${DL_URL}${NC}"
curl -fsSL --progress-bar "$DL_URL" -o "$TMP_DIR/$BIN_NAME" || die "Download failed."

echo -en "  verifying checksum... "
if curl -fsSL "$SUM_URL" -o "$TMP_DIR/$BIN_NAME.sha256" 2>/dev/null; then
  EXPECTED="$(cut -d' ' -f1 "$TMP_DIR/$BIN_NAME.sha256")"
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP_DIR/$BIN_NAME" | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP_DIR/$BIN_NAME" | cut -d' ' -f1)"
  else
    echo -e "${YELLOW}skipped${NC} (no shasum/sha256sum)"; ACTUAL="$EXPECTED"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    die "SHA256 mismatch! expected $EXPECTED, got $ACTUAL"
  fi
  echo -e "${GREEN}ok${NC}"
else
  echo -e "${YELLOW}no .sha256 published — skipping integrity check${NC}"
fi

# --- 5. install ---------------------------------------------------------------
DEST="$BIN_DIR/anyagent"
chmod +x "$TMP_DIR/$BIN_NAME"
mv "$TMP_DIR/$BIN_NAME" "$DEST"

echo ""
echo -e "${BOLD}${GREEN}Installed:${NC} $DEST"
echo ""
"$DEST" --version || true
echo ""
echo -e "Next step:"
echo -e "  ${CYAN}anyagent quickstart${NC}       # hub + wire MCP config"
echo -e "  ${CYAN}anyagent --help${NC}"
