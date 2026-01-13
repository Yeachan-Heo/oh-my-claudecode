#!/bin/bash
# Sisyphus Persistent Mode Hook
# Unified handler for ultrawork, ralph-loop, and todo continuation
# Prevents stopping when work remains incomplete

# Read stdin
INPUT=$(cat)

# Get session ID and directory
SESSION_ID=""
DIRECTORY=""
if command -v jq &> /dev/null; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.sessionId // .session_id // ""' 2>/dev/null)
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
fi

# Default to current directory
if [ -z "$DIRECTORY" ]; then
  DIRECTORY=$(pwd)
fi

# Check for active ultrawork state
ULTRAWORK_STATE=""
if [ -f "$DIRECTORY/.sisyphus/ultrawork-state.json" ]; then
  ULTRAWORK_STATE=$(cat "$DIRECTORY/.sisyphus/ultrawork-state.json" 2>/dev/null)
elif [ -f "$HOME/.claude/ultrawork-state.json" ]; then
  ULTRAWORK_STATE=$(cat "$HOME/.claude/ultrawork-state.json" 2>/dev/null)
fi

# Check for active ralph loop
RALPH_STATE=""
if [ -f "$DIRECTORY/.sisyphus/ralph-state.json" ]; then
  RALPH_STATE=$(cat "$DIRECTORY/.sisyphus/ralph-state.json" 2>/dev/null)
fi

# Check for verification state (oracle verification)
VERIFICATION_STATE=""
if [ -f "$DIRECTORY/.sisyphus/ralph-verification.json" ]; then
  VERIFICATION_STATE=$(cat "$DIRECTORY/.sisyphus/ralph-verification.json" 2>/dev/null)
fi

# Check for incomplete todos
INCOMPLETE_COUNT=0
TODOS_DIR="$HOME/.claude/todos"
if [ -d "$TODOS_DIR" ]; then
  for todo_file in "$TODOS_DIR"/*.json; do
    if [ -f "$todo_file" ]; then
      if command -v jq &> /dev/null; then
        COUNT=$(jq '[.[] | select(.status != "completed" and .status != "cancelled")] | length' "$todo_file" 2>/dev/null || echo "0")
        INCOMPLETE_COUNT=$((INCOMPLETE_COUNT + COUNT))
      else
        # Fallback: count "pending" or "in_progress" occurrences
        COUNT=$(grep -c '"status"[[:space:]]*:[[:space:]]*"pending\|in_progress"' "$todo_file" 2>/dev/null) || COUNT=0
        INCOMPLETE_COUNT=$((INCOMPLETE_COUNT + COUNT))
      fi
    fi
  done
fi

# Check project todos as well
for todo_path in "$DIRECTORY/.sisyphus/todos.json" "$DIRECTORY/.claude/todos.json"; do
  if [ -f "$todo_path" ]; then
    if command -v jq &> /dev/null; then
      COUNT=$(jq 'if type == "array" then [.[] | select(.status != "completed" and .status != "cancelled")] | length else 0 end' "$todo_path" 2>/dev/null || echo "0")
      INCOMPLETE_COUNT=$((INCOMPLETE_COUNT + COUNT))
    else
      # Fallback: count "pending" or "in_progress" occurrences
      COUNT=$(grep -c '"status"[[:space:]]*:[[:space:]]*"pending\|in_progress"' "$todo_path" 2>/dev/null) || COUNT=0
      INCOMPLETE_COUNT=$((INCOMPLETE_COUNT + COUNT))
    fi
  fi
done

# Priority 1: Ralph Loop with Oracle Verification
if [ -n "$RALPH_STATE" ]; then
  IS_ACTIVE=$(echo "$RALPH_STATE" | jq -r '.active // false' 2>/dev/null)
  if [ "$IS_ACTIVE" = "true" ]; then
    ITERATION=$(echo "$RALPH_STATE" | jq -r '.iteration // 1' 2>/dev/null)
    MAX_ITER=$(echo "$RALPH_STATE" | jq -r '.max_iterations // 10' 2>/dev/null)
    PROMISE=$(echo "$RALPH_STATE" | jq -r '.completion_promise // "TASK_COMPLETE"' 2>/dev/null)
    PROMPT=$(echo "$RALPH_STATE" | jq -r '.prompt // ""' 2>/dev/null)

    # Check if oracle verification is pending
    if [ -n "$VERIFICATION_STATE" ]; then
      IS_PENDING=$(echo "$VERIFICATION_STATE" | jq -r '.pending // false' 2>/dev/null)
      if [ "$IS_PENDING" = "true" ]; then
        ATTEMPT=$(echo "$VERIFICATION_STATE" | jq -r '.verification_attempts // 0' 2>/dev/null)
        MAX_ATTEMPTS=$(echo "$VERIFICATION_STATE" | jq -r '.max_verification_attempts // 3' 2>/dev/null)
        ORIGINAL_TASK=$(echo "$VERIFICATION_STATE" | jq -r '.original_task // ""' 2>/dev/null)
        COMPLETION_CLAIM=$(echo "$VERIFICATION_STATE" | jq -r '.completion_claim // ""' 2>/dev/null)
        ORACLE_FEEDBACK=$(echo "$VERIFICATION_STATE" | jq -r '.oracle_feedback // ""' 2>/dev/null)
        NEXT_ATTEMPT=$((ATTEMPT + 1))

        FEEDBACK_SECTION=""
        if [ -n "$ORACLE_FEEDBACK" ] && [ "$ORACLE_FEEDBACK" != "null" ]; then
          FEEDBACK_SECTION="\n**Previous Oracle Feedback (rejected):**\n$ORACLE_FEEDBACK\n"
        fi

        cat << EOF
{"continue": false, "reason": "<ralph-verification>\n\n[ORACLE VERIFICATION REQUIRED - Attempt $NEXT_ATTEMPT/$MAX_ATTEMPTS]\n\nThe agent claims the task is complete. Before accepting, YOU MUST verify with Oracle.\n\n**Original Task:**\n$ORIGINAL_TASK\n\n**Completion Claim:**\n$COMPLETION_CLAIM\n$FEEDBACK_SECTION\n## MANDATORY VERIFICATION STEPS\n\n1. **Spawn Oracle Agent** for verification:\n   \`\`\`\n   Task(subagent_type=\"oracle\", prompt=\"Verify this task completion claim...\")\n   \`\`\`\n\n2. **Oracle must check:**\n   - Are ALL requirements from the original task met?\n   - Is the implementation complete, not partial?\n   - Are there any obvious bugs or issues?\n   - Does the code compile/run without errors?\n   - Are tests passing (if applicable)?\n\n3. **Based on Oracle's response:**\n   - If APPROVED: Output \`<oracle-approved>VERIFIED_COMPLETE</oracle-approved>\`\n   - If REJECTED: Continue working on the identified issues\n\nDO NOT output the completion promise again until Oracle approves.\n\n</ralph-verification>\n\n---\n"}
EOF
        exit 0
      fi
    fi

    if [ "$ITERATION" -lt "$MAX_ITER" ]; then
      # Increment iteration
      NEW_ITER=$((ITERATION + 1))
      echo "$RALPH_STATE" | jq ".iteration = $NEW_ITER" > "$DIRECTORY/.sisyphus/ralph-state.json" 2>/dev/null

      cat << EOF
{"continue": false, "reason": "<ralph-loop-continuation>\n\n[RALPH LOOP - ITERATION $NEW_ITER/$MAX_ITER]\n\nYour previous attempt did not output the completion promise. The work is NOT done yet.\n\nCRITICAL INSTRUCTIONS:\n1. Review your progress and the original task\n2. Check your todo list - are ALL items marked complete?\n3. Continue from where you left off\n4. When FULLY complete, output: <promise>$PROMISE</promise>\n5. Do NOT stop until the task is truly done\n\nOriginal task: $PROMPT\n\n</ralph-loop-continuation>\n\n---\n"}
EOF
      exit 0
    fi
  fi
fi

# Priority 1.5: Verification Requirements (build/test/git/background)
VERIFICATION_FAILURES=()

# Check 1: Build verification
BUILD_ISSUES=""
if [ -f "$DIRECTORY/package.json" ]; then
  if command -v jq &> /dev/null; then
    BUILD_SCRIPT=$(jq -r '.scripts.build // empty' "$DIRECTORY/package.json" 2>/dev/null)
    if [ -n "$BUILD_SCRIPT" ]; then
      # Check if build directory exists or recent build artifacts
      if [ ! -d "$DIRECTORY/dist" ] && [ ! -d "$DIRECTORY/build" ] && [ ! -d "$DIRECTORY/out" ]; then
        BUILD_ISSUES="Build script exists but no build artifacts found (dist/build/out). Run 'npm run build' to verify."
      fi
    fi
  fi
elif [ -f "$DIRECTORY/Makefile" ]; then
  # Check for common make targets
  if grep -q "^build:" "$DIRECTORY/Makefile" 2>/dev/null; then
    BUILD_ISSUES="Makefile with build target detected. Run 'make build' to verify before stopping."
  fi
elif [ -f "$DIRECTORY/Cargo.toml" ]; then
  # Check for Rust build artifacts
  if [ ! -d "$DIRECTORY/target/release" ] && [ ! -d "$DIRECTORY/target/debug" ]; then
    BUILD_ISSUES="Rust project detected but no build artifacts found. Run 'cargo build' to verify."
  fi
fi

if [ -n "$BUILD_ISSUES" ]; then
  VERIFICATION_FAILURES+=("BUILD: $BUILD_ISSUES")
fi

# Check 2: Test failures in recent output
TEST_ISSUES=""
if [ -f "$DIRECTORY/package.json" ]; then
  if command -v jq &> /dev/null; then
    TEST_SCRIPT=$(jq -r '.scripts.test // empty' "$DIRECTORY/package.json" 2>/dev/null)
    if [ -n "$TEST_SCRIPT" ]; then
      # Check for test artifacts or recent test run indicators
      TEST_ISSUES="Test script exists. Run 'npm test' to verify all tests pass before stopping."
    fi
  fi
elif [ -f "$DIRECTORY/pytest.ini" ] || [ -f "$DIRECTORY/setup.py" ] || [ -d "$DIRECTORY/tests" ]; then
  TEST_ISSUES="Python test directory/config detected. Run tests to verify before stopping."
elif [ -f "$DIRECTORY/Cargo.toml" ]; then
  TEST_ISSUES="Rust project detected. Run 'cargo test' to verify before stopping."
fi

# Check for recent test failure indicators in common log locations
for log_file in "$DIRECTORY/test-results.log" "$DIRECTORY/.test-output" "$HOME/.claude/last-test-run.log"; do
  if [ -f "$log_file" ]; then
    if grep -qi "FAIL\|ERROR\|failed" "$log_file" 2>/dev/null; then
      TEST_ISSUES="Recent test failures detected in $log_file. Fix failures before stopping."
      break
    fi
  fi
done

if [ -n "$TEST_ISSUES" ]; then
  VERIFICATION_FAILURES+=("TEST: $TEST_ISSUES")
fi

# Check 3: Git status - uncommitted changes
GIT_ISSUES=""
if [ -d "$DIRECTORY/.git" ]; then
  # Check for uncommitted changes
  cd "$DIRECTORY" 2>/dev/null
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    CHANGED_FILES=$(git status --porcelain 2>/dev/null | wc -l)
    GIT_ISSUES="$CHANGED_FILES uncommitted file(s). Consider committing changes or verify they should be discarded."
  fi
  # Check for unpushed commits
  UNPUSHED=$(git log @{u}.. --oneline 2>/dev/null | wc -l)
  if [ "$UNPUSHED" -gt 0 ]; then
    if [ -n "$GIT_ISSUES" ]; then
      GIT_ISSUES="$GIT_ISSUES Also, $UNPUSHED unpushed commit(s) exist."
    else
      GIT_ISSUES="$UNPUSHED unpushed commit(s). Consider pushing to remote or verify local-only is intended."
    fi
  fi
fi

if [ -n "$GIT_ISSUES" ]; then
  VERIFICATION_FAILURES+=("GIT: $GIT_ISSUES")
fi

# Check 4: Background tasks still running
BACKGROUND_ISSUES=""
BACKGROUND_DIR="$HOME/.claude/background-tasks"
if [ -d "$BACKGROUND_DIR" ]; then
  RUNNING_TASKS=0
  for task_file in "$BACKGROUND_DIR"/*.json; do
    if [ -f "$task_file" ]; then
      if command -v jq &> /dev/null; then
        STATUS=$(jq -r '.status // ""' "$task_file" 2>/dev/null)
        if [ "$STATUS" = "running" ] || [ "$STATUS" = "pending" ]; then
          RUNNING_TASKS=$((RUNNING_TASKS + 1))
        fi
      else
        # Fallback: check for running/pending status
        if grep -q '"status"[[:space:]]*:[[:space:]]*"running\|pending"' "$task_file" 2>/dev/null; then
          RUNNING_TASKS=$((RUNNING_TASKS + 1))
        fi
      fi
    fi
  done

  if [ "$RUNNING_TASKS" -gt 0 ]; then
    BACKGROUND_ISSUES="$RUNNING_TASKS background task(s) still running. Wait for completion or verify results."
  fi
fi

if [ -n "$BACKGROUND_ISSUES" ]; then
  VERIFICATION_FAILURES+=("BACKGROUND: $BACKGROUND_ISSUES")
fi

# If any verification failures exist, block stopping
if [ ${#VERIFICATION_FAILURES[@]} -gt 0 ]; then
  FAILURE_LIST=""
  for failure in "${VERIFICATION_FAILURES[@]}"; do
    FAILURE_LIST="$FAILURE_LIST\n- $failure"
  done

  cat << EOF
{"continue": false, "reason": "<verification-requirements>\n\n[VERIFICATION REQUIREMENTS NOT MET]\n\nBefore stopping, you must address the following verification requirements:\n$FAILURE_LIST\n\n## REQUIRED ACTIONS:\n\n1. **Build Verification**: If build scripts exist, run them and verify success\n2. **Test Verification**: Run all tests and ensure they pass\n3. **Git Status**: Review uncommitted/unpushed changes - commit or verify intentional\n4. **Background Tasks**: Wait for or check results of running background tasks\n\n**You cannot stop until these verifications are complete.**\n\nAddress each issue above, then you may conclude.\n\n</verification-requirements>\n\n---\n"}
EOF
  exit 0
fi

# Priority 2: Ultrawork Mode with incomplete todos
if [ -n "$ULTRAWORK_STATE" ] && [ "$INCOMPLETE_COUNT" -gt 0 ]; then
  # Check if active (with jq fallback)
  IS_ACTIVE=""
  if command -v jq &> /dev/null; then
    IS_ACTIVE=$(echo "$ULTRAWORK_STATE" | jq -r '.active // false' 2>/dev/null)
  else
    # Fallback: grep for "active": true
    if echo "$ULTRAWORK_STATE" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then
      IS_ACTIVE="true"
    fi
  fi

  if [ "$IS_ACTIVE" = "true" ]; then
    # Get reinforcement count (with fallback)
    REINFORCE_COUNT=0
    if command -v jq &> /dev/null; then
      REINFORCE_COUNT=$(echo "$ULTRAWORK_STATE" | jq -r '.reinforcement_count // 0' 2>/dev/null)
    else
      REINFORCE_COUNT=$(echo "$ULTRAWORK_STATE" | grep -oP '"reinforcement_count"[[:space:]]*:[[:space:]]*\K[0-9]+' 2>/dev/null) || REINFORCE_COUNT=0
    fi
    NEW_COUNT=$((REINFORCE_COUNT + 1))

    # Get original prompt (with fallback)
    ORIGINAL_PROMPT=""
    if command -v jq &> /dev/null; then
      ORIGINAL_PROMPT=$(echo "$ULTRAWORK_STATE" | jq -r '.original_prompt // ""' 2>/dev/null)
    else
      ORIGINAL_PROMPT=$(echo "$ULTRAWORK_STATE" | grep -oP '"original_prompt"[[:space:]]*:[[:space:]]*"\K[^"]+' 2>/dev/null) || ORIGINAL_PROMPT=""
    fi

    # Update state file (best effort)
    if command -v jq &> /dev/null; then
      echo "$ULTRAWORK_STATE" | jq ".reinforcement_count = $NEW_COUNT | .last_checked_at = \"$(date -Iseconds)\"" > "$DIRECTORY/.sisyphus/ultrawork-state.json" 2>/dev/null
    fi

    cat << EOF
{"continue": false, "reason": "<ultrawork-persistence>\n\n[ULTRAWORK MODE STILL ACTIVE - Reinforcement #$NEW_COUNT]\n\nYour ultrawork session is NOT complete. $INCOMPLETE_COUNT incomplete todos remain.\n\nREMEMBER THE ULTRAWORK RULES:\n- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially\n- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent)\n- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each\n- **VERIFY**: Check ALL requirements met before done\n- **NO Premature Stopping**: ALL TODOs must be complete\n\nContinue working on the next pending task. DO NOT STOP until all tasks are marked complete.\n\nOriginal task: $ORIGINAL_PROMPT\n\n</ultrawork-persistence>\n\n---\n"}
EOF
    exit 0
  fi
fi

# Priority 3: Todo Continuation (baseline)
if [ "$INCOMPLETE_COUNT" -gt 0 ]; then
  cat << EOF
{"continue": false, "reason": "<todo-continuation>\n\n[SYSTEM REMINDER - TODO CONTINUATION]\n\nIncomplete tasks remain in your todo list ($INCOMPLETE_COUNT remaining). Continue working on the next pending task.\n\n- Proceed without asking for permission\n- Mark each task complete when finished\n- Do not stop until all tasks are done\n\n</todo-continuation>\n\n---\n"}
EOF
  exit 0
fi

# No blocking needed
echo '{"continue": true}'
exit 0
