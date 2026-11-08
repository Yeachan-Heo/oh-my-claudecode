#!/usr/bin/env bash
# PSM GitLab Provider

provider_gitlab_available() {
    command -v glab &> /dev/null
}

provider_gitlab_detect_ref() {
    local ref="$1"
    # Matches gitlab URLs or owner/repo!num patterns (GitLab uses ! for MRs)
    [[ "$ref" =~ ^https://gitlab\. ]] || [[ "$ref" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+![0-9]+$ ]]
}

provider_gitlab_fetch_pr() {
    local mr_number="$1"
    local repo="$2"
    glab mr view "$mr_number" --repo "$repo" --output json 2>/dev/null
}

provider_gitlab_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    glab issue view "$issue_number" --repo "$repo" --output json 2>/dev/null
}

provider_gitlab_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local merged_at
    merged_at=$(glab mr view "$pr_number" --repo "$repo" --output json 2>/dev/null | jq -r '.merged_at // empty')
    [[ -n "$merged_at" && "$merged_at" != "null" ]]
}

provider_gitlab_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local state
    state=$(glab issue view "$issue_number" --repo "$repo" --output json 2>/dev/null | jq -r '.state // empty')
    [[ "$state" == "closed" ]]
}

provider_gitlab_clone_url() {
    local repo="$1"

    # Validate owner/repo format
    if [[ ! "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
        echo "error|Invalid repository format: $repo" >&2
        return 1
    fi

    echo "https://gitlab.com/${repo}.git"
}
