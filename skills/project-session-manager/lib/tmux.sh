#!/usr/bin/env bash
# PSM Tmux Session Management

# Check if tmux is available
psm_has_tmux() {
    command -v tmux &> /dev/null
}

# Canonical tmux-safe session-name contract (issue #3528).
# tmux reserves ':' and '.' in target names (the "session:window.pane" syntax)
# and silently rewrites them inside session names, which orphans any PSM session
# whose requested name still contained them. This is the single source of truth
# for translating a PSM logical name into the name tmux will actually use; it
# MUST be applied at every tmux boundary. Translation is idempotent, so it is
# safe to call on names that are already tmux-safe (e.g. old registry entries).
psm_tmux_safe_name() {
    local name="$1"
    printf '%s' "${name//[.:]/_}"
}

# Build the canonical tmux session name for a PSM public session id
# (e.g. "omc:pr-123" -> "psm_omc_pr-123"). The colon-form id remains the
# human-facing identifier in sessions.json and on the CLI.
psm_tmux_name_from_id() {
    psm_tmux_safe_name "psm:${1}"
}

# Create a tmux session
# Usage: psm_create_tmux_session <session_name> <working_dir>
psm_create_tmux_session() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local working_dir="$2"

    if ! psm_has_tmux; then
        echo "error|tmux not found"
        return 1
    fi

    # Check if session already exists
    if tmux has-session -t "$session_name" 2>/dev/null; then
        echo "exists|$session_name"
        return 1
    fi

    # Create detached session
    tmux new-session -d -s "$session_name" -c "$working_dir" 2>/dev/null || {
        echo "error|Failed to create tmux session"
        return 1
    }

    # Fail closed: verify the session exists under the exact name PSM will use
    # for later lookups (issue #3528). If tmux rewrote the name, every later
    # has-session / send-keys / kill / attach would silently miss.
    if ! tmux has-session -t "$session_name" 2>/dev/null; then
        echo "error|tmux session not found after create: $session_name"
        return 1
    fi

    echo "created|$session_name"
    return 0
}

# Launch Claude Code in tmux session, optionally injecting either a context-file
# trigger prompt or a literal initial prompt.
# Usage: psm_launch_claude <session_name> [initial_context]
# initial_context may be either:
#   - a path relative to the worktree root (e.g. .psm/review.md), or
#   - a literal prompt string to send after Claude boots.
#
# Passes --dangerously-skip-permissions so the session does not stall on
# directory-trust or repeated tool-approval prompts (issue #2508).
# Set PSM_CLAUDE_STARTUP_DELAY (default: 5s) to tune literal-prompt delivery.
psm_launch_claude() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local initial_context="${2:-}"

    if ! tmux has-session -t "$session_name" 2>/dev/null; then
        echo "error|Session not found: $session_name"
        return 1
    fi

    # --dangerously-skip-permissions bypasses both the directory-trust prompt and
    # every per-tool approval prompt. Without this flag, unattended PSM sessions
    # can block indefinitely on the first tool call (issue #2508).
    tmux send-keys -t "$session_name" "claude --dangerously-skip-permissions" Enter

    if [[ -n "$initial_context" ]]; then
        local session_path=""
        session_path=$(tmux display-message -p -t "$session_name" '#{pane_current_path}' 2>/dev/null || true)

        # If the second arg resolves to a file in the worktree, preserve the
        # existing context-file flow. Otherwise treat it as a literal prompt.
        if [[ -n "$session_path" && -f "$session_path/$initial_context" ]]; then
            psm_inject_prompt "$session_name" "$initial_context"
        else
            local startup_delay="${PSM_CLAUDE_STARTUP_DELAY:-5}"
            (
                sleep "$startup_delay"
                tmux send-keys -t "$session_name" -l -- "$initial_context" 2>/dev/null || true
                tmux send-keys -t "$session_name" Enter 2>/dev/null || true
            ) &
        fi
    fi

    echo "launched|$session_name"
    return 0
}

# Render a PSM template file by substituting {{KEY}} placeholders.
# Usage: psm_render_template <template_file> [KEY=VALUE ...]
# Outputs rendered content to stdout; returns 1 if template not found.
psm_render_template() {
    local template_file="$1"
    shift

    if [[ ! -f "$template_file" ]]; then
        echo "error|Template not found: $template_file" >&2
        return 1
    fi

    local content
    content=$(cat "$template_file")

    for assignment in "$@"; do
        local key="${assignment%%=*}"
        local value="${assignment#*=}"
        # Bash parameter expansion handles multiline values safely
        content="${content//\{\{${key}\}\}/$value}"
    done

    printf '%s\n' "$content"
}

# Returns 0 if the captured pane text shows Claude's interactive input prompt.
# Matches '>' (standard prompt) or '?' (trust prompt) as the sole content of a line.
# Usage: _psm_pane_has_claude_prompt <pane_text>
_psm_pane_has_claude_prompt() {
    local pane_text="$1"
    printf '%s' "$pane_text" | grep -qE '^[[:space:]]*(>|\?)[[:space:]]*$'
}

# Poll the tmux pane until Claude's REPL prompt appears.
# Usage: psm_wait_for_claude_prompt <session_name> [max_seconds]
# Returns 0 when prompt detected; 1 on timeout.
psm_wait_for_claude_prompt() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local max_wait="${2:-30}"
    local waited=0

    while [[ $waited -lt $max_wait ]]; do
        local pane_content
        pane_content=$(tmux capture-pane -t "$session_name" -p 2>/dev/null) || return 1
        if _psm_pane_has_claude_prompt "$pane_content"; then
            return 0
        fi
        sleep 1
        (( waited++ )) || true
    done

    return 1
}

# Wait for Claude's REPL to be ready then inject a context-file trigger prompt.
# Non-fatal: warns on timeout but does not fail the session creation.
# Usage: psm_inject_prompt <session_name> <context_file_relative_path>
psm_inject_prompt() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local context_file="$2"

    if ! psm_wait_for_claude_prompt "$session_name"; then
        echo "warn|Timed out waiting for Claude prompt; task context not injected" >&2
        return 0
    fi

    local trigger="Read ${context_file} for full task context, then begin."

    # Use literal mode (-l) to prevent tmux from interpreting key names in the text
    tmux send-keys -t "$session_name" -l -- "$trigger"
    sleep 0.15
    tmux send-keys -t "$session_name" Enter

    return 0
}

# Kill a tmux session
# Usage: psm_kill_tmux_session <session_name>
psm_kill_tmux_session() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")

    if ! tmux has-session -t "$session_name" 2>/dev/null; then
        echo "not_found|$session_name"
        return 0
    fi

    tmux kill-session -t "$session_name" 2>/dev/null || {
        echo "error|Failed to kill session"
        return 1
    }

    echo "killed|$session_name"
    return 0
}

# List all PSM tmux sessions
psm_list_tmux_sessions() {
    if ! psm_has_tmux; then
        return 0
    fi

    tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}" 2>/dev/null | grep "^psm_" || true
}

# Check if a tmux session exists
# Usage: psm_tmux_session_exists <session_name>
psm_tmux_session_exists() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    tmux has-session -t "$session_name" 2>/dev/null
}

# Get current tmux session name
psm_current_tmux_session() {
    if [[ -n "$TMUX" ]]; then
        tmux display-message -p "#{session_name}" 2>/dev/null
    fi
}

# Generate tmux session name
# Usage: psm_tmux_session_name <alias> <type> <id>
psm_tmux_session_name() {
    local alias="$1"
    local type="$2"
    local id="$3"

    psm_tmux_name_from_id "${alias}:${type}-${id}"
}
