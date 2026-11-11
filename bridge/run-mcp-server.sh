#!/bin/bash
# MCP Server wrapper that ensures global npm modules are resolvable
# This enables @ast-grep/napi and other globally-installed native modules

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Add global npm modules to NODE_PATH for native module resolution
GLOBAL_NPM_ROOT="$(npm root -g 2>/dev/null)"
if [ -n "$GLOBAL_NPM_ROOT" ]; then
  export NODE_PATH="${GLOBAL_NPM_ROOT}:${NODE_PATH:-}"
fi

exec node "$SCRIPT_DIR/mcp-server.cjs"
