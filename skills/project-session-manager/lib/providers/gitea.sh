#!/usr/bin/env bash
# PSM Gitea Provider

provider_gitea_available() {
    command -v tea &> /dev/null || command -v curl &> /dev/null
}

provider_gitea_detect_ref() {
    # Cannot auto-detect self-hosted Gitea instances from URL alone
    return 1
}

_gitea_curl_api() {
    local endpoint="$1"
    local base_url="${GITEA_URL:-https://gitea.com}"
    local -a curl_args=(--fail --silent --show-error --connect-timeout 5 --max-time 20)
    if [[ -n "$GITEA_TOKEN" ]]; then
        curl_args+=(-H "Authorization: token $GITEA_TOKEN")
    fi
    curl "${curl_args[@]}" "${base_url}/api/v1/${endpoint}" 2>/dev/null
}

provider_gitea_fetch_pr() {
    local pr_number="$1"
    local repo="$2"
    # Try tea CLI first, fall back to curl REST API
    if command -v tea &> /dev/null; then
        local result
        result=$(tea pr view "$pr_number" 2>/dev/null)
        if [[ $? -eq 0 && -n "$result" ]]; then
            echo "$result"
            return 0
        fi
    fi
    # Fallback to REST API
    if [[ -n "$GITEA_URL" && -n "$GITEA_TOKEN" ]]; then
        _gitea_curl_api "repos/${repo}/pulls/${pr_number}"
    else
        return 1
    fi
}

provider_gitea_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    # Try tea CLI first, fall back to curl REST API
    if command -v tea &> /dev/null; then
        local result
        result=$(tea issues view "$issue_number" 2>/dev/null)
        if [[ $? -eq 0 && -n "$result" ]]; then
            echo "$result"
            return 0
        fi
    fi
    # Fallback to REST API
    if [[ -n "$GITEA_URL" && -n "$GITEA_TOKEN" ]]; then
        _gitea_curl_api "repos/${repo}/issues/${issue_number}"
    else
        return 1
    fi
}

provider_gitea_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local merged
    # Use REST API for structured JSON output
    if [[ -n "$GITEA_URL" && -n "$GITEA_TOKEN" ]]; then
        merged=$(_gitea_curl_api "repos/${repo}/pulls/${pr_number}" | jq -r '.merged // empty')
        [[ "$merged" == "true" ]]
    else
        return 1
    fi
}

provider_gitea_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local state
    # Use REST API for structured JSON output
    if [[ -n "$GITEA_URL" && -n "$GITEA_TOKEN" ]]; then
        state=$(_gitea_curl_api "repos/${repo}/issues/${issue_number}" | jq -r '.state // empty')
        [[ "$state" == "closed" ]]
    else
        return 1
    fi
}

provider_gitea_clone_url() {
    local repo="$1"

    # Validate owner/repo format
    if [[ ! "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
        echo "error|Invalid repository format: $repo" >&2
        return 1
    fi

    echo "${GITEA_URL:-https://gitea.com}/${repo}.git"
}
