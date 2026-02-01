#!/bin/bash
# PSM Worktree Management

# Validate worktree path is under PSM worktree root before deletion
# Returns 0 if valid, 1 if invalid
# Usage: validate_worktree_path <path>
validate_worktree_path() {
    local path="$1"
    local worktree_root
    worktree_root=$(psm_get_worktree_root 2>/dev/null) || return 1

    # Path must exist and be a directory
    if [[ ! -d "$path" ]]; then
        return 1
    fi

    # Resolve to absolute paths for comparison
    local abs_path abs_root
    abs_path=$(cd "$path" 2>/dev/null && pwd) || return 1
    abs_root=$(cd "$worktree_root" 2>/dev/null && pwd) || return 1

    # Check path is under root and doesn't contain ..
    if [[ "$abs_path" != "$abs_root"/* ]] || [[ "$path" == *".."* ]]; then
        echo "error|Invalid worktree path: not under PSM root" >&2
        return 1
    fi
    return 0
}

# Create a worktree for PR review
# Usage: psm_create_pr_worktree <local_repo> <alias> <pr_number> <pr_branch>
psm_create_pr_worktree() {
    local local_repo="$1"
    local alias="$2"
    local pr_number="$3"
    local pr_branch="$4"

    local worktree_root=$(psm_get_worktree_root)
    local worktree_path="${worktree_root}/${alias}/pr-${pr_number}"

    # Check if worktree already exists
    if [[ -d "$worktree_path" ]]; then
        echo "exists|$worktree_path"
        return 1
    fi

    # Ensure parent directory exists
    mkdir -p "${worktree_root}/${alias}"

    # Fetch the PR branch
    cd "$local_repo" || return 1
    git fetch origin "pull/${pr_number}/head:psm-pr-${pr_number}-review" 2>/dev/null || {
        echo "error|Failed to fetch PR #${pr_number}"
        return 1
    }

    # Create worktree
    git worktree add "$worktree_path" "psm-pr-${pr_number}-review" 2>/dev/null || {
        echo "error|Failed to create worktree"
        return 1
    }

    echo "created|$worktree_path"
    return 0
}

# Create a worktree for issue fix
# Usage: psm_create_issue_worktree <local_repo> <alias> <issue_number> <slug> <base_branch>
psm_create_issue_worktree() {
    local local_repo="$1"
    local alias="$2"
    local issue_number="$3"
    local slug="$4"
    local base_branch="${5:-main}"

    local worktree_root=$(psm_get_worktree_root)
    local worktree_path="${worktree_root}/${alias}/issue-${issue_number}"
    local branch_name="fix/${issue_number}-${slug}"

    # Check if worktree already exists
    if [[ -d "$worktree_path" ]]; then
        echo "exists|$worktree_path|$branch_name"
        return 1
    fi

    mkdir -p "${worktree_root}/${alias}"

    cd "$local_repo" || return 1

    # Fetch latest from origin
    git fetch origin "$base_branch" 2>/dev/null || {
        echo "error|Failed to fetch $base_branch"
        return 1
    }

    # Create and checkout new branch
    git branch "$branch_name" "origin/$base_branch" 2>/dev/null || {
        # Branch might already exist
        true
    }

    # Create worktree
    git worktree add "$worktree_path" "$branch_name" 2>/dev/null || {
        echo "error|Failed to create worktree"
        return 1
    }

    echo "created|$worktree_path|$branch_name"
    return 0
}

# Create a worktree for feature development
# Usage: psm_create_feature_worktree <local_repo> <alias> <feature_name> <base_branch>
psm_create_feature_worktree() {
    local local_repo="$1"
    local alias="$2"
    local feature_name="$3"
    local base_branch="${4:-main}"

    local worktree_root=$(psm_get_worktree_root)
    local safe_name=$(psm_sanitize "$feature_name")
    local worktree_path="${worktree_root}/${alias}/feat-${safe_name}"
    local branch_name="feature/${safe_name}"

    # Check if worktree already exists
    if [[ -d "$worktree_path" ]]; then
        echo "exists|$worktree_path|$branch_name"
        return 1
    fi

    mkdir -p "${worktree_root}/${alias}"

    cd "$local_repo" || return 1

    # Fetch latest
    git fetch origin "$base_branch" 2>/dev/null || {
        echo "error|Failed to fetch $base_branch"
        return 1
    }

    # Create branch
    git branch "$branch_name" "origin/$base_branch" 2>/dev/null || true

    # Create worktree
    git worktree add "$worktree_path" "$branch_name" 2>/dev/null || {
        echo "error|Failed to create worktree"
        return 1
    }

    echo "created|$worktree_path|$branch_name"
    return 0
}

# Remove a worktree
# Usage: psm_remove_worktree <local_repo> <worktree_path>
psm_remove_worktree() {
    local local_repo="$1"
    local worktree_path="$2"

    if [[ ! -d "$worktree_path" ]]; then
        echo "not_found|$worktree_path"
        return 1
    fi

    # Check for uncommitted changes
    if [[ -d "$worktree_path/.git" ]] || [[ -f "$worktree_path/.git" ]]; then
        cd "$worktree_path" || return 1
        if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
            echo "dirty|$worktree_path"
            return 1
        fi
    fi

    cd "$local_repo" || return 1

    # Validate path is under PSM worktree root before any deletion
    if validate_worktree_path "$worktree_path"; then
        git worktree remove "$worktree_path" --force 2>/dev/null || {
            # Force remove the directory if git worktree remove fails
            rm -rf "$worktree_path"
        }
    else
        echo "error|Refusing to delete path outside worktree root: $worktree_path" >&2
        return 1
    fi

    echo "removed|$worktree_path"
    return 0
}

# List all PSM worktrees
psm_list_worktrees() {
    local worktree_root=$(psm_get_worktree_root)

    if [[ ! -d "$worktree_root" ]]; then
        return 0
    fi

    find "$worktree_root" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | while read -r dir; do
        local alias=$(basename "$(dirname "$dir")")
        local name=$(basename "$dir")
        echo "${alias}:${name}|${dir}"
    done
}
