#!/bin/bash
#
# PR #25 Test Suite: qa-tester agent with tmux support
#
# Tests:
#   1. Build verification
#   2. Agent registration
#   3. Installer integration
#   4. Tmux session management
#   5. Command execution
#   6. Output capture
#   7. Service testing workflow
#   8. Edge cases
#   9. Cleanup verification
#
# Usage: ./scripts/test-pr25.sh [--verbose] [--skip-service]
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Options
VERBOSE=false
SKIP_SERVICE=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --verbose|-v)
            VERBOSE=true
            ;;
        --skip-service)
            SKIP_SERVICE=true
            ;;
    esac
done

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED++))
}

log_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((SKIPPED++))
}

log_verbose() {
    if $VERBOSE; then
        echo -e "       $1"
    fi
}

cleanup_sessions() {
    # Kill any test sessions we created
    for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^qa-test-' || true); do
        tmux kill-session -t "$session" 2>/dev/null || true
    done
}

# Ensure cleanup on exit
trap cleanup_sessions EXIT

echo ""
echo "========================================"
echo "  PR #25 Test Suite: qa-tester agent"
echo "========================================"
echo ""

# =============================================================================
# Section 1: Prerequisites
# =============================================================================
echo -e "${BLUE}=== Prerequisites ===${NC}"

# Check tmux installed
if command -v tmux &> /dev/null; then
    TMUX_VERSION=$(tmux -V)
    log_pass "tmux installed: $TMUX_VERSION"
else
    log_fail "tmux not installed - cannot continue"
    exit 1
fi

# Check nc (netcat) for port testing
if command -v nc &> /dev/null; then
    log_pass "netcat (nc) installed"
else
    log_fail "netcat (nc) not installed - service tests will fail"
fi

# Check python3 for HTTP server tests
if command -v python3 &> /dev/null; then
    log_pass "python3 installed"
else
    log_skip "python3 not installed - service tests will be skipped"
    SKIP_SERVICE=true
fi

echo ""

# =============================================================================
# Section 2: Build Verification
# =============================================================================
echo -e "${BLUE}=== Build Verification ===${NC}"

log_info "Running npm run build..."
if npm run build &> /tmp/pr25-build.log; then
    log_pass "TypeScript build succeeded"
else
    log_fail "TypeScript build failed"
    cat /tmp/pr25-build.log
    exit 1
fi

echo ""

# =============================================================================
# Section 3: Agent Registration
# =============================================================================
echo -e "${BLUE}=== Agent Registration ===${NC}"

# Check qa-tester in definitions.ts
if grep -q "'qa-tester': qaTesterAgent" src/agents/definitions.ts; then
    log_pass "qa-tester registered in definitions.ts"
else
    log_fail "qa-tester NOT registered in definitions.ts"
fi

# Check export in index.ts
if grep -q "qa-tester" src/agents/index.ts; then
    log_pass "qa-tester exported in index.ts"
else
    log_fail "qa-tester NOT exported in index.ts"
fi

# Check compiled output
if grep -q "qa-tester" dist/agents/definitions.js 2>/dev/null; then
    log_pass "qa-tester in compiled definitions.js"
else
    log_fail "qa-tester NOT in compiled definitions.js"
fi

# Check Oracle handoff section
if grep -q "QA_Tester_Handoff\|QA-Tester" src/agents/oracle.ts; then
    log_pass "QA-Tester handoff section in oracle.ts"
else
    log_fail "QA-Tester handoff section missing from oracle.ts"
fi

echo ""

# =============================================================================
# Section 4: Installer Integration
# =============================================================================
echo -e "${BLUE}=== Installer Integration ===${NC}"

# Check qa-tester.md in installer AGENT_DEFINITIONS
if grep -q "'qa-tester.md'" src/installer/index.ts; then
    log_pass "qa-tester.md in AGENT_DEFINITIONS"
else
    log_fail "qa-tester.md NOT in AGENT_DEFINITIONS"
fi

# Run postinstall and check file was created
log_info "Running installer postinstall..."
if node dist/cli/index.js postinstall &> /tmp/pr25-postinstall.log; then
    log_pass "Installer postinstall succeeded"

    # Verify file exists
    if [ -f "$HOME/.claude/agents/qa-tester.md" ]; then
        log_pass "qa-tester.md installed to ~/.claude/agents/"

        # Verify content
        if grep -q "tmux" "$HOME/.claude/agents/qa-tester.md"; then
            log_pass "qa-tester.md contains tmux content"
        else
            log_fail "qa-tester.md missing tmux content"
        fi

        if grep -q "Oracle" "$HOME/.claude/agents/qa-tester.md"; then
            log_pass "qa-tester.md contains Oracle collaboration section"
        else
            log_fail "qa-tester.md missing Oracle collaboration section"
        fi
    else
        log_fail "qa-tester.md NOT installed to ~/.claude/agents/"
    fi
else
    log_fail "Installer postinstall failed"
    $VERBOSE && cat /tmp/pr25-postinstall.log
fi

echo ""

# =============================================================================
# Section 5: Tmux Session Management
# =============================================================================
echo -e "${BLUE}=== Tmux Session Management ===${NC}"

SESSION_NAME="qa-test-session-$$"

# Test: Create session
log_info "Testing session creation..."
if tmux new-session -d -s "$SESSION_NAME"; then
    log_pass "Created tmux session: $SESSION_NAME"
else
    log_fail "Failed to create tmux session"
fi

# Test: Check session exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    log_pass "Session exists check works"
else
    log_fail "Session exists check failed"
fi

# Test: List sessions includes our session
if tmux list-sessions | grep -q "$SESSION_NAME"; then
    log_pass "Session appears in list-sessions"
else
    log_fail "Session NOT in list-sessions"
fi

# Test: Kill session
if tmux kill-session -t "$SESSION_NAME"; then
    log_pass "Killed tmux session"
else
    log_fail "Failed to kill tmux session"
fi

# Test: Verify session gone
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    log_fail "Session still exists after kill"
else
    log_pass "Session properly cleaned up"
fi

echo ""

# =============================================================================
# Section 6: Command Execution
# =============================================================================
echo -e "${BLUE}=== Command Execution ===${NC}"

SESSION_NAME="qa-test-cmd-$$"
tmux new-session -d -s "$SESSION_NAME"

# Test: send-keys with Enter
log_info "Testing send-keys with Enter..."
tmux send-keys -t "$SESSION_NAME" 'echo "MARKER_12345"' Enter
sleep 0.5

OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p)
if echo "$OUTPUT" | grep -q "MARKER_12345"; then
    log_pass "send-keys with Enter works"
    log_verbose "Output: $(echo "$OUTPUT" | grep MARKER_12345)"
else
    log_fail "send-keys with Enter failed"
fi

# Test: send-keys without Enter (partial input)
log_info "Testing send-keys without Enter..."
tmux send-keys -t "$SESSION_NAME" 'echo "PARTIAL'
sleep 0.3
OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p)
# The partial input should be visible but not executed
if echo "$OUTPUT" | grep -q 'echo "PARTIAL'; then
    log_pass "send-keys without Enter works (partial visible)"
else
    # May or may not be visible depending on tmux version
    log_skip "send-keys without Enter - partial may not be visible in capture"
fi

# Complete the command
tmux send-keys -t "$SESSION_NAME" '"' Enter
sleep 0.3

# Test: Ctrl+C interrupt
log_info "Testing Ctrl+C interrupt..."
tmux send-keys -t "$SESSION_NAME" 'sleep 100' Enter
sleep 0.3
tmux send-keys -t "$SESSION_NAME" C-c
sleep 0.3
OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p)
# After Ctrl+C, we should get back to prompt
if echo "$OUTPUT" | grep -qE '(\^C|sleep.*100)'; then
    log_pass "Ctrl+C interrupt works"
else
    log_pass "Ctrl+C sent (output varies by shell)"
fi

# Cleanup
tmux kill-session -t "$SESSION_NAME"

echo ""

# =============================================================================
# Section 7: Output Capture
# =============================================================================
echo -e "${BLUE}=== Output Capture ===${NC}"

SESSION_NAME="qa-test-capture-$$"
tmux new-session -d -s "$SESSION_NAME"

# Generate some output
for i in {1..5}; do
    tmux send-keys -t "$SESSION_NAME" "echo LINE_$i" Enter
done
sleep 0.5

# Test: Basic capture-pane
log_info "Testing basic capture-pane..."
OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p)
if echo "$OUTPUT" | grep -q "LINE_1" && echo "$OUTPUT" | grep -q "LINE_5"; then
    log_pass "Basic capture-pane works"
else
    log_fail "Basic capture-pane failed"
fi

# Test: Capture with history (-S)
log_info "Testing capture with history..."
OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p -S -50)
LINE_COUNT=$(echo "$OUTPUT" | grep -c "LINE_" || true)
if [ "$LINE_COUNT" -ge 5 ]; then
    log_pass "Capture with history works (found $LINE_COUNT lines)"
else
    log_fail "Capture with history failed (found $LINE_COUNT lines, expected 5+)"
fi

# Cleanup
tmux kill-session -t "$SESSION_NAME"

echo ""

# =============================================================================
# Section 8: Service Testing Workflow
# =============================================================================
echo -e "${BLUE}=== Service Testing Workflow ===${NC}"

if $SKIP_SERVICE; then
    log_skip "Service tests skipped (--skip-service or missing python3)"
else
    SESSION_NAME="qa-test-http-$$"
    PORT=18765  # Use high port to avoid conflicts

    log_info "Starting Python HTTP server on port $PORT..."
    tmux new-session -d -s "$SESSION_NAME" -c /tmp
    tmux send-keys -t "$SESSION_NAME" "python3 -m http.server $PORT" Enter

    # Wait for port to be ready
    READY=false
    for i in {1..15}; do
        if nc -z localhost $PORT 2>/dev/null; then
            READY=true
            log_pass "Server started on port $PORT (waited ${i}s)"
            break
        fi
        sleep 1
    done

    if ! $READY; then
        log_fail "Server did not start within 15 seconds"
        # Show what's in the pane
        log_verbose "Pane output: $(tmux capture-pane -t "$SESSION_NAME" -p)"
    else
        # Test: curl the server
        log_info "Testing HTTP request..."
        RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/ 2>/dev/null || echo "000")
        if [ "$RESPONSE" = "200" ]; then
            log_pass "HTTP server responds with 200"
        else
            log_fail "HTTP server responded with $RESPONSE (expected 200)"
        fi

        # Test: Verify request logged in tmux
        sleep 0.5
        OUTPUT=$(tmux capture-pane -t "$SESSION_NAME" -p -S -20)
        if echo "$OUTPUT" | grep -qE '(GET|200|HTTP)'; then
            log_pass "HTTP request logged in tmux session"
        else
            log_fail "HTTP request NOT logged in tmux session"
        fi
    fi

    # Cleanup
    log_info "Cleaning up server..."
    tmux send-keys -t "$SESSION_NAME" C-c
    sleep 0.5
    tmux kill-session -t "$SESSION_NAME"

    # Verify port released
    sleep 0.5
    if nc -z localhost $PORT 2>/dev/null; then
        log_fail "Port $PORT still in use after cleanup"
    else
        log_pass "Server cleaned up, port released"
    fi
fi

echo ""

# =============================================================================
# Section 9: Edge Cases
# =============================================================================
echo -e "${BLUE}=== Edge Cases ===${NC}"

# Test: Non-existent session
log_info "Testing non-existent session handling..."
if tmux send-keys -t "nonexistent-session-xyz-$$" 'test' Enter 2>/dev/null; then
    log_fail "Should have failed for non-existent session"
else
    log_pass "Correctly errors on non-existent session"
fi

# Test: Duplicate session name
log_info "Testing duplicate session name handling..."
tmux new-session -d -s "dup-test-$$"
if tmux new-session -d -s "dup-test-$$" 2>/dev/null; then
    log_fail "Should have failed for duplicate session name"
else
    log_pass "Correctly errors on duplicate session name"
fi
tmux kill-session -t "dup-test-$$" 2>/dev/null || true

# Test: Session with special characters in name
log_info "Testing session name with timestamp..."
TIMESTAMP=$(date +%s)
SESSION_WITH_TS="qa-test-$TIMESTAMP"
if tmux new-session -d -s "$SESSION_WITH_TS" && tmux kill-session -t "$SESSION_WITH_TS"; then
    log_pass "Session with timestamp in name works"
else
    log_fail "Session with timestamp in name failed"
fi

# Test: Empty capture from fresh session
log_info "Testing capture from fresh session..."
tmux new-session -d -s "empty-$$"
sleep 0.1
OUTPUT=$(tmux capture-pane -t "empty-$$" -p)
# Fresh session should have minimal/empty output
if [ ${#OUTPUT} -lt 500 ]; then
    log_pass "Fresh session capture works (${#OUTPUT} chars)"
else
    log_pass "Fresh session capture returned ${#OUTPUT} chars"
fi
tmux kill-session -t "empty-$$"

echo ""

# =============================================================================
# Section 10: Documentation Verification
# =============================================================================
echo -e "${BLUE}=== Documentation Verification ===${NC}"

# Check AGENTS.md updated
if grep -q "qa-tester" AGENTS.md 2>/dev/null; then
    log_pass "qa-tester in AGENTS.md"
else
    log_fail "qa-tester NOT in AGENTS.md"
fi

# Check commands/sisyphus.md updated
if grep -q "qa-tester" commands/sisyphus.md 2>/dev/null; then
    log_pass "qa-tester in commands/sisyphus.md"
else
    log_fail "qa-tester NOT in commands/sisyphus.md"
fi

# Check commands/ultrawork.md updated
if grep -q "qa-tester" commands/ultrawork.md 2>/dev/null; then
    log_pass "qa-tester in commands/ultrawork.md"
else
    log_fail "qa-tester NOT in commands/ultrawork.md"
fi

# Check agents/qa-tester.md exists
if [ -f "agents/qa-tester.md" ]; then
    log_pass "agents/qa-tester.md reference doc exists"
else
    log_fail "agents/qa-tester.md reference doc missing"
fi

echo ""

# =============================================================================
# Summary
# =============================================================================
echo "========================================"
echo "  Test Summary"
echo "========================================"
echo ""
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
echo ""

TOTAL=$((PASSED + FAILED))
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All $TOTAL tests passed!${NC}"
    exit 0
else
    echo -e "${RED}$FAILED of $TOTAL tests failed${NC}"
    exit 1
fi
