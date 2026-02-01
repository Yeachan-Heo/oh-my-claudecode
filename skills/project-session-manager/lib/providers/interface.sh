#!/bin/bash
# PSM Provider Interface
# Each provider implements: _available, _detect_ref, _fetch_issue, _issue_closed,
#                          _fetch_pr (optional), _pr_merged (optional), _clone_url

# List available providers
provider_list() {
    echo "github jira"
}

# Check if a provider is available (CLI installed)
# Usage: provider_available "github"
provider_available() {
    local provider="$1"
    "provider_${provider}_available"
}

# Dispatch to provider function
# Usage: provider_call "github" "fetch_issue" "123" "owner/repo"
provider_call() {
    local provider="$1"
    local func="$2"
    shift 2
    "provider_${provider}_${func}" "$@"
}

# Detect provider from reference (with config validation)
# Usage: provider_detect_from_ref "PROJ-123"
# Returns: provider name or empty
provider_detect_from_ref() {
    local ref="$1"

    # Check Jira pattern first (config-validated)
    if psm_detect_jira_key "$ref" >/dev/null 2>&1; then
        echo "jira"
        return 0
    fi

    # GitHub URL patterns
    if [[ "$ref" =~ ^https://github\.com/ ]]; then
        echo "github"
        return 0
    fi

    # owner/repo#num pattern -> GitHub
    if [[ "$ref" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+#[0-9]+$ ]]; then
        echo "github"
        return 0
    fi

    # Default
    echo "github"
}
