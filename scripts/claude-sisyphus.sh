#!/bin/bash
# Sisyphus Mode Wrapper for Claude CLI
# Enforces task completion discipline through system prompt injection

# Core Sisyphus enforcement prompt
SISYPHUS_PROMPT="You are in SISYPHUS MODE. You CANNOT stop with incomplete todos. ALWAYS use TodoWrite to track tasks. Mark complete IMMEDIATELY when done. Verify ALL work before stopping. The boulder never stops rolling until EVERY task reaches completion."

# Execute claude with appended system prompt, passing through all arguments
exec claude --append-system-prompt "$SISYPHUS_PROMPT" "$@"
