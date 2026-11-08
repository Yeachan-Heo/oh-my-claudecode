#!/usr/bin/env bash
# PSM GitHub Provider

provider_github_available() {
    command -v gh &> /dev/null
}

provider_github_detect_ref() {
    local ref="$1"
    # Matches github URLs or owner/repo#num patterns
    [[ "$ref" =~ ^https://github\.com/ ]] || [[ "$ref" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+#[0-9]+$ ]]
}

provider_github_fetch_pr() {
    local pr_number="$1"
    local repo="$2"
    gh pr view "$pr_number" --repo "$repo" --json number,title,author,headRefName,baseRefName,body,files,url 2>/dev/null
}

provider_github_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    gh issue view "$issue_number" --repo "$repo" --json number,title,body,labels,url 2>/dev/null
}

provider_github_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local merged
    merged=$(gh pr view "$pr_number" --repo "$repo" --json merged 2>/dev/null | jq -r '.merged // empty')
    [[ "$merged" == "true" ]]
}

provider_github_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local closed
    closed=$(gh issue view "$issue_number" --repo "$repo" --json closed 2>/dev/null | jq -r '.closed // empty')
    [[ "$closed" == "true" ]]
}

provider_github_clone_url() {
    local repo="$1"

    # Validate owner/repo format
    if [[ ! "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
        echo "error|Invalid repository format: $repo" >&2
        return 1
    fi

    echo "https://github.com/${repo}.git"
}
