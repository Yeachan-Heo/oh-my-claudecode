#!/usr/bin/env bash
# Regression tests for PSM Jira provider (issue #3526)
# Root cause: provider_jira_fetch_issue / provider_jira_issue_closed passed
# `--output json` to jira-cli, but jira-cli (v1.7) has no `--output` flag.
# `2>/dev/null` hid the "unknown flag" error, so every fetch returned empty
# with exit 1 and `psm fix <alias>#<n>` aborted. The correct flag is `--raw`.
#
# Usage: bash skills/project-session-manager/tests/test-jira-provider.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSM_LIB_DIR="${SCRIPT_DIR}/../lib"

# ── Test counters ─────────────────────────────────────────────────────────────

PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )) || true; }
fail() { echo "FAIL: $1"; echo "      $2"; (( FAIL++ )) || true; }

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc" "expected to contain: '$needle' | actual: '$haystack'"
    fi
}

assert_not_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc" "expected NOT to contain: '$needle' | actual: '$haystack'"
    fi
}

# ── Setup ─────────────────────────────────────────────────────────────────────

source "${PSM_LIB_DIR}/providers/jira.sh"

# Temp file for capturing argv across command-substitution subshells.
# provider functions run inside $(...), so a plain variable set by the stub
# would be lost with the subshell — write to a file the parent can read.
JIRA_ARGV_FILE="$(mktemp)"
cleanup() { rm -f "$JIRA_ARGV_FILE"; }
trap cleanup EXIT

# Fixture body emitted by the `jira` stub on stdout (raw Jira API JSON shape).
JIRA_STUB_STDOUT=""

# Stub the real `jira` binary. Records argv to a file and emits the fixture body.
# Mirrors real behavior: any unknown flag would go to stderr with exit 2, so a
# regression to `--output json` would produce empty stdout here and fail the
# argv assertions below.
jira() {
    printf '%s' "$*" > "$JIRA_ARGV_FILE"
    if [[ "$*" == *"--output"* ]]; then
        # Simulate jira-cli rejecting the non-existent flag.
        echo "Error: unknown flag: --output" >&2
        return 2
    fi
    printf '%s' "$JIRA_STUB_STDOUT"
}

# Read back the argv captured by the most recent `jira` stub call.
captured_argv() { cat "$JIRA_ARGV_FILE"; }

# ── provider_jira_fetch_issue argv ────────────────────────────────────────────

echo ""
echo "=== provider_jira_fetch_issue argv ==="

JIRA_STUB_STDOUT='{"fields":{"summary":"Example"}}'
: > "$JIRA_ARGV_FILE"
fetch_out=$(provider_jira_fetch_issue "PL-3966")
fetch_argv="$(captured_argv)"

# 1. Uses --raw
assert_contains "fetch_issue passes --raw" "--raw" "$fetch_argv"
# 2. Does NOT pass the non-existent --output flag
assert_not_contains "fetch_issue omits --output" "--output" "$fetch_argv"
# 3. Does NOT pass a bare json subcommand arg
assert_not_contains "fetch_issue omits json arg" "json" "$fetch_argv"
# 4. Targets the issue view subcommand with the key
assert_contains "fetch_issue calls issue view for key" "issue view PL-3966" "$fetch_argv"
# 5. Returns the raw JSON body on stdout
assert_contains "fetch_issue returns raw JSON body" '"summary":"Example"' "$fetch_out"

# ── provider_jira_issue_closed argv + status handling ─────────────────────────

echo ""
echo "=== provider_jira_issue_closed argv + status handling ==="

# statusCategory shape mirrors real `jira issue view <key> --raw` output.
JIRA_STUB_STDOUT='{"fields":{"summary":"Example","status":{"statusCategory":{"key":"done"}}}}'
: > "$JIRA_ARGV_FILE"
if provider_jira_issue_closed "PL-3966"; then
    closed_done_rc=0
else
    closed_done_rc=$?
fi
closed_argv="$(captured_argv)"

# 6. Uses --raw
assert_contains "issue_closed passes --raw" "--raw" "$closed_argv"
# 7. Does NOT pass --output
assert_not_contains "issue_closed omits --output" "--output" "$closed_argv"

# 8. done -> closed (exit 0)
if [[ "$closed_done_rc" -eq 0 ]]; then
    pass "issue_closed returns 0 for statusCategory 'done'"
else
    fail "issue_closed returns 0 for statusCategory 'done'" "exit=$closed_done_rc"
fi

# 9. indeterminate -> not closed (non-zero) — the exact value from the issue report
JIRA_STUB_STDOUT='{"fields":{"summary":"Example","status":{"statusCategory":{"key":"indeterminate"}}}}'
if provider_jira_issue_closed "PL-3966"; then
    closed_indeterminate_rc=0
else
    closed_indeterminate_rc=$?
fi
if [[ "$closed_indeterminate_rc" -ne 0 ]]; then
    pass "issue_closed returns non-zero for statusCategory 'indeterminate'"
else
    fail "issue_closed returns non-zero for statusCategory 'indeterminate'" "exit=$closed_indeterminate_rc"
fi

# 10. new -> not closed (non-zero)
JIRA_STUB_STDOUT='{"fields":{"status":{"statusCategory":{"key":"new"}}}}'
if provider_jira_issue_closed "PL-3966"; then
    closed_new_rc=0
else
    closed_new_rc=$?
fi
if [[ "$closed_new_rc" -ne 0 ]]; then
    pass "issue_closed returns non-zero for statusCategory 'new'"
else
    fail "issue_closed returns non-zero for statusCategory 'new'" "exit=$closed_new_rc"
fi

# ── Regression guard: --output json would break both paths ────────────────────

echo ""
echo "=== regression guard ==="

# If the code regressed to `--output json`, the stub returns empty with exit 2,
# so fetch would be empty and issue_closed could never see 'done'.
assert_not_contains "no --output regression in fetch argv" "--output" "$fetch_argv"
assert_not_contains "no --output regression in issue_closed argv" "--output" "$closed_argv"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
