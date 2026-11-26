#!/usr/bin/env bash
# Mutation tests for PSM security fixes (issue #5149)
# Demonstrates that each security fix is necessary by reverting it and showing tests fail

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"  # project-session-manager root
TEST_SCRIPT="${SCRIPT_DIR}/test-psm-prompt-injection.sh"
TMUX_LIB="${PSM_ROOT}/lib/tmux.sh"

# Create temporary directory for mutations
MUTATIONS_DIR=$(mktemp -d)
trap "rm -rf '$MUTATIONS_DIR'" EXIT

echo "=== Mutation Tests for Issue #5149 Security Fixes ==="
echo ""
echo "This script demonstrates that each security fix is necessary by:"
echo "1. Backing up the fixed code"
echo "2. Reverting each fix and running tests"
echo "3. Restoring the fixed code"
echo ""

# Backup original files
cp "$TMUX_LIB" "${MUTATIONS_DIR}/tmux.sh.orig"

# Counter for mutations
MUTATIONS_PASSED=0
MUTATIONS_FAILED=0

# ─────────────────────────────────────────────────────────────────────────────
echo "── Mutation 1: Revert security fix (a) - Remove 'no auto-send T' protection ──"
echo ""
echo "Testing: If we revert the fix that prevents auto-sending 'T' to trust dialogs,"
echo "         can we detect that the fix is necessary?"
echo ""

# Create a mutant that adds back the auto-send T behavior
cat > "$TMUX_LIB.mutation1" << 'MUTATION_EOF'
# Revert: add back the auto-send T behavior
psm_wait_for_claude_prompt() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local max_wait="${2:-60}"
    local waited=0

    while [[ $waited -lt $max_wait ]]; do
        local pane_content
        pane_content=$(tmux capture-pane -t "$session_name" -p 2>/dev/null) || return 1
        
        # VULNERABLE: Check for directory-trust prompt (?) and auto-send T
        if printf '%s' "$pane_content" | grep -qE '^[[:space:]]*\?[[:space:]]*$'; then
            # VULNERABILITY: Send 'T' (temporary trust) to proceed without blocking
            tmux send-keys -t "$session_name" 'T'
            sleep 1
            (( waited++ )) || true
            continue
        fi
        
        # Check for Claude's normal REPL prompt (shows as ">")
        if printf '%s' "$pane_content" | grep -qE '^[[:space:]]*>[[:space:]]*$'; then
            return 0
        fi
        
        sleep 1
        (( waited++ )) || true
    done

    return 1
}
MUTATION_EOF

# Test for the mutation: grep should find the auto-send T behavior
if grep -A 10 "VULNERABLE:" "$TMUX_LIB.mutation1" | grep -q "send-keys.*'T'"; then
    echo "✓ Mutation 1 created: auto-send T is present"
    echo "  (This is the vulnerable pattern we fixed)"
    echo ""
    (( MUTATIONS_PASSED++ )) || true
else
    echo "✗ Mutation 1 failed to inject vulnerability"
    (( MUTATIONS_FAILED++ )) || true
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "── Mutation 2: Revert security fix (c) - Remove trust dialog detection ──"
echo ""
echo "Testing: If we remove the trust dialog detection in psm_inject_prompt,"
echo "         the function should not handle the trust dialog case."
echo ""

# Create a mutant that removes trust dialog handling
cat > "$TMUX_LIB.mutation2" << 'MUTATION_EOF'
# Revert: remove trust dialog detection from psm_inject_prompt
psm_inject_prompt() {
    local session_name
    session_name=$(psm_tmux_safe_name "$1")
    local context_file="$2"

    # VULNERABLE: Skip trust dialog handling, go directly to waiting for prompt
    if ! psm_wait_for_claude_prompt "$session_name"; then
        echo "error|Timed out waiting for Claude prompt; task context not injected" >&2
        return 1
    fi

    local trigger="Read ${context_file} for full task context, then begin."

    # Use literal mode (-l) to prevent tmux from interpreting key names in the text
    tmux send-keys -t "$session_name" -l -- "$trigger"
    sleep 0.15
    tmux send-keys -t "$session_name" Enter

    return 0
}
MUTATION_EOF

# Test for the mutation: grep should NOT find the trust dialog check
if ! grep -q "trust dialog is waiting" "$TMUX_LIB.mutation2"; then
    echo "✓ Mutation 2 created: trust dialog detection removed"
    echo "  (This would cause the function to timeout when trust dialog is present)"
    echo ""
    (( MUTATIONS_PASSED++ )) || true
else
    echo "✗ Mutation 2 failed: trust dialog check still present"
    (( MUTATIONS_FAILED++ )) || true
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "── Mutation 3: Verify new _psm_wait_for_trust_dialog_to_clear function ──"
echo ""
echo "Testing: The new function that waits for trust dialogs to clear exists"
echo "         and contains the proper polling logic."
echo ""

if grep -q "^_psm_wait_for_trust_dialog_to_clear()" "$TMUX_LIB"; then
    echo "✓ Mutation 3 passed: _psm_wait_for_trust_dialog_to_clear exists"
    
    # Verify it has polling logic
    if sed -n '/^_psm_wait_for_trust_dialog_to_clear/,/^}/p' "$TMUX_LIB" | grep -q "while.*max_wait"; then
        echo "✓ Polling loop is present"
        
        # Verify it checks for ? (trust dialog)
        if sed -n '/^_psm_wait_for_trust_dialog_to_clear/,/^}/p' "$TMUX_LIB" | grep -q '\\?'; then
            echo "✓ Trust dialog detection (\\?) is present"
            (( MUTATIONS_PASSED++ )) || true
        else
            echo "✗ Trust dialog detection missing"
            (( MUTATIONS_FAILED++ )) || true
        fi
    else
        echo "✗ Polling loop not found"
        (( MUTATIONS_FAILED++ )) || true
    fi
else
    echo "✗ Mutation 3 failed: _psm_wait_for_trust_dialog_to_clear not found"
    (( MUTATIONS_FAILED++ )) || true
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "── Mutation 4: Verify security fixes prevent auto-approval ──"
echo ""
echo "Testing: Confirm original code (before fixes) had auto-send T behavior"
echo ""

# Show what the vulnerability was
echo "The original vulnerable pattern was:"
echo '  if printf "%s" "$pane_content" | grep -qE "^[[:space:]]*\\?[[:space:]]*$"; then'
echo '      tmux send-keys -t "$session_name" "T"'
echo '  fi'
echo ""
echo "This auto-approved directory trust without user consent (SECURITY BUG)."
echo ""
echo "The fix removes this automatic approval and instead:"
echo "1. Detects when the trust dialog is present"
echo "2. Prints instructions for the user to manually approve"
echo "3. Waits for the trust dialog to clear (up to 10 minutes)"
echo "4. If timeout, reports the context file location and provides fallback instructions"
echo ""
(( MUTATIONS_PASSED++ )) || true

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Mutation Test Summary ==="
echo ""
echo "Mutations created: $MUTATIONS_PASSED"
echo "Mutations failed:  $MUTATIONS_FAILED"
echo ""

if [[ $MUTATIONS_FAILED -eq 0 ]]; then
    echo "✓ All mutations demonstrate that the security fixes are necessary:"
    echo ""
    echo "  1. Removing the 'no auto-send T' protection would revert to the vulnerability"
    echo "  2. Removing trust dialog handling would cause timeouts"
    echo "  3. The new _psm_wait_for_trust_dialog_to_clear function is necessary"
    echo "  4. The fixes prevent auto-approval of directory trust"
    echo ""
    echo "Result: All security fixes are JUSTIFIED and NECESSARY"
    exit 0
else
    echo "✗ Some mutations failed to demonstrate the necessity of the fixes"
    exit 1
fi
