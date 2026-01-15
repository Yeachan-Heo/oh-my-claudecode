#!/usr/bin/env node

/**
 * Sisyphus Persistent Mode Hook (Node.js)
 * Unified handler for ultrawork, ralph-loop, and todo continuation
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Read JSON file safely
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Write JSON file safely
function writeJsonFile(path, data) {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Count incomplete todos
function countIncompleteTodos(todosDir, projectDir) {
  let count = 0;

  // Check global todos
  if (existsSync(todosDir)) {
    try {
      const files = readdirSync(todosDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const todos = readJsonFile(join(todosDir, file));
        if (Array.isArray(todos)) {
          count += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        }
      }
    } catch {}
  }

  // Check project todos
  for (const path of [
    join(projectDir, '.sisyphus', 'todos.json'),
    join(projectDir, '.claude', 'todos.json')
  ]) {
    const data = readJsonFile(path);
    const todos = data?.todos || data;
    if (Array.isArray(todos)) {
      count += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
    }
  }

  return count;
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.directory || process.cwd();
    const todosDir = join(homedir(), '.claude', 'todos');

    // Check for ultrawork state
    let ultraworkState = readJsonFile(join(directory, '.sisyphus', 'ultrawork-state.json'))
      || readJsonFile(join(homedir(), '.claude', 'ultrawork-state.json'));

    // Check for ralph loop state
    const ralphState = readJsonFile(join(directory, '.sisyphus', 'ralph-state.json'));

    // Check for verification state
    const verificationState = readJsonFile(join(directory, '.sisyphus', 'ralph-verification.json'));

    // Count incomplete todos
    const incompleteCount = countIncompleteTodos(todosDir, directory);

    // Priority 1: Ralph Loop with Oracle Verification
    if (ralphState?.active) {
      const iteration = ralphState.iteration || 1;
      const maxIter = ralphState.max_iterations || 10;

      // Check if oracle verification is pending
      if (verificationState?.pending) {
        const attempt = (verificationState.verification_attempts || 0) + 1;
        const maxAttempts = verificationState.max_verification_attempts || 3;

        console.log(JSON.stringify({
          continue: false,
          reason: `<ralph-verification>

[ORACLE VERIFICATION REQUIRED - Attempt ${attempt}/${maxAttempts}]

The agent claims the task is complete. Before accepting, YOU MUST verify with Oracle.

**Original Task:**
${verificationState.original_task || ralphState.prompt || 'No task specified'}

**Completion Claim:**
${verificationState.completion_claim || 'Task marked complete'}

${verificationState.oracle_feedback ? `**Previous Oracle Feedback (rejected):**
${verificationState.oracle_feedback}
` : ''}

## MANDATORY VERIFICATION STEPS

1. **Spawn Oracle Agent** for verification
2. **Oracle must check:**
   - Are ALL requirements from the original task met?
   - Is the implementation complete, not partial?
   - Are there any obvious bugs or issues?
   - Does the code compile/run without errors?
   - Are tests passing (if applicable)?

3. **Based on Oracle's response:**
   - If APPROVED: Output \`<oracle-approved>VERIFIED_COMPLETE</oracle-approved>\`
   - If REJECTED: Continue working on the identified issues

</ralph-verification>

---
`
        }));
        return;
      }

      if (iteration < maxIter) {
        const newIter = iteration + 1;
        ralphState.iteration = newIter;
        writeJsonFile(join(directory, '.sisyphus', 'ralph-state.json'), ralphState);

        console.log(JSON.stringify({
          continue: false,
          reason: `<ralph-loop-continuation>

[RALPH LOOP - ITERATION ${newIter}/${maxIter}]

Your previous attempt did not output the completion promise. The work is NOT done yet.

CRITICAL INSTRUCTIONS:
1. Review your progress and the original task
2. Check your todo list - are ALL items marked complete?
3. Continue from where you left off
4. When FULLY complete, output: <promise>${ralphState.completion_promise || 'TASK_COMPLETE'}</promise>
5. Do NOT stop until the task is truly done

${ralphState.prompt ? `Original task: ${ralphState.prompt}` : ''}

</ralph-loop-continuation>

---
`
        }));
        return;
      }
    }

    // Priority 2: Ultrawork with incomplete todos
    if (ultraworkState?.active && incompleteCount > 0) {
      const newCount = (ultraworkState.reinforcement_count || 0) + 1;
      const maxReinforcements = ultraworkState.max_reinforcements || 10;

      // Escape mechanism: after max reinforcements, allow stopping
      if (newCount > maxReinforcements) {
        console.log(JSON.stringify({
          continue: true,
          reason: `[ULTRAWORK ESCAPE] Maximum reinforcements (${maxReinforcements}) reached. Allowing stop despite ${incompleteCount} incomplete todos. If tasks are genuinely stuck, consider cancelling them or asking the user for help.`
        }));
        return;
      }

      ultraworkState.reinforcement_count = newCount;
      ultraworkState.last_checked_at = new Date().toISOString();

      writeJsonFile(join(directory, '.sisyphus', 'ultrawork-state.json'), ultraworkState);

      console.log(JSON.stringify({
        continue: false,
        reason: `<ultrawork-persistence>

[ULTRAWORK MODE STILL ACTIVE - Reinforcement #${newCount}]

Your ultrawork session is NOT complete. ${incompleteCount} incomplete todos remain.

REMEMBER THE ULTRAWORK RULES:
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent)
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each
- **VERIFY**: Check ALL requirements met before done
- **NO Premature Stopping**: ALL TODOs must be complete

Continue working on the next pending task. DO NOT STOP until all tasks are marked complete.

${ultraworkState.original_prompt ? `Original task: ${ultraworkState.original_prompt}` : ''}

</ultrawork-persistence>

---
`
      }));
      return;
    }

    // Priority 3: Todo Continuation (with escape mechanism)
    if (incompleteCount > 0) {
      // Track continuation attempts in a lightweight way
      const contFile = join(directory, '.sisyphus', 'continuation-count.json');
      let contState = readJsonFile(contFile) || { count: 0 };
      contState.count = (contState.count || 0) + 1;
      contState.last_checked_at = new Date().toISOString();
      writeJsonFile(contFile, contState);

      const maxContinuations = 15;

      // Escape mechanism: after max continuations, allow stopping
      if (contState.count > maxContinuations) {
        console.log(JSON.stringify({
          continue: true,
          reason: `[TODO ESCAPE] Maximum continuation attempts (${maxContinuations}) reached. Allowing stop despite ${incompleteCount} incomplete todos. Tasks may be stuck - consider reviewing and clearing them.`
        }));
        return;
      }

      console.log(JSON.stringify({
        continue: false,
        reason: `<todo-continuation>

[SYSTEM REMINDER - TODO CONTINUATION ${contState.count}/${maxContinuations}]

Incomplete tasks remain in your todo list (${incompleteCount} remaining). Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done

</todo-continuation>

---
`
      }));
      return;
    }

    // No blocking needed
    console.log(JSON.stringify({ continue: true }));
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
