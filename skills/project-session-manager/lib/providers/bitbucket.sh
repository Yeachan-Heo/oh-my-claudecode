#!/usr/bin/env bash
# PSM Bitbucket Provider

provider_bitbucket_available() {
    command -v curl &> /dev/null
}

provider_bitbucket_detect_ref() {
    local ref="$1"
    # Matches bitbucket.org URLs
    [[ "$ref" =~ ^https://bitbucket\.org/ ]]
}

_bitbucket_curl() {
    local url="$1"
    local -a curl_args=(--fail --silent --show-error --connect-timeout 5 --max-time 20)
    if [[ -n "$BITBUCKET_TOKEN" ]]; then
        curl_args+=(-H "Authorization: Bearer $BITBUCKET_TOKEN")
    elif [[ -n "$BITBUCKET_USERNAME" && -n "$BITBUCKET_APP_PASSWORD" ]]; then
        curl_args+=(-u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD")
    fi
    curl "${curl_args[@]}" "$url" 2>/dev/null
}

provider_bitbucket_fetch_pr() {
    local pr_number="$1"
    local repo="$2"
    _bitbucket_curl "https://api.bitbucket.org/2.0/repositories/${repo}/pullrequests/${pr_number}"
}

provider_bitbucket_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    _bitbucket_curl "https://api.bitbucket.org/2.0/repositories/${repo}/issues/${issue_number}"
}

provider_bitbucket_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local state
    state=$(provider_bitbucket_fetch_pr "$pr_number" "$repo" | jq -r '.state // empty')
    [[ "$state" == "MERGED" ]]
}

provider_bitbucket_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    command -v jq >/dev/null 2>&1 || return 1
    local state
    state=$(provider_bitbucket_fetch_issue "$issue_number" "$repo" | jq -r '.state // empty')
    [[ "$state" == "closed" ]]
}

provider_bitbucket_clone_url() {
    local repo="$1"

    # Validate owner/repo format
    if [[ ! "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
        echo "error|Invalid repository format: $repo" >&2
        return 1
    fi

    echo "https://bitbucket.org/${repo}.git"
}
