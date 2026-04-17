#!/usr/bin/env bash
set -euo pipefail

# packaging/sea/build.sh — build a Node 22 Single Executable Application for
# the host platform.
#
# Steps:
#   1. Ensure cli/ + hub/ npm deps are installed
#   2. esbuild bundle → build/main.cjs
#   3. node --experimental-sea-config → build/sea-prep.blob
#   4. Copy `node` binary to dist/anyagent-<os>-<arch>
#   5. postject the blob into the binary
#   6. On macOS: re-sign the binary
#
# Cross-compilation is NOT handled here — run this on the target host, or use
# .github/workflows/release.yml which spawns each platform's runner.
#
# Output: dist/anyagent-<os>-<arch>

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# --- detect target triple -----------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"     # darwin | linux
case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *)      echo "Unsupported OS: $OS (Windows: use release.yml)" >&2 ; exit 1 ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) echo "Unsupported arch: $ARCH" >&2 ; exit 1 ;;
esac
TRIPLE="${OS}-${ARCH}"

OUT_DIR="$REPO_ROOT/dist"
OUT_BIN="$OUT_DIR/anyagent-$TRIPLE"
mkdir -p "$OUT_DIR"

# --- sanity: Node 22+ ---------------------------------------------------------
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_V" -lt 22 ]; then
  echo "Node 22+ required to build SEA (need node:sea APIs). Current: $(node -v)" >&2
  exit 1
fi
echo -e "${GREEN}✓${NC} Node $(node -v)  target=$TRIPLE"

# --- deps ---------------------------------------------------------------------
if [ ! -d cli/node_modules ]; then
  echo -e "${DIM}installing cli deps...${NC}"
  (cd cli && npm ci --silent) || (cd cli && npm install --silent)
fi
if [ ! -d hub/node_modules ]; then
  echo -e "${DIM}installing hub deps...${NC}"
  (cd hub && npm ci --silent) || (cd hub && npm install --silent)
fi
# Worker deps include node-pty, whose prebuild we embed as a SEA asset. If
# node_modules is missing we install; if node-pty is missing specifically,
# npm will fetch the appropriate prebuild for this platform.
if [ ! -d worker/node_modules/node-pty ]; then
  echo -e "${DIM}installing worker deps (for node-pty prebuild)...${NC}"
  (cd worker && npm ci --silent) || (cd worker && npm install --silent)
fi

# --- locate the node-pty prebuild directory for this target ---------------
# On Unix we need two files: pty.node (addon) + spawn-helper (executable).
# On Windows node-pty uses a different stack (not shipped via SEA yet).
PREBUILD_DIR_REL="worker/node_modules/node-pty/prebuilds/${OS}-${ARCH}"
PTY_PREBUILD_ABS="$(cd "$REPO_ROOT/$PREBUILD_DIR_REL" 2>/dev/null && pwd)/pty.node"
SPAWN_HELPER_ABS="$(cd "$REPO_ROOT/$PREBUILD_DIR_REL" 2>/dev/null && pwd)/spawn-helper"
if [ ! -f "$PTY_PREBUILD_ABS" ] || [ ! -f "$SPAWN_HELPER_ABS" ]; then
  echo "node-pty prebuild missing for $OS-$ARCH." >&2
  echo "Looked in: $PREBUILD_DIR_REL" >&2
  echo "Available:" >&2
  ls "$REPO_ROOT/worker/node_modules/node-pty/prebuilds/" 2>&1 | sed 's/^/  /' >&2
  exit 1
fi
echo -e "${GREEN}✓${NC} pty.node prebuild: ${DIM}$PTY_PREBUILD_ABS${NC}"
echo -e "${GREEN}✓${NC} spawn-helper:      ${DIM}$SPAWN_HELPER_ABS${NC}"

# --- 1. typecheck cli (catch type errors before bundle) ----------------------
echo -e "${DIM}typecheck cli...${NC}"
(cd cli && npx tsc --noEmit)
echo -e "${GREEN}✓${NC} type-checked"

# --- 2. bundle ---------------------------------------------------------------
# bundle.mjs lives inside cli/ so it can resolve `import esbuild from 'esbuild'`
# against cli/node_modules. Run it from that directory.
echo -e "${DIM}bundling with esbuild...${NC}"
(cd "$REPO_ROOT/cli" && node bundle.mjs)

# --- 3. build SEA blob -------------------------------------------------------
# Write a platform-specific sea-config with the pty.node asset path injected.
# We keep the tracked sea-config.json minimal; this generated file lives in
# build/ and is gitignored.
GEN_CONFIG="$SCRIPT_DIR/build/sea-config.generated.json"
cat > "$GEN_CONFIG" <<EOF
{
  "main": "main.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true,
  "assets": {
    "pty.node": "$PTY_PREBUILD_ABS",
    "spawn-helper": "$SPAWN_HELPER_ABS"
  }
}
EOF

echo -e "${DIM}generating SEA blob (with pty.node asset)...${NC}"
(cd "$SCRIPT_DIR/build" && node --experimental-sea-config sea-config.generated.json)
echo -e "${GREEN}✓${NC} blob: $(du -h "$SCRIPT_DIR/build/sea-prep.blob" | cut -f1)"

# --- 4. copy `node` → target binary ------------------------------------------
NODE_BIN="$(command -v node)"
echo -e "${DIM}copying $NODE_BIN → $OUT_BIN${NC}"
cp "$NODE_BIN" "$OUT_BIN"
chmod +x "$OUT_BIN"

# --- 5. strip existing code signature on macOS (postject refuses otherwise) --
if [ "$OS" = "darwin" ]; then
  codesign --remove-signature "$OUT_BIN" 2>/dev/null || true
fi

# --- 6. postject the blob ----------------------------------------------------
echo -e "${DIM}injecting blob via postject...${NC}"
# postject is a peer dep; invoke via npx so we don't require it as a cli/
# dependency (the built binary doesn't need it).
POSTJECT_ARGS=(
  "$OUT_BIN"
  NODE_SEA_BLOB
  "$SCRIPT_DIR/build/sea-prep.blob"
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)
if [ "$OS" = "darwin" ]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi
npx --yes postject "${POSTJECT_ARGS[@]}"

# --- 7. re-sign on macOS -----------------------------------------------------
if [ "$OS" = "darwin" ]; then
  codesign --sign - "$OUT_BIN"
fi

SIZE=$(du -h "$OUT_BIN" | cut -f1)
echo ""
echo -e "${BOLD}${GREEN}Built:${NC} $OUT_BIN (${SIZE})"
echo -e "       try: ${DIM}$OUT_BIN --version${NC}"
