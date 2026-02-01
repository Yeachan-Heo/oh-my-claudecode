#!/bin/bash
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
    gh pr view "$pr_number" --repo "$repo" --json number,title,author,headRefName,baseRefName,body,url 2>/dev/null
}

provider_github_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    gh issue view "$issue_number" --repo "$repo" --json number,title,body,labels,url 2>/dev/null
}

provider_github_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    local merged
    merged=$(gh pr view "$pr_number" --repo "$repo" --json merged 2>/dev/null | jq -r '.merged')
    [[ "$merged" == "true" ]]
}

provider_github_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    local closed
    closed=$(gh issue view "$issue_number" --repo "$repo" --json closed 2>/dev/null | jq -r '.closed')
    [[ "$closed" == "true" ]]
}

provider_github_clone_url() {
    local repo="$1"
    echo "https://github.com/${repo}.git"
}
