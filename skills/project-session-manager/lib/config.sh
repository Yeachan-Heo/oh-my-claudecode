#!/bin/bash
# PSM Configuration Management

PSM_ROOT="${HOME}/.psm"
PSM_WORKTREES="${PSM_ROOT}/worktrees"
PSM_PROJECTS="${PSM_ROOT}/projects.json"
PSM_SESSIONS="${PSM_ROOT}/sessions.json"
PSM_LOGS="${PSM_ROOT}/logs"

# Initialize PSM directories and config files
psm_init() {
    mkdir -p "$PSM_WORKTREES" "$PSM_LOGS"

    # Create default projects.json if not exists
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        cat > "$PSM_PROJECTS" << 'EOF'
{
  "aliases": {
    "omc": {
      "repo": "Yeachan-Heo/oh-my-claudecode",
      "local": "~/Workspace/oh-my-claudecode",
      "default_base": "main"
    }
  },
  "defaults": {
    "worktree_root": "~/.psm/worktrees",
    "cleanup_after_days": 14,
    "auto_cleanup_merged": true
  }
}
EOF
        echo "Created default projects.json"
    fi

    # Create sessions.json if not exists
    if [[ ! -f "$PSM_SESSIONS" ]]; then
        echo '{"version":1,"sessions":{},"stats":{"total_created":0,"total_cleaned":0}}' > "$PSM_SESSIONS"
        echo "Created sessions.json"
    fi
}

# Get project config by alias
# Usage: psm_get_project "omc"
# Returns: repo|local|default_base
psm_get_project() {
    local alias="$1"
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        return 1
    fi

    local repo=$(jq -r ".aliases[\"$alias\"].repo // empty" "$PSM_PROJECTS")
    local local_path=$(jq -r ".aliases[\"$alias\"].local // empty" "$PSM_PROJECTS")
    local default_base=$(jq -r ".aliases[\"$alias\"].default_base // \"main\"" "$PSM_PROJECTS")

    if [[ -z "$repo" ]]; then
        return 1
    fi

    # Expand ~ to $HOME
    local_path="${local_path/#\~/$HOME}"

    echo "${repo}|${local_path}|${default_base}"
}

# Get provider for a project alias
# Usage: psm_get_project_provider "mywork"
# Returns: "github" | "jira" | empty (defaults to github)
psm_get_project_provider() {
    local alias="$1"
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        echo "github"
        return
    fi
    local provider
    provider=$(jq -r ".aliases[\"$alias\"].provider // \"github\"" "$PSM_PROJECTS")
    echo "$provider"
}

# Get Jira project key for alias
# Usage: psm_get_project_jira_project "mywork"
# Returns: "MYPROJ" or empty
psm_get_project_jira_project() {
    local alias="$1"
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        return
    fi
    jq -r ".aliases[\"$alias\"].jira_project // empty" "$PSM_PROJECTS"
}

# Get explicit clone_url for alias (for non-GitHub repos)
# Usage: psm_get_project_clone_url "mywork"
# Returns: URL or empty
psm_get_project_clone_url() {
    local alias="$1"
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        return
    fi
    jq -r ".aliases[\"$alias\"].clone_url // empty" "$PSM_PROJECTS"
}

# Get repo field for alias
# Usage: psm_get_project_repo "mywork"
# Returns: "owner/repo" or empty
psm_get_project_repo() {
    local alias="$1"
    if [[ ! -f "$PSM_PROJECTS" ]]; then
        return
    fi
    jq -r ".aliases[\"$alias\"].repo // empty" "$PSM_PROJECTS"
}

# Add or update project alias
psm_set_project() {
    local alias="$1"
    local repo="$2"
    local local_path="$3"
    local default_base="${4:-main}"

    local tmp=$(mktemp)
    jq ".aliases[\"$alias\"] = {\"repo\": \"$repo\", \"local\": \"$local_path\", \"default_base\": \"$default_base\"}" \
        "$PSM_PROJECTS" > "$tmp" && mv "$tmp" "$PSM_PROJECTS"
}

# Get default worktree root
psm_get_worktree_root() {
    local root=$(jq -r '.defaults.worktree_root // "~/.psm/worktrees"' "$PSM_PROJECTS")
    echo "${root/#\~/$HOME}"
}

# Get cleanup days setting
psm_get_cleanup_days() {
    jq -r '.defaults.cleanup_after_days // 14' "$PSM_PROJECTS"
}
