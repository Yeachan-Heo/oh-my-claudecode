#!/bin/bash
# PSM Jira Provider
# Uses `jira` CLI (https://github.com/ankitpokhrel/jira-cli)

provider_jira_available() {
    command -v jira &> /dev/null
}

provider_jira_detect_ref() {
    local ref="$1"
    # Config-validated detection only
    psm_detect_jira_key "$ref" >/dev/null 2>&1
}

provider_jira_fetch_issue() {
    local issue_key="$1"  # e.g., "PROJ-123"
    # Note: second arg (repo) is ignored for Jira
    jira issue view "$issue_key" --output json 2>/dev/null
}

provider_jira_issue_closed() {
    local issue_key="$1"
    local status_category
    status_category=$(jira issue view "$issue_key" --output json 2>/dev/null | jq -r '.fields.status.statusCategory.key')
    # Jira status categories: "new", "indeterminate", "done"
    [[ "$status_category" == "done" ]]
}

# Jira has no PRs - return error
provider_jira_fetch_pr() {
    echo '{"error": "Jira does not support pull requests"}' >&2
    return 1
}

provider_jira_pr_merged() {
    return 1  # Always false - Jira has no PRs
}

provider_jira_clone_url() {
    local alias="$1"
    # For Jira, we need to get clone_url from config
    # First try explicit clone_url, then fall back to repo as GitHub
    local clone_url
    clone_url=$(psm_get_project_clone_url "$alias")
    if [[ -n "$clone_url" ]]; then
        echo "$clone_url"
        return 0
    fi

    local repo
    repo=$(psm_get_project_repo "$alias")
    if [[ -n "$repo" ]]; then
        echo "https://github.com/${repo}.git"
        return 0
    fi

    echo "error: No clone_url or repo configured for alias '$alias'" >&2
    return 1
}

# Parse Jira reference into components
# Input: "PROJ-123" or "mywork#123"
# Output: Extended format for session creation
provider_jira_parse_ref() {
    local ref="$1"
    local jira_info

    # Try direct PROJ-123 pattern
    if jira_info=$(psm_detect_jira_key "$ref"); then
        IFS='|' read -r alias project_key issue_number <<< "$jira_info"
        local project_info
        project_info=$(psm_get_project "$alias")
        IFS='|' read -r repo local_path base <<< "$project_info"
        echo "issue|${alias}|${repo}|${issue_number}|${local_path}|${base}|jira|${project_key}-${issue_number}"
        return 0
    fi

    return 1
}
