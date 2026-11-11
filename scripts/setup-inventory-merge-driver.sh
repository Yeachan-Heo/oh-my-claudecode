#!/bin/bash
# Setup inventory-graph merge driver for #5010
# This script configures git to use a custom merge driver for inventory-graph.json
# to avoid merge conflicts by regenerating the file instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Setting up inventory-graph merge driver..."

# Configure merge driver in git config
git config merge.inventorygraph.driver "node $REPO_ROOT/scripts/merge-inventory-driver.mjs %O %A %B %P"

if [ $? -eq 0 ]; then
  echo "✓ Merge driver configured successfully"
  echo ""
  echo "Configuration:"
  git config merge.inventorygraph.driver
  echo ""
  echo "Note: .gitattributes has been updated to use this driver."
  echo "The merge driver will regenerate inventory-graph.json on merge conflicts."
else
  echo "✗ Failed to configure merge driver" >&2
  exit 1
fi
