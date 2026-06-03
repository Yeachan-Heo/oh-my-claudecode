#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/.local/bin"
WRAPPER="$ROOT_DIR/scripts/venus-codex-wrapper.py"
TARGET="$BIN_DIR/codex"

mkdir -p "$BIN_DIR"
chmod +x "$WRAPPER"
ln -sf "$WRAPPER" "$TARGET"

cat <<EOF
Venus codex wrapper is ready.

1) Add the wrapper to PATH:
export PATH="$BIN_DIR:\$PATH"

2) Pick a default provider/model for OMC external workers:
export OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER="codex"
export OMC_CODEX_DEFAULT_MODEL="gpt-5.5"

Recommended mode: route through your OpenAI-compatible relay / ChatService
export OPENAI_BASE_URL="http://127.0.0.1:18810/v1"
export OPENAI_API_KEY="<your-chatservice-api-key>"

Alternative direct Venus mode:
export VENUS_API_TOKEN="<secret_id@group>"
export VENUS_LLMPROXY_URL="http://v2.open.venus.oa.com/llmproxy/chat/completions"

Quick tests:
  codex --version
  echo "Say hi in 3 words." | codex exec -m gpt-5.5 --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check

OMC examples:
  omc ask codex "Say hi in 3 words."
  omc team 1:codex "Review this project structure."
EOF
