#!/bin/bash
set -euo pipefail

# V4 Agent Migration Script
# Safely removes legacy src/agents/ after V4 migration is complete.
# Run ONLY after verifying the build passes with V4 as the sole agent system.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LEGACY_DIR="$PROJECT_ROOT/src/agents"
V4_DIR="$PROJECT_ROOT/src/agents-v4"
BACKUP_DIR="$PROJECT_ROOT/.omc-migration-backup/agents-legacy"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== V4 Agent Migration Script ==="
echo ""

if [ ! -d "$V4_DIR" ]; then
  echo -e "${RED}ERROR: V4 directory not found at $V4_DIR${NC}"
  exit 1
fi

if [ ! -d "$LEGACY_DIR" ]; then
  echo -e "${YELLOW}Legacy directory already removed. Nothing to do.${NC}"
  exit 0
fi

echo "Pre-flight checks..."

echo -n "  Checking V4 files exist... "
REQUIRED_V4_FILES=(
  "types.ts" "tiers.ts" "roles.ts" "composer.ts" "registry.ts"
  "index.ts" "loader.ts" "system-prompt.ts" "context-manager.ts" "compat.ts"
)
for f in "${REQUIRED_V4_FILES[@]}"; do
  if [ ! -f "$V4_DIR/$f" ]; then
    echo -e "${RED}MISSING: $V4_DIR/$f${NC}"
    exit 1
  fi
done
echo -e "${GREEN}OK${NC}"

echo -n "  Checking build passes... "
if ! npm run build --prefix "$PROJECT_ROOT" > /dev/null 2>&1; then
  echo -e "${RED}FAIL - build must pass before migration${NC}"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

echo -n "  Checking no imports from src/agents/ remain... "
LEGACY_IMPORTS=$(grep -r "from ['\"].*agents/definitions" "$PROJECT_ROOT/src" \
  --include="*.ts" -l 2>/dev/null | grep -v "agents-v4" | grep -v "__tests__" || true)
if [ -n "$LEGACY_IMPORTS" ]; then
  echo -e "${RED}FAIL - legacy imports found in:${NC}"
  echo "$LEGACY_IMPORTS"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

echo ""
echo -e "${YELLOW}This will:"
echo "  1. Back up src/agents/ to $BACKUP_DIR"
echo "  2. Delete src/agents/ from the project"
echo -e "  3. Run build to verify${NC}"
echo ""

read -p "Continue? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "Step 1: Creating backup..."
mkdir -p "$(dirname "$BACKUP_DIR")"
cp -r "$LEGACY_DIR" "$BACKUP_DIR"
echo -e "  ${GREEN}Backed up to $BACKUP_DIR${NC}"

echo "Step 2: Removing legacy directory..."
rm -rf "$LEGACY_DIR"
echo -e "  ${GREEN}Removed $LEGACY_DIR${NC}"

echo "Step 3: Verifying build..."
if npm run build --prefix "$PROJECT_ROOT" > /dev/null 2>&1; then
  echo -e "  ${GREEN}Build passes!${NC}"
else
  echo -e "  ${RED}Build FAILED! Restoring backup...${NC}"
  cp -r "$BACKUP_DIR" "$LEGACY_DIR"
  echo -e "  ${YELLOW}Legacy directory restored. Please fix build errors first.${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}=== Migration Complete ===${NC}"
echo ""
echo "Backup location: $BACKUP_DIR"
echo "To remove backup: rm -rf $PROJECT_ROOT/.omc-migration-backup"
