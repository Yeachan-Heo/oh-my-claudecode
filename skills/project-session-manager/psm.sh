#!/bin/bash
# Project Session Manager (PSM) - Main Script
# Usage: psm.sh <command> [args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source library files
source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/parse.sh"
source "$SCRIPT_DIR/lib/worktree.sh"
source "$SCRIPT_DIR/lib/tmux.sh"
source "$SCRIPT_DIR/lib/session.sh"

# Source provider files
source "$SCRIPT_DIR/lib/providers/interface.sh"
source "$SCRIPT_DIR/lib/providers/github.sh"
source "$SCRIPT_DIR/lib/providers/jira.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
log_info() { echo -e "${BLUE}[PSM]${NC} $*"; }
log_success() { echo -e "${GREEN}[PSM]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[PSM]${NC} $*"; }
log_error() { echo -e "${RED}[PSM]${NC} $*" >&2; }

# Check dependencies
check_dependencies() {
    local missing=()

    if ! command -v git &> /dev/null; then
        missing+=("git")
    fi

    if ! command -v jq &> /dev/null; then
        missing+=("jq")
    fi

    # Note: gh and jira are checked per-operation, not globally
    # This allows users without gh to still use Jira, and vice versa

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing[*]}"
        log_info "Install with:"
        log_info "  Ubuntu/Debian: sudo apt install git jq"
        log_info "  macOS: brew install git jq"
        exit 1
    fi

    # tmux is optional but warn if missing
    if ! command -v tmux &> /dev/null; then
        log_warn "tmux not found. Sessions will be created without tmux."
    fi
}

# Print usage
usage() {
    cat << 'EOF'
Project Session Manager (PSM) - Isolated dev environments

Usage: psm <command> [args...]

Commands:
  review <ref>           Create PR review session
  fix <ref>              Create issue fix session
  feature <proj> <name>  Create feature development session
  list [project]         List active sessions
  attach <session>       Attach to existing session
  kill <session>         Kill and cleanup session
  cleanup [--force]      Clean merged PRs and closed issues
  status                 Show current session info

Reference formats:
  omc#123               Project alias + number
  owner/repo#123        Full GitHub reference
  https://...           GitHub URL
  #123                  Number only (uses current repo)

Examples:
  psm review omc#123
  psm fix Yeachan-Heo/oh-my-claudecode#42
  psm feature omc add-webhooks
  psm list
  psm attach omc:pr-123
  psm kill omc:pr-123
  psm cleanup
EOF
}

# Command: review
cmd_review() {
    local ref="$1"
    local no_claude="${2:-false}"
    local no_tmux="${3:-false}"

    log_info "Parsing reference: $ref"

    # Parse reference
    local parsed
    parsed=$(psm_parse_ref "$ref")
    if [[ $? -ne 0 ]] || [[ "$parsed" == error* ]]; then
        log_error "Failed to parse reference: $ref"
        return 1
    fi

    IFS='|' read -r type alias repo pr_number local_path base provider provider_ref <<< "$parsed"

    # Provider guard: Jira doesn't have PRs
    if [[ "$provider" == "jira" ]]; then
        log_error "Jira issues cannot be 'reviewed' - Jira has no PR concept."
        log_info "Use 'psm fix $ref' to work on a Jira issue instead."
        log_info "Jira integration supports: fix, feature"
        return 1
    fi

    # Check GitHub CLI availability
    if ! provider_github_available; then
        log_error "GitHub CLI (gh) not found. Install: brew install gh"
        return 1
    fi

    if [[ -z "$repo" ]]; then
        log_error "Could not determine repository"
        return 1
    fi

    log_info "Fetching PR #${pr_number} from ${repo}..."

    # Fetch PR info
    local pr_info
    pr_info=$(provider_call "github" fetch_pr "$pr_number" "$repo") || {
        log_error "Failed to fetch PR #${pr_number}. Check if the PR exists and you have access."
        return 1
    }

    local pr_title=$(echo "$pr_info" | jq -r '.title')
    local pr_author=$(echo "$pr_info" | jq -r '.author.login')
    local head_branch=$(echo "$pr_info" | jq -r '.headRefName')
    local base_branch=$(echo "$pr_info" | jq -r '.baseRefName')
    local pr_url=$(echo "$pr_info" | jq -r '.url')

    log_info "PR: #${pr_number} - ${pr_title}"
    log_info "Author: @${pr_author}"
    log_info "Branch: ${head_branch} -> ${base_branch}"

    # Determine alias if not set
    if [[ -z "$alias" ]]; then
        alias=$(echo "$repo" | tr '/' '-')
    fi

    # Determine local path
    if [[ -z "$local_path" || ! -d "$local_path" ]]; then
        # Clone if needed
        local_path="${HOME}/Workspace/$(basename "$repo")"
        if [[ ! -d "$local_path" ]]; then
            log_info "Cloning repository to $local_path..."
            local clone_url
            clone_url=$(provider_call "github" clone_url "$repo")
            git clone "$clone_url" "$local_path" || {
                log_error "Failed to clone repository"
                return 1
            }
        fi
    fi

    # Create worktree
    log_info "Creating worktree..."
    local worktree_result
    worktree_result=$(psm_create_pr_worktree "$local_path" "$alias" "$pr_number" "$head_branch")

    local worktree_status
    local worktree_path
    IFS='|' read -r worktree_status worktree_path <<< "$worktree_result"

    if [[ "$worktree_status" == "exists" ]]; then
        log_warn "Worktree already exists at $worktree_path"
        log_info "Use 'psm attach ${alias}:pr-${pr_number}' to attach"
        return 0
    elif [[ "$worktree_status" == "error" ]]; then
        log_error "Failed to create worktree: $worktree_path"
        return 1
    fi

    log_success "Worktree created at $worktree_path"

    # Create tmux session
    local session_name="psm:${alias}:pr-${pr_number}"
    local session_id="${alias}:pr-${pr_number}"

    if [[ "$no_tmux" != "true" ]]; then
        log_info "Creating tmux session..."
        local tmux_result
        tmux_result=$(psm_create_tmux_session "$session_name" "$worktree_path")

        local tmux_status
        IFS='|' read -r tmux_status _ <<< "$tmux_result"

        if [[ "$tmux_status" == "error" ]]; then
            log_warn "Could not create tmux session. Continuing without tmux."
        elif [[ "$tmux_status" == "exists" ]]; then
            log_warn "Tmux session already exists"
        else
            log_success "Tmux session created: $session_name"

            # Launch Claude Code
            if [[ "$no_claude" != "true" ]]; then
                log_info "Launching Claude Code..."
                psm_launch_claude "$session_name"
            fi
        fi
    fi

    # Create session metadata
    local metadata=$(cat << EOF
{
  "pr_number": $pr_number,
  "pr_title": $(echo "$pr_title" | jq -R .),
  "pr_author": "$pr_author",
  "pr_url": "$pr_url"
}
EOF
)

    # Add to registry
    psm_add_session "$session_id" "review" "$alias" "pr-${pr_number}" "$head_branch" "$base_branch" "$session_name" "$worktree_path" "$local_path" "$metadata" "github" "${repo}#${pr_number}"

    # Output summary
    echo ""
    log_success "Session ready!"
    echo ""
    echo "  ID:       $session_id"
    echo "  Type:     review"
    echo "  PR:       #${pr_number} - ${pr_title}"
    echo "  Worktree: $worktree_path"
    echo "  Tmux:     $session_name"
    echo ""
    echo "Commands:"
    echo "  Attach:   tmux attach -t $session_name"
    echo "  Kill:     psm kill $session_id"
    echo "  Cleanup:  psm cleanup"
    echo ""
}

# Command: fix
cmd_fix() {
    local ref="$1"
    local no_claude="${2:-false}"

    log_info "Parsing reference: $ref"

    local parsed
    parsed=$(psm_parse_ref "$ref")
    if [[ $? -ne 0 ]] || [[ "$parsed" == error* ]]; then
        log_error "Failed to parse reference: $ref"
        return 1
    fi

    IFS='|' read -r type alias repo issue_number local_path base provider provider_ref <<< "$parsed"

    # Check provider CLI availability
    if [[ "$provider" == "jira" ]]; then
        if ! provider_jira_available; then
            log_error "Jira CLI not found. Install: brew install ankitpokhrel/jira-cli/jira-cli"
            return 1
        fi
    else
        if ! provider_github_available; then
            log_error "GitHub CLI (gh) not found. Install: brew install gh"
            return 1
        fi
    fi

    if [[ -z "$repo" && "$provider" != "jira" ]]; then
        log_error "Could not determine repository"
        return 1
    fi

    log_info "Fetching issue #${issue_number}..."

    # Fetch issue info
    local issue_info
    if [[ "$provider" == "jira" ]]; then
        issue_info=$(provider_call "jira" fetch_issue "$provider_ref") || {
            log_error "Failed to fetch Jira issue ${provider_ref}"
            return 1
        }
        local issue_title=$(echo "$issue_info" | jq -r '.fields.summary')
        local issue_url=$(echo "$issue_info" | jq -r '.self // empty')
    else
        issue_info=$(provider_call "github" fetch_issue "$issue_number" "$repo") || {
            log_error "Failed to fetch issue #${issue_number}"
            return 1
        }
        local issue_title=$(echo "$issue_info" | jq -r '.title')
        local issue_url=$(echo "$issue_info" | jq -r '.url')
    fi
    local slug=$(psm_slugify "$issue_title" 20)

    log_info "Issue: #${issue_number} - ${issue_title}"

    # Determine alias
    if [[ -z "$alias" ]]; then
        alias=$(echo "$repo" | tr '/' '-')
    fi

    # Determine local path
    if [[ -z "$local_path" || ! -d "$local_path" ]]; then
        local_path="${HOME}/Workspace/$(basename "${repo:-$alias}")"
        if [[ ! -d "$local_path" ]]; then
            log_info "Cloning repository..."
            local clone_url
            if [[ "$provider" == "jira" ]]; then
                clone_url=$(provider_call "jira" clone_url "$alias") || {
                    log_error "Failed to get clone URL for '$alias'. Configure 'repo' or 'clone_url' in projects.json"
                    return 1
                }
            else
                clone_url=$(provider_call "github" clone_url "$repo")
            fi
            git clone "$clone_url" "$local_path" || return 1
        fi
    fi

    # Create worktree
    log_info "Creating worktree and branch..."
    local worktree_result
    worktree_result=$(psm_create_issue_worktree "$local_path" "$alias" "$issue_number" "$slug" "$base")

    local worktree_status worktree_path branch_name
    IFS='|' read -r worktree_status worktree_path branch_name <<< "$worktree_result"

    if [[ "$worktree_status" == "exists" ]]; then
        log_warn "Worktree already exists at $worktree_path"
        return 0
    elif [[ "$worktree_status" == "error" ]]; then
        log_error "Failed to create worktree: $worktree_path"
        return 1
    fi

    log_success "Worktree created at $worktree_path"
    log_info "Branch: $branch_name"

    # Create tmux session
    local session_name="psm:${alias}:issue-${issue_number}"
    local session_id="${alias}:issue-${issue_number}"

    log_info "Creating tmux session..."
    psm_create_tmux_session "$session_name" "$worktree_path"

    if [[ "$no_claude" != "true" ]]; then
        psm_launch_claude "$session_name"
    fi

    # Create metadata
    local metadata=$(cat << EOF
{
  "issue_number": $issue_number,
  "issue_title": $(echo "$issue_title" | jq -R .),
  "issue_url": "$issue_url"
}
EOF
)

    psm_add_session "$session_id" "fix" "$alias" "issue-${issue_number}" "$branch_name" "$base" "$session_name" "$worktree_path" "$local_path" "$metadata" "$provider" "$provider_ref"

    echo ""
    log_success "Session ready!"
    echo ""
    echo "  ID:       $session_id"
    echo "  Type:     fix"
    echo "  Issue:    #${issue_number} - ${issue_title}"
    echo "  Branch:   $branch_name"
    echo "  Worktree: $worktree_path"
    echo "  Tmux:     $session_name"
    echo ""
}

# Command: feature
cmd_feature() {
    local project="$1"
    local feature_name="$2"

    log_info "Creating feature session for: $feature_name"

    # Resolve project
    local project_info
    project_info=$(psm_get_project "$project")
    if [[ $? -ne 0 ]]; then
        log_error "Unknown project: $project"
        return 1
    fi

    IFS='|' read -r repo local_path base <<< "$project_info"

    if [[ ! -d "$local_path" ]]; then
        log_error "Local path not found: $local_path"
        return 1
    fi

    # Create worktree
    log_info "Creating worktree and branch..."
    local worktree_result
    worktree_result=$(psm_create_feature_worktree "$local_path" "$project" "$feature_name" "$base")

    local worktree_status worktree_path branch_name
    IFS='|' read -r worktree_status worktree_path branch_name <<< "$worktree_result"

    if [[ "$worktree_status" == "exists" ]]; then
        log_warn "Worktree already exists at $worktree_path"
        return 0
    elif [[ "$worktree_status" == "error" ]]; then
        log_error "Failed to create worktree"
        return 1
    fi

    log_success "Worktree created at $worktree_path"

    local safe_name=$(psm_sanitize "$feature_name")
    local session_name="psm:${project}:feat-${safe_name}"
    local session_id="${project}:feat-${safe_name}"

    psm_create_tmux_session "$session_name" "$worktree_path"
    psm_launch_claude "$session_name"

    psm_add_session "$session_id" "feature" "$project" "feat-${safe_name}" "$branch_name" "$base" "$session_name" "$worktree_path" "$local_path" "{}"

    echo ""
    log_success "Session ready!"
    echo ""
    echo "  ID:       $session_id"
    echo "  Type:     feature"
    echo "  Branch:   $branch_name"
    echo "  Worktree: $worktree_path"
    echo "  Tmux:     $session_name"
    echo ""
}

# Command: list
cmd_list() {
    local project="${1:-}"

    echo ""
    echo "Active PSM Sessions:"
    echo ""
    printf "%-25s | %-8s | %-10s | %s\n" "ID" "Type" "State" "Worktree"
    printf "%-25s-+-%-8s-+-%-10s-+-%s\n" "-------------------------" "--------" "----------" "----------------------------------------"

    psm_list_sessions "$project" | while IFS='|' read -r id type state worktree; do
        # Check if tmux session exists
        local tmux_state="detached"
        if psm_tmux_session_exists "psm:${id}"; then
            tmux_state="$state"
        else
            tmux_state="no-tmux"
        fi

        printf "%-25s | %-8s | %-10s | %s\n" "$id" "$type" "$tmux_state" "$worktree"
    done

    echo ""
}

# Command: attach
cmd_attach() {
    local session_id="$1"
    local session_name="psm:${session_id}"

    if ! psm_tmux_session_exists "$session_name"; then
        log_error "Session not found: $session_name"
        log_info "Use 'psm list' to see available sessions"
        return 1
    fi

    echo "Attaching to $session_name..."
    echo "Run: tmux attach -t $session_name"
}

# Command: kill
cmd_kill() {
    local session_id="$1"

    log_info "Killing session: $session_id"

    # Get session info
    local session_json
    session_json=$(psm_get_session "$session_id")
    if [[ -z "$session_json" ]]; then
        log_error "Session not found in registry: $session_id"
        return 1
    fi

    local tmux_name=$(echo "$session_json" | jq -r '.tmux')
    local worktree_path=$(echo "$session_json" | jq -r '.worktree')
    local source_repo=$(echo "$session_json" | jq -r '.source_repo')

    # Kill tmux
    psm_kill_tmux_session "$tmux_name"
    log_info "Killed tmux session: $tmux_name"

    # Remove worktree
    psm_remove_worktree "$source_repo" "$worktree_path"
    log_info "Removed worktree: $worktree_path"

    # Remove from registry
    psm_remove_session "$session_id"
    log_info "Removed from registry"

    log_success "Session killed: $session_id"
}

# Command: cleanup
cmd_cleanup() {
    local force="${1:-false}"

    log_info "Starting cleanup..."

    local cleaned=0

    # Check PR sessions (GitHub only)
    while IFS='|' read -r id pr_number project; do
        if [[ -z "$id" ]]; then continue; fi

        local session_json=$(psm_get_session "$id")
        local provider=$(echo "$session_json" | jq -r '.provider // "github"')

        # Only GitHub has PRs
        if [[ "$provider" != "github" ]]; then continue; fi

        local repo=$(psm_get_project "$project" | cut -d'|' -f1)

        if [[ -n "$repo" && -n "$pr_number" ]]; then
            if provider_github_available && provider_call "github" pr_merged "$pr_number" "$repo"; then
                log_info "PR #${pr_number} is merged - cleaning up $id"
                cmd_kill "$id"
                ((cleaned++))
            fi
        fi
    done < <(psm_get_review_sessions)

    # Check issue sessions (GitHub and Jira)
    while IFS='|' read -r id issue_number project; do
        if [[ -z "$id" ]]; then continue; fi

        local session_json=$(psm_get_session "$id")
        local provider=$(echo "$session_json" | jq -r '.provider // "github"')
        local provider_ref=$(echo "$session_json" | jq -r '.provider_ref // empty')

        if [[ "$provider" == "jira" ]]; then
            # Jira cleanup
            if provider_jira_available && [[ -n "$provider_ref" ]]; then
                if provider_call "jira" issue_closed "$provider_ref"; then
                    log_info "Jira issue ${provider_ref} is done - cleaning up $id"
                    cmd_kill "$id"
                    ((cleaned++))
                fi
            fi
        else
            # GitHub cleanup
            local repo=$(psm_get_project "$project" | cut -d'|' -f1)
            if provider_github_available && [[ -n "$repo" && -n "$issue_number" ]]; then
                if provider_call "github" issue_closed "$issue_number" "$repo"; then
                    log_info "Issue #${issue_number} is closed - cleaning up $id"
                    cmd_kill "$id"
                    ((cleaned++))
                fi
            fi
        fi
    done < <(psm_get_fix_sessions)

    if [[ $cleaned -eq 0 ]]; then
        log_success "Cleanup complete - no sessions to clean"
    else
        log_success "Cleanup complete - removed $cleaned session(s)"
    fi
}

# Command: status
cmd_status() {
    # Try to detect current session
    local current_session=$(psm_current_tmux_session)

    if [[ -n "$current_session" && "$current_session" == psm:* ]]; then
        local session_id="${current_session#psm:}"
        local session_json=$(psm_get_session "$session_id")

        if [[ -n "$session_json" ]]; then
            echo ""
            echo "Current Session: $session_id"
            echo ""
            echo "  Type:       $(echo "$session_json" | jq -r '.type')"
            echo "  Branch:     $(echo "$session_json" | jq -r '.branch')"
            echo "  Base:       $(echo "$session_json" | jq -r '.base')"
            echo "  Worktree:   $(echo "$session_json" | jq -r '.worktree')"
            echo "  Created:    $(echo "$session_json" | jq -r '.created_at')"
            echo ""
            return 0
        fi
    fi

    # Check if we're in a worktree
    local cwd=$(pwd)
    local worktree_root=$(psm_get_worktree_root)

    if [[ "$cwd" == "$worktree_root"* ]]; then
        local meta_file="${cwd}/.psm-session.json"
        if [[ -f "$meta_file" ]]; then
            cat "$meta_file" | jq .
            return 0
        fi
    fi

    log_info "Not in a PSM session"
    log_info "Use 'psm list' to see available sessions"
}

# Main entry point
main() {
    if [[ $# -eq 0 ]]; then
        usage
        exit 0
    fi

    # Check dependencies first
    check_dependencies

    # Initialize PSM
    psm_init

    local cmd="$1"
    shift

    case "$cmd" in
        review|r|pr)
            if [[ $# -lt 1 ]]; then
                log_error "Usage: psm review <ref>"
                exit 1
            fi
            cmd_review "$@"
            ;;
        fix|issue|i)
            if [[ $# -lt 1 ]]; then
                log_error "Usage: psm fix <ref>"
                exit 1
            fi
            cmd_fix "$@"
            ;;
        feature|feat|f)
            if [[ $# -lt 2 ]]; then
                log_error "Usage: psm feature <project> <name>"
                exit 1
            fi
            cmd_feature "$@"
            ;;
        list|ls|l)
            cmd_list "$@"
            ;;
        attach|a)
            if [[ $# -lt 1 ]]; then
                log_error "Usage: psm attach <session>"
                exit 1
            fi
            cmd_attach "$@"
            ;;
        kill|k|rm)
            if [[ $# -lt 1 ]]; then
                log_error "Usage: psm kill <session>"
                exit 1
            fi
            cmd_kill "$@"
            ;;
        cleanup|gc|clean)
            cmd_cleanup "$@"
            ;;
        status|st)
            cmd_status
            ;;
        help|-h|--help)
            usage
            ;;
        *)
            log_error "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
