#!/usr/bin/env bash
# PSM Azure DevOps Provider

provider_azure_available() {
    command -v az &> /dev/null
}

provider_azure_detect_ref() {
    local ref="$1"
    [[ "$ref" =~ ^https://dev\.azure\.com/ ]] || \
    [[ "$ref" =~ ^git@ssh\.dev\.azure\.com: ]] || \
    [[ "$ref" =~ \.visualstudio\.com/ ]] || \
    [[ "$ref" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+#[0-9]+$ ]]
}

provider_azure_fetch_pr() {
    local pr_number="$1"
    local repo="$2"
    az repos pr show --id "$pr_number" --output json 2>/dev/null
}

provider_azure_fetch_issue() {
    local issue_number="$1"
    local repo="$2"
    az boards work-item show --id "$issue_number" --output json 2>/dev/null
}

provider_azure_pr_merged() {
    local pr_number="$1"
    local repo="$2"
    command -v az >/dev/null 2>&1 || return 1
    command -v jq >/dev/null 2>&1 || return 1
    local status
    status=$(az repos pr show --id "$pr_number" --output json 2>/dev/null | jq -r '.status // empty')
    [[ "$status" == "completed" ]]
}

provider_azure_issue_closed() {
    local issue_number="$1"
    local repo="$2"
    command -v az >/dev/null 2>&1 || return 1
    command -v jq >/dev/null 2>&1 || return 1
    local state
    state=$(az boards work-item show --id "$issue_number" --output json 2>/dev/null | jq -r '.fields["System.State"] // empty')
    [[ "$state" == "Closed" || "$state" == "Done" ]]
}

provider_azure_clone_url() {
    local repo="$1"
    # Azure DevOps URLs are complex and org-specific; user should configure directly
    echo ""
    return 1
}
