#!/usr/bin/env bash
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

# Best-effort dependency bootstrap for clean PR review worktrees.
# Reuses the source repo node_modules only when package.json matches exactly.
# This keeps focused test commands like `npm run test:run -- ...` usable
# without forcing a full install in every review worktree.
psm_bootstrap_review_dependencies() {
    local local_repo="$1"
    local worktree_path="$2"

    local source_package_json="${local_repo}/package.json"
    local target_package_json="${worktree_path}/package.json"
    local source_node_modules="${local_repo}/node_modules"
    local target_node_modules="${worktree_path}/node_modules"

    [[ -f "$source_package_json" ]] || return 0
    [[ -f "$target_package_json" ]] || return 0
    [[ -d "$source_node_modules" ]] || return 0
    [[ ! -e "$target_node_modules" ]] || return 0

    cmp -s "$source_package_json" "$target_package_json" || return 0

    ln -s "$source_node_modules" "$target_node_modules" 2>/dev/null || true
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
    git fetch origin "pull/${pr_number}/head:psm-pr-${pr_number}-review" >/dev/null 2>&1 || {
        echo "error|Failed to fetch PR #${pr_number}"
        return 1
    }

    # Create worktree
    git worktree add "$worktree_path" "psm-pr-${pr_number}-review" >/dev/null 2>&1 || {
        echo "error|Failed to create worktree"
        return 1
    }

    psm_bootstrap_review_dependencies "$local_repo" "$worktree_path"

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
    git fetch origin "$base_branch" >/dev/null 2>&1 || {
        echo "error|Failed to fetch $base_branch"
        return 1
    }

    # Create and checkout new branch
    git branch "$branch_name" "origin/$base_branch" >/dev/null 2>&1 || {
        # Branch might already exist
        true
    }

    # Create worktree
    git worktree add "$worktree_path" "$branch_name" >/dev/null 2>&1 || {
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
    git fetch origin "$base_branch" >/dev/null 2>&1 || {
        echo "error|Failed to fetch $base_branch"
        return 1
    }

    # Create branch
    git branch "$branch_name" "origin/$base_branch" >/dev/null 2>&1 || true

    # Create worktree
    git worktree add "$worktree_path" "$branch_name" >/dev/null 2>&1 || {
        echo "error|Failed to create worktree"
        return 1
    }

    echo "created|$worktree_path|$branch_name"
    return 0
}

# Resolve without accepting a symlink anywhere in the directory path.
psm_physical_directory() {
    local logical physical
    logical=$(cd -- "$1" && pwd -L) || return 1
    physical=$(cd -- "$1" && pwd -P) || return 1
    [[ "$logical" == "$physical" ]] || return 1
    printf '%s\n' "$physical"
}

# Prove Git membership before trusting a path or writing its private metadata.
psm_worktree_identity() {
    local source="$1" candidate="$2" root common private branch head listing line listed top current
    source=$(psm_physical_directory "$source") || return 1
    candidate=$(psm_physical_directory "$candidate") || return 1
    root=$(psm_get_worktree_root) || return 1
    root=$(psm_physical_directory "$root") || return 1
    current=$(pwd -P) || return 1
    [[ "$candidate" == "$root"/* && "$candidate" != "$source" ]] || return 1
    [[ "$current" != "$candidate" && "$current" != "$candidate"/* ]] || return 1
    [[ "$candidate" != / && "$candidate" != "${HOME:-}" && -f "$candidate/.git" && ! -L "$candidate/.git" ]] || return 1
    common=$(git -C "$source" rev-parse --path-format=absolute --git-common-dir) || return 1
    common=$(psm_physical_directory "$common") || return 1
    listed=$(git -C "$candidate" rev-parse --path-format=absolute --git-common-dir) || return 1
    listed=$(psm_physical_directory "$listed") || return 1
    [[ "$listed" == "$common" ]] || return 1
    top=$(git -C "$candidate" rev-parse --show-toplevel) || return 1
    top=$(psm_physical_directory "$top") || return 1
    [[ "$top" == "$candidate" ]] || return 1
    private=$(git -C "$candidate" rev-parse --absolute-git-dir) || return 1
    private=$(psm_physical_directory "$private") || return 1
    [[ "$private" == "$common"/worktrees/* && "$private" != "$common"/worktrees ]] || return 1
    listing=$(git -C "$source" worktree list --porcelain) || return 1
    local found=false matching=false
    while IFS= read -r line; do
        case "$line" in
            'worktree '*)
                matching=false
                listed=$(psm_physical_directory "${line#worktree }") || return 1
                if [[ "$listed" == "$candidate" ]]; then found=true; matching=true; fi ;;
            locked*|prunable*) [[ "$matching" != true ]] || return 1 ;;
        esac
    done <<< "$listing"
    [[ "$found" == true ]] || return 1
    branch=$(git -C "$candidate" symbolic-ref --quiet --short HEAD) || return 1
    head=$(git -C "$candidate" rev-parse --verify HEAD) || return 1
    [[ -n "$branch" && "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
    jq -cn --arg common "$common" --arg path "$candidate" --arg private "$private" \
        --arg branch "$branch" --arg head "$head" \
        '{source_common_dir:$common,worktree:$path,git_dir:$private,branch:$branch,created_head:$head}'
}

# New sessions only. Never manufacture ownership for an existing registry entry.
psm_create_worktree_owner() {
    local id="$1" identity private temporary token owner target
    identity=$(psm_worktree_identity "$2" "$3") || return 1
    private=$(jq -er '.git_dir' <<< "$identity") || return 1
    target="$private/psm-owner.json"
    [[ ! -e "$target" && ! -L "$target" ]] || return 1
    temporary=$(mktemp "$private/.psm-owner.XXXXXXXX") || return 1
    token=$(printf '%s' "$temporary" | git hash-object --stdin) || { rm -f -- "$temporary"; return 1; }
    rm -f -- "$temporary"
    [[ "$token" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ -n "${4:-}" ]] || return 1
    owner=$(jq -c --arg id "$id" --arg token "$token" --arg tmux "$4" \
        '. + {schema:1,session_id:$id,token:$token,tmux:$tmux}' <<< "$identity") || return 1
    # Exclusive creation + readback: a partial/orphan file never grants cleanup.
    (umask 077; set -o noclobber; printf '%s\n' "$owner" > "$target") || return 1
    [[ ! -L "$target" && "$(jq -cS . "$target")" == "$(jq -cS . <<< "$owner")" ]] || return 1
    printf '%s\n' "$owner"
}

# Removal requires matching new-session ownership on both sides, not a prefix.
# Usage: psm_remove_worktree <local_repo> <worktree_path> <registered_session_json>
psm_session_inactive() {
    local name="$1" sessions rc line
    if sessions=$(LC_ALL=C tmux list-sessions -F '#{session_name}' 2>&1); then
        [[ -n "$sessions" ]] || return 1
        while IFS= read -r line; do
            [[ -n "$line" && "$line" != "$name" ]] || return 1
        done <<< "$sessions"
        return 0
    else
        rc=$?
        [[ "$rc" -eq 1 ]] || return 1
        case "$sessions" in
            'no server running on '*) return 0 ;;
            'error connecting to '*'(No such file or directory)') return 0 ;;
            *) return 1 ;;
        esac
    fi
}

psm_remove_worktree() {
    local local_repo="$1" worktree_path="$2" session="${3:-}" identity owner target expected actual status tmux_name base tip archive registered id rc
    identity=$(psm_worktree_identity "$local_repo" "$worktree_path") || return 1
    owner=$(jq -ce '.cleanup_owner | select(.schema==1 and (.token|type=="string" and length>0))' <<< "$session") || return 1
    target="$(jq -er '.git_dir' <<< "$identity")/psm-owner.json"
    [[ -f "$target" && ! -L "$target" ]] || return 1
    [[ "$(jq -cS . "$target")" == "$(jq -cS . <<< "$owner")" ]] || return 1
    [[ "$(jq -er '.id' <<< "$session")" == "$(jq -er '.session_id' <<< "$owner")" ]] || return 1
    expected=$(jq -cS 'del(.schema,.token,.session_id,.created_head,.tmux)' <<< "$owner") || return 1
    actual=$(jq -cS 'del(.created_head)' <<< "$identity") || return 1
    [[ "$expected" == "$actual" ]] || return 1
    worktree_path=$(jq -er '.worktree' <<< "$identity") || return 1
    tmux_name=$(jq -er '.tmux | strings | select(length>0)' <<< "$session") || return 1
    [[ "$tmux_name" == "$(jq -er '.tmux' <<< "$owner")" ]] || return 1
    psm_session_inactive "$tmux_name" || return 1
    status=$(git -C "$worktree_path" status --porcelain --untracked-files=all --ignored) || return 1
    [[ -z "$status" ]] || return 1
    tip=$(git -C "$worktree_path" rev-parse --verify HEAD) || return 1
    base=$(jq -er '.base | strings | select(length>0 and (startswith("-")|not))' <<< "$session") || return 1
    base=$(git -C "$local_repo" rev-parse --verify "${base}^{commit}") || return 1
    if git -C "$local_repo" merge-base --is-ancestor "$tip" "$base"; then
        :
    else
        rc=$?
        [[ "$rc" -eq 1 ]] || return 1
        archive=$(jq -er 'select(.metadata.cleanup_archive_confirmed==true) | .metadata.cleanup_archive_ref | strings | select(startswith("refs/tags/psm-archive/"))' <<< "$session") || return 1
        archive=$(git -C "$local_repo" rev-parse --verify "${archive}^{commit}") || return 1
        [[ "$archive" == "$tip" ]] || return 1
    fi
    id=$(jq -er '.id' <<< "$session") || return 1
    registered=$(psm_get_session "$id") || return 1
    [[ "$(jq -cS . <<< "$registered")" == "$(jq -cS . <<< "$session")" ]] || return 1
    [[ "$(jq -cS . "$target")" == "$(jq -cS . <<< "$owner")" ]] || return 1
    psm_session_inactive "$tmux_name" || return 1
    actual=$(git -C "$worktree_path" rev-parse --verify HEAD) || return 1
    [[ "$actual" == "$tip" ]] || return 1
    status=$(git -C "$worktree_path" status --porcelain --untracked-files=all --ignored) || return 1
    [[ -z "$status" ]] || return 1
    # Git rechecks dirtiness; failures never fall back to filesystem deletion.
    git -C "$local_repo" worktree remove "$worktree_path" || return 1
    printf 'removed|%s\n' "$worktree_path"
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
