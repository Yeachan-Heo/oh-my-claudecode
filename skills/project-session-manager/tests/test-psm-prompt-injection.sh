#!/usr/bin/env bash
# Regression tests for PSM prompt injection (issue #2506)
# Root cause: psm_launch_claude only sent "claude Enter" with no task context injected.
# Fix: psm_render_template + psm_inject_prompt + context file written to worktree.
#
# Usage: bash skills/project-session-manager/tests/test-psm-prompt-injection.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSM_LIB_DIR="${SCRIPT_DIR}/../lib"
TEMPLATES_DIR="${SCRIPT_DIR}/../templates"

# ── Test counters ─────────────────────────────────────────────────────────────

PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )) || true; }
fail() { echo "FAIL: $1"; echo "      $2"; (( FAIL++ )) || true; }

assert_equals() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        pass "$desc"
    else
        fail "$desc" "expected='$expected' actual='$actual'"
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc" "expected to contain: '$needle'"
    fi
}

assert_not_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc" "expected NOT to contain: '$needle'"
    fi
}

assert_file_exists() {
    local desc="$1" path="$2"
    if [[ -f "$path" ]]; then
        pass "$desc"
    else
        fail "$desc" "file not found: $path"
    fi
}

# ── Setup ─────────────────────────────────────────────────────────────────────

# Source only the lib/tmux.sh functions needed for testing.
# We must stub the real `tmux` binary before sourcing so that
# psm_has_tmux (which calls `command -v tmux`) still works without a real tmux.
tmux() { :; }
source "${PSM_LIB_DIR}/tmux.sh"

TMPDIR_TEST=$(mktemp -d)
TEMPLATE_TMP="${TMPDIR_TEST}/template.md"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

# ── psm_render_template ───────────────────────────────────────────────────────

echo ""
echo "=== psm_render_template ==="

# 1. Simple single substitution
printf 'Hello {{NAME}}!' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "NAME=World")
assert_equals "renders single variable" "Hello World!" "$result"

# 2. Multiple variables in one call
printf 'PR #{{PR_NUMBER}}: {{PR_TITLE}} by @{{PR_AUTHOR}}' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "PR_NUMBER=123" "PR_TITLE=Fix bug" "PR_AUTHOR=alice")
assert_equals "renders multiple variables" "PR #123: Fix bug by @alice" "$result"

# 3. Unreferenced placeholder is preserved
printf 'Hello {{NAME}} and {{OTHER}}!' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "NAME=World")
assert_contains "preserves unreferenced placeholders" "{{OTHER}}" "$result"
assert_not_contains "replaces referenced placeholder" "{{NAME}}" "$result"

# 4. Missing template file returns non-zero and error message
set +e
err_out=$(psm_render_template "/nonexistent/missing.md" "KEY=val" 2>&1)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] && pass "returns non-zero for missing template" \
                        || fail "returns non-zero for missing template" "exited 0"
assert_contains "error message for missing template" "error|" "$err_out"

# 5. Value containing forward slash (common in branch names)
printf '{{BRANCH}}' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "BRANCH=feature/my-branch")
assert_equals "handles slashes in values" "feature/my-branch" "$result"

# 6. Empty value clears placeholder
printf 'before {{EMPTY}} after' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "EMPTY=")
assert_equals "empty value clears placeholder" "before  after" "$result"

# 7. Value with & (must not be interpreted as backreference)
printf '{{VAL}}' > "$TEMPLATE_TMP"
result=$(psm_render_template "$TEMPLATE_TMP" "VAL=foo&bar")
assert_equals "handles ampersand in value" "foo&bar" "$result"

# ── _psm_pane_has_claude_prompt ───────────────────────────────────────────────

echo ""
echo "=== _psm_pane_has_claude_prompt ==="

# 8. Detects bare '>' prompt
if _psm_pane_has_claude_prompt ">"; then
    pass "detects bare '>' prompt"
else
    fail "detects bare '>' prompt" "returned non-zero"
fi

# 9. Detects '> ' with trailing space
if _psm_pane_has_claude_prompt "> "; then
    pass "detects '> ' with trailing space"
else
    fail "detects '> ' with trailing space" "returned non-zero"
fi

# 10. Detects '?' trust prompt
if _psm_pane_has_claude_prompt "?"; then
    pass "detects '?' trust prompt"
else
    fail "detects '?' trust prompt" "returned non-zero"
fi

# 11. Detects '>' with leading whitespace
if _psm_pane_has_claude_prompt "  > "; then
    pass "detects indented '>' prompt"
else
    fail "detects indented '>' prompt" "returned non-zero"
fi

# 12. Does NOT match '>' that appears mid-line
if ! _psm_pane_has_claude_prompt "Loading > modules"; then
    pass "rejects mid-line >"
else
    fail "rejects mid-line >" "should have returned non-zero"
fi

# 13. Does NOT match empty string
if ! _psm_pane_has_claude_prompt ""; then
    pass "rejects empty pane"
else
    fail "rejects empty pane" "should have returned non-zero"
fi

# 14. Does NOT match arbitrary text
if ! _psm_pane_has_claude_prompt "Welcome to Claude Code!"; then
    pass "rejects non-prompt welcome text"
else
    fail "rejects non-prompt welcome text" "should have returned non-zero"
fi

# ── psm_launch_claude with mocked tmux/inject ─────────────────────────────────

echo ""
echo "=== psm_launch_claude (mocked) ==="

# Mock state
TMUX_SEND_CALLS=()
INJECT_CALLED=false
INJECT_SESSION=""
INJECT_FILE=""

# Override tmux to record calls; simulate has-session returning 0
tmux() {
    local subcmd="$1"
    case "$subcmd" in
        has-session) return 0 ;;
        send-keys)   TMUX_SEND_CALLS+=("$*") ;;
        *)           : ;;
    esac
}

# Override psm_inject_prompt to track invocations
psm_inject_prompt() {
    INJECT_CALLED=true
    INJECT_SESSION="$1"
    INJECT_FILE="$2"
    return 0
}

# 15. Without context file: inject is NOT called
TMUX_SEND_CALLS=(); INJECT_CALLED=false
psm_launch_claude "test-session"
if [[ "$INJECT_CALLED" == "false" ]]; then
    pass "no inject without context file"
else
    fail "no inject without context file" "psm_inject_prompt was called unexpectedly"
fi

# 16. With context file: inject IS called
TMUX_SEND_CALLS=(); INJECT_CALLED=false; INJECT_SESSION=""; INJECT_FILE=""
psm_launch_claude "test-session" ".psm/review.md"
if [[ "$INJECT_CALLED" == "true" ]]; then
    pass "inject called when context file provided"
else
    fail "inject called when context file provided" "psm_inject_prompt was NOT called"
fi

# 17. inject receives correct session name
assert_equals "inject gets correct session name" "test-session" "$INJECT_SESSION"

# 18. inject receives correct context file path
assert_equals "inject gets correct context file path" ".psm/review.md" "$INJECT_FILE"

# 19. Result reports 'launched|'
TMUX_SEND_CALLS=(); INJECT_CALLED=false
result=$(psm_launch_claude "test-session" ".psm/review.md")
assert_contains "launch reports launched| on success" "launched|" "$result"

# 20. Session-not-found returns error (has-session fails)
tmux() {
    case "$1" in
        has-session) return 1 ;;
        *)           : ;;
    esac
}
# Use || true so set -e doesn't kill the script on the expected non-zero return
result=$(psm_launch_claude "missing-session" 2>&1) || true
assert_contains "error reported for missing session" "error|" "$result"

# ── Context file creation (cmd_review simulation) ─────────────────────────────

echo ""
echo "=== Context file creation (cmd_review simulation) ==="

WORKTREE_TMP="${TMPDIR_TEST}/worktree"
mkdir -p "$WORKTREE_TMP"

# Variables that cmd_review would supply
t_pr_number="123"
t_pr_title="Fix null pointer in auth"
t_pr_author="alice"
t_pr_url="https://github.com/test/repo/pull/123"
t_head_branch="fix/auth-null"
t_base_branch="main"
t_pr_body="Fixes the NPE in AuthService when token is missing."
t_changed_files="src/auth.ts
src/auth.test.ts"

context_rel=".psm/review.md"
context_file="${WORKTREE_TMP}/${context_rel}"
mkdir -p "$(dirname "$context_file")"

psm_render_template "${TEMPLATES_DIR}/pr-review.md" \
    "PR_NUMBER=${t_pr_number}" \
    "PR_TITLE=${t_pr_title}" \
    "PR_AUTHOR=${t_pr_author}" \
    "PR_URL=${t_pr_url}" \
    "HEAD_BRANCH=${t_head_branch}" \
    "BASE_BRANCH=${t_base_branch}" \
    "PR_BODY=${t_pr_body}" \
    "CHANGED_FILES=${t_changed_files}" \
    > "$context_file"

# 21. Context file exists in worktree
assert_file_exists "review context file written to worktree" "$context_file"

context_content=$(cat "$context_file")

# 22-27. All placeholders resolved with correct values
assert_contains "PR number in rendered context" "$t_pr_number" "$context_content"
assert_contains "PR title in rendered context" "$t_pr_title" "$context_content"
assert_contains "PR author in rendered context" "$t_pr_author" "$context_content"
assert_contains "PR URL in rendered context" "$t_pr_url" "$context_content"
assert_contains "head branch in rendered context" "$t_head_branch" "$context_content"
assert_contains "base branch in rendered context" "$t_base_branch" "$context_content"

# 28-31. No unreplaced placeholders remain
assert_not_contains "no {{PR_NUMBER}} leftover"  "{{PR_NUMBER}}"  "$context_content"
assert_not_contains "no {{PR_TITLE}} leftover"   "{{PR_TITLE}}"   "$context_content"
assert_not_contains "no {{PR_AUTHOR}} leftover"  "{{PR_AUTHOR}}"  "$context_content"
assert_not_contains "no {{HEAD_BRANCH}} leftover" "{{HEAD_BRANCH}}" "$context_content"

# ── Context file creation (cmd_fix simulation) ────────────────────────────────

echo ""
echo "=== Context file creation (cmd_fix simulation) ==="

t_issue_number="42"
t_issue_title="Auth fails on token expiry"
t_issue_url="https://github.com/test/repo/issues/42"
t_issue_labels="bug, auth"
t_issue_body="Users get 500 errors after token expires."
t_branch_name="fix/42-auth-token-expiry"

fix_context_rel=".psm/fix.md"
fix_context_file="${WORKTREE_TMP}/${fix_context_rel}"
mkdir -p "$(dirname "$fix_context_file")"

psm_render_template "${TEMPLATES_DIR}/issue-fix.md" \
    "ISSUE_NUMBER=${t_issue_number}" \
    "ISSUE_TITLE=${t_issue_title}" \
    "ISSUE_URL=${t_issue_url}" \
    "ISSUE_LABELS=${t_issue_labels}" \
    "ISSUE_BODY=${t_issue_body}" \
    "BRANCH_NAME=${t_branch_name}" \
    > "$fix_context_file"

# 32. Fix context file exists
assert_file_exists "fix context file written to worktree" "$fix_context_file"

fix_content=$(cat "$fix_context_file")

# 33-35. Key values present
assert_contains "issue number in fix context" "$t_issue_number" "$fix_content"
assert_contains "issue title in fix context" "$t_issue_title" "$fix_content"
assert_contains "branch name in fix context" "$t_branch_name" "$fix_content"

# 36-38. No unreplaced placeholders
assert_not_contains "no {{ISSUE_NUMBER}} leftover"  "{{ISSUE_NUMBER}}"  "$fix_content"
assert_not_contains "no {{ISSUE_TITLE}} leftover"   "{{ISSUE_TITLE}}"   "$fix_content"
assert_not_contains "no {{BRANCH_NAME}} leftover"   "{{BRANCH_NAME}}"   "$fix_content"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
