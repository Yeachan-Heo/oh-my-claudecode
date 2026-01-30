# Security Review: PR #220 - PSM Multi-Provider Support

**PR**: https://github.com/Yeachan-Heo/oh-my-claudecode/pull/220
**Reviewer**: Claude Opus 4.5
**Date**: 2026-01-30
**Status**: APPROVED with observations

---

## Overview

This PR adds a provider abstraction layer to PSM (Project Session Manager), enabling support for multiple issue tracker backends. The initial implementation includes GitHub (existing) and Jira (new).

## Manual Test Results

### Test Environment
- macOS Darwin 25.0.0
- Bash 3.2
- `gh` CLI available
- `jira` CLI not installed (expected for testing error handling)
- `tmux` not available (tested without session management)

### Validation Summary

| Check | Status |
|-------|--------|
| Bash syntax validation (`bash -n`) | PASS |
| TypeScript build (`npx tsc --noEmit`) | PASS |
| Unit tests (1705 tests) | PASS |
| GitHub alias#number format (omc#123) | PASS |
| GitHub URL format | PASS |
| Jira direct reference (TEST-123) | PASS |
| Jira alias#number format (jiratest#456) | PASS |
| Jira review rejection | PASS |
| Missing CLI error handling | PASS |
| Config-validated Jira key detection | PASS |
| Non-configured Jira key rejection (FIX-123) | PASS |

### Detailed Test Cases

#### 1. GitHub Compatibility (Existing Functionality)
```bash
$ ./psm.sh fix omc#123
[PSM] Parsing reference: omc#123
[PSM] Fetching issue #123...
[PSM] Issue: #123 - feat: generic project-session-manager skill
# Successfully parses and fetches GitHub issue
```

#### 2. Jira Integration
```bash
$ ./psm.sh fix TEST-123
[PSM] Parsing reference: TEST-123
[PSM] Jira CLI not found. Install: brew install ankitpokhrel/jira-cli/jira-cli
# Correctly identifies Jira provider and checks for CLI
```

#### 3. Jira PR Rejection
```bash
$ ./psm.sh review TEST-123
[PSM] Jira issues cannot be 'reviewed' - Jira has no PR concept.
[PSM] Use 'psm fix TEST-123' to work on a Jira issue instead.
[PSM] Jira integration supports: fix, feature
# Correctly rejects PR review for Jira issues with helpful guidance
```

#### 4. Provider Detection from Reference
```bash
# Parse results include provider and provider_ref fields:
omc#123     -> provider=github, provider_ref=Yeachan-Heo/oh-my-claudecode#123
TEST-123    -> provider=jira, provider_ref=TEST-123
jiratest#456 -> provider=jira, provider_ref=TEST-456
```

#### 5. Config-Validated Jira Key Detection
```bash
# Configured key (TEST) is recognized:
psm_detect_jira_key TEST-123  -> jiratest|TEST|123

# Non-configured key (FIX) is rejected:
psm_detect_jira_key FIX-123   -> (no match, returns 1)
```

---

## Security Analysis

### Positive Findings

1. **No Hardcoded Credentials**
   - Jira CLI handles authentication externally
   - No API keys or tokens in source code

2. **Input Validation**
   - Jira key pattern (`PROJ-123`) only matches configured projects
   - Prevents false positives (e.g., `FIX-123` is not treated as Jira unless configured)
   - Regex pattern requires uppercase letters for project prefix

3. **Safe Provider Dispatch**
   - `provider_call()` uses simple function name construction
   - No shell injection vectors in provider dispatch
   - Provider names are constrained to known values

4. **Error Messages**
   - Do not expose sensitive paths or internal details
   - Provide actionable guidance for users

### Code Quality

1. **Clean Separation of Concerns**
   - Provider interface (`lib/providers/interface.sh`)
   - GitHub provider (`lib/providers/github.sh`)
   - Jira provider (`lib/providers/jira.sh`)

2. **Backward Compatibility**
   - Existing GitHub functionality preserved
   - Default provider is "github" when not specified

3. **Graceful Degradation**
   - Missing CLI tools produce helpful error messages
   - Operations continue for available providers

### Observations

1. **Jira clone_url Handling**
   - Falls back to GitHub URL format if only `repo` is specified
   - May want to document this behavior for Bitbucket/GitLab users

2. **Session Cleanup**
   - `cmd_cleanup()` correctly handles mixed GitHub/Jira sessions
   - Jira uses `statusCategory.key == "done"` for closure detection

---

## Recommendations

1. **Consider Future Providers**
   - GitLab and Bitbucket are natural extensions
   - Current architecture supports this well

2. **Documentation Update**
   - SKILL.md should document Jira integration
   - Example projects.json for Jira configuration

---

## Conclusion

The PR implements multi-provider support correctly with proper security considerations. The config-validated approach for Jira key detection prevents false positives, and the clean provider abstraction allows for future extensions. All existing GitHub functionality is preserved.

**Recommendation**: APPROVE
