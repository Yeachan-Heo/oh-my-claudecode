#!/bin/bash
# PSM Session Registry Management

# Lock file for atomic registry operations
PSM_LOCK_FILE="${PSM_DATA_DIR:-.psm}/.psm-lock"

# Wrapper for atomic operations with file locking
# Usage: psm_with_lock <command> [args...]
psm_with_lock() {
    local timeout="${PSM_LOCK_TIMEOUT:-5}"
    (
        flock -w "$timeout" 200 || {
            echo "error|Failed to acquire lock after ${timeout}s" >&2
            return 1
        }
        "$@"
    ) 200>"$PSM_LOCK_FILE"
}

# Internal: Add session to registry (must be called via psm_with_lock)
_psm_add_session_impl() {
    local id="$1"
    local type="$2"
    local project="$3"
    local ref="$4"
    local branch="$5"
    local base="$6"
    local tmux_session="$7"
    local worktree="$8"
    local source_repo="$9"
    local metadata="${10:-{}}"
    local provider="${11:-github}"
    local provider_ref="${12:-}"

    local now=$(date -Iseconds)

    local tmp=$(mktemp)
    jq --arg id "$id" \
       --arg type "$type" \
       --arg project "$project" \
       --arg ref "$ref" \
       --arg branch "$branch" \
       --arg base "$base" \
       --arg tmux "$tmux_session" \
       --arg worktree "$worktree" \
       --arg source "$source_repo" \
       --arg now "$now" \
       --arg provider "$provider" \
       --arg provider_ref "$provider_ref" \
       --argjson meta "$metadata" \
       '.sessions[$id] = {
          "id": $id,
          "type": $type,
          "project": $project,
          "ref": $ref,
          "branch": $branch,
          "base": $base,
          "tmux": $tmux,
          "worktree": $worktree,
          "source_repo": $source,
          "created_at": $now,
          "last_accessed": $now,
          "state": "active",
          "provider": $provider,
          "provider_ref": $provider_ref,
          "metadata": $meta
        } | .stats.total_created += 1' \
       "$PSM_SESSIONS" > "$tmp" && mv "$tmp" "$PSM_SESSIONS"
}

# Add session to registry (with file locking)
# Usage: psm_add_session <id> <type> <project> <ref> <branch> <base> <tmux> <worktree> <source_repo> <metadata_json> [provider] [provider_ref]
psm_add_session() {
    psm_with_lock _psm_add_session_impl "$@"
}

# Get session by ID
# Usage: psm_get_session <id>
psm_get_session() {
    local id="$1"
    jq -r --arg i "$id" '.sessions[$i] // empty' "$PSM_SESSIONS"
}

# Internal: Update session state (must be called via psm_with_lock)
_psm_update_session_state_impl() {
    local id="$1"
    local state="$2"
    local now=$(date -Iseconds)

    local tmp=$(mktemp)
    jq --arg id "$id" \
       --arg state "$state" \
       --arg now "$now" \
       '.sessions[$id].state = $state | .sessions[$id].last_accessed = $now' \
       "$PSM_SESSIONS" > "$tmp" && mv "$tmp" "$PSM_SESSIONS"
}

# Update session state (with file locking)
# Usage: psm_update_session_state <id> <state>
psm_update_session_state() {
    psm_with_lock _psm_update_session_state_impl "$@"
}

# Internal: Remove session from registry (must be called via psm_with_lock)
_psm_remove_session_impl() {
    local id="$1"

    local tmp=$(mktemp)
    jq --arg id "$id" \
       'del(.sessions[$id]) | .stats.total_cleaned += 1' \
       "$PSM_SESSIONS" > "$tmp" && mv "$tmp" "$PSM_SESSIONS"
}

# Remove session from registry (with file locking)
# Usage: psm_remove_session <id>
psm_remove_session() {
    psm_with_lock _psm_remove_session_impl "$@"
}

# List all sessions
# Usage: psm_list_sessions [project]
psm_list_sessions() {
    local project="$1"

    if [[ -n "$project" ]]; then
        jq -r --arg p "$project" '.sessions | to_entries[] | select(.value.project == $p) | .value | "\(.id)|\(.type)|\(.state)|\(.worktree)"' "$PSM_SESSIONS"
    else
        jq -r '.sessions | to_entries[] | .value | "\(.id)|\(.type)|\(.state)|\(.worktree)"' "$PSM_SESSIONS"
    fi
}

# Get sessions by state
psm_get_sessions_by_state() {
    local state="$1"
    jq -r --arg s "$state" '.sessions | to_entries[] | select(.value.state == $s) | .value.id' "$PSM_SESSIONS"
}

# Get session count
psm_session_count() {
    jq -r '.sessions | length' "$PSM_SESSIONS"
}

# Write session metadata file in worktree
# Usage: psm_write_session_metadata <worktree_path> <session_json>
psm_write_session_metadata() {
    local worktree_path="$1"
    local session_json="$2"

    echo "$session_json" > "${worktree_path}/.psm-session.json"
}

# Read session metadata from worktree
psm_read_session_metadata() {
    local worktree_path="$1"
    local meta_file="${worktree_path}/.psm-session.json"

    if [[ -f "$meta_file" ]]; then
        cat "$meta_file"
    fi
}

# Get all session IDs for cleanup check
psm_get_review_sessions() {
    jq -r '.sessions | to_entries[] | select(.value.type == "review") | "\(.value.id)|\(.value.metadata.pr_number // empty)|\(.value.project)"' "$PSM_SESSIONS"
}

psm_get_fix_sessions() {
    jq -r '.sessions | to_entries[] | select(.value.type == "fix") | "\(.value.id)|\(.value.metadata.issue_number // empty)|\(.value.project)"' "$PSM_SESSIONS"
}
