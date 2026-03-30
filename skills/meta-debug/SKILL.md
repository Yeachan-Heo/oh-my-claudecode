---
name: meta-debug
description: Debug the AI itself - detect hallucinations, break stuck loops, recover from context confusion, assess output quality, and emergency recovery procedures
level: 3
aliases: [meta, hallucination-check, loop-break, emergency]
argument-hint: [hallucination|loop|confusion|quality|emergency] - default is hallucination
---

# Meta-Debug Skill

Debug Claude Code itself when it produces hallucinations, gets stuck in loops, suffers context confusion, or produces low-quality output. Emergency procedures for serious errors.

## Usage

```
/oh-my-claudecode:meta-debug
/oh-my-claudecode:meta-debug hallucination
/oh-my-claudecode:meta-debug loop
/oh-my-claudecode:meta-debug confusion
/oh-my-claudecode:meta-debug quality
/oh-my-claudecode:meta-debug emergency
```

Or say: "Claude is hallucinating", "stuck in a loop", "context confused", "output quality is bad", "emergency recovery"

## Modes

| Mode | Detects | Recovery Action |
|------|---------|-----------------|
| `hallucination` | Fabricated APIs, non-existent files, wrong function signatures | Verify-then-correct cycle |
| `loop` | Infinite retries, circular reasoning, oscillating solutions | Intervention and redirection |
| `confusion` | Mixed-up files, stale references, wrong project context | Context reset and re-anchor |
| `quality` | Low quality output, missed requirements, sloppy code | Acceptance checklist enforcement |
| `emergency` | Session corruption, runaway operations, data loss risk | Immediate rollback procedures |

## Workflow

### Mode: Hallucination Detection

#### 1. Identify Hallucination Type

Common hallucination patterns in Claude Code:

| Type | Example | Detection |
|------|---------|-----------|
| **Phantom API** | References `fs.readFileAsync()` (doesn't exist) | Verify against actual module exports |
| **Wrong signature** | Calls function with incorrect parameter order | Check with `lsp_hover` or source code |
| **Non-existent file** | References `src/utils/helper.ts` that doesn't exist | Verify with `Glob` |
| **Invented config** | Claims a config option exists that doesn't | Check official docs via Context7 |
| **Stale reference** | References code that was refactored/deleted | Check git history |
| **Confident wrong answer** | States something factually incorrect with confidence | Cross-reference with docs/source |

#### 2. Verification Protocol

For any suspected hallucination:

```
VERIFY CHECKLIST:
□ Does the file/function/API actually exist? (Glob, Grep, lsp_goto_definition)
□ Does the signature match? (lsp_hover on the symbol)
□ Is the behavior as described? (Read the actual source code)
□ Does the library version support this? (Check package.json + docs)
□ Has this code changed recently? (git log --oneline -5 <file>)
```

#### 3. Correction

When hallucination confirmed:
1. State what was hallucinated vs what's real
2. Find the correct API/file/signature
3. Redo the work using verified information
4. Add a note: `[CORRECTED: Previously referenced {wrong}, actual is {right}]`

### Mode: Loop Detection & Breaking

#### 1. Recognize Loop Patterns

| Pattern | Symptoms | Typical Cause |
|---------|----------|---------------|
| **Retry loop** | Same command fails 3+ times | Wrong approach, not a transient error |
| **Oscillating fix** | Fix A breaks B, fix B breaks A | Conflicting constraints not recognized |
| **Expanding scope** | Each attempt adds more changes | Lost sight of minimal fix |
| **Circular reasoning** | Returns to same conclusion repeatedly | Insufficient information to decide |
| **Tool spam** | Rapid repeated tool calls with same args | Misinterpreting tool output |

#### 2. Breaking Strategies

**For retry loops:**
```
STOP. The same approach has failed {n} times.
1. State what's being attempted
2. State why it keeps failing
3. List 3 alternative approaches
4. Pick the most different approach and try that
```

**For oscillating fixes:**
```
STOP. Changes are oscillating between two states.
1. Identify the two conflicting requirements
2. Determine which requirement has priority
3. Accept the tradeoff explicitly
4. Implement one direction only
```

**For expanding scope:**
```
STOP. The change set is growing beyond the original task.
1. State the original task (one sentence)
2. Revert to the last clean state
3. Make the smallest possible change that addresses only the original task
4. If more changes are truly needed, create separate tasks
```

**For any loop — nuclear option:**
```
/clear — reset conversation context entirely
Then re-state the task fresh with what you've learned
```

### Mode: Context Confusion Recovery

#### 1. Detect Confusion Symptoms

| Symptom | Cause | Fix |
|---------|-------|-----|
| References wrong file names | Context overflow, similar file names | Re-read target files explicitly |
| Applies changes to wrong file | Mixed context from multiple files | `/compact`, then re-focus on one file |
| Uses outdated code state | Stale context from earlier in session | Re-read the file to get current state |
| Mixes two project's patterns | Multiple project context bleeding | `/clear` and re-enter single project |
| Contradicts own earlier statements | Context compressed mid-session | Re-state key decisions explicitly |

#### 2. Recovery Protocol

```
CONTEXT RECOVERY:
1. ANCHOR: What project am I working on? What task?
2. VERIFY: Read the actual current state of key files
3. REFRESH: /compact to clear stale context if session is long
4. RE-STATE: Explicitly re-state the current task and constraints
5. PROCEED: Continue with fresh, verified context
```

### Mode: Quality Assessment

#### 1. Output Quality Checklist

Score each dimension 1-5:

```
[QUALITY ASSESSMENT]
═══════════════════════════════════════════

Task: {description}

Correctness:    [1-5] Does it work? Does it handle edge cases?
Completeness:   [1-5] Does it address all requirements?
Code Quality:   [1-5] Clean, readable, maintainable?
Test Coverage:  [1-5] Are changes tested? Do tests pass?
Security:       [1-5] Any vulnerabilities introduced?
Performance:    [1-5] Any regressions or anti-patterns?
Convention:     [1-5] Follows existing codebase patterns?

Overall Score: {sum}/35 ({percentage}%)

Verdict: {SHIP|REVISE|REDO}
  SHIP (>80%): Good to go
  REVISE (60-80%): Fix specific issues
  REDO (<60%): Approach is fundamentally wrong
```

#### 2. Improvement Loop

If REVISE: list specific issues and fix each one.
If REDO: explain why the approach is wrong and propose a new one.

### Mode: Emergency Procedures

#### 1. Quick Actions

| Emergency | Command | What It Does |
|-----------|---------|--------------|
| **Stop everything** | `/oh-my-claudecode:cancel` | Cancels all active OMC modes |
| **Reset context** | `/clear` | Wipes conversation history |
| **Undo file changes** | `git checkout -- <file>` | Restores file to last commit |
| **Undo all changes** | `git stash` | Stashes all uncommitted changes |
| **Kill background tasks** | Check with `ps aux \| grep claude` | Kill runaway processes |
| **Recover deleted file** | `git checkout HEAD -- <file>` | Restore from last commit |

#### 2. Disaster Recovery Playbook

**If Claude deleted important files:**
```bash
git stash                           # Save any remaining changes
git checkout HEAD -- .              # Restore all files from last commit
git stash pop                       # Re-apply saved changes selectively
```

**If Claude broke the build:**
```bash
git diff --stat                     # See what changed
git stash                           # Stash all changes
npm run build                       # Verify clean build
git stash pop                       # Re-apply changes one by one
```

**If Claude committed bad code:**
```bash
git log --oneline -5                # Find the bad commit
git revert <commit-hash>            # Create a revert commit (safe)
# DO NOT use git reset --hard unless you understand the consequences
```

**If Claude is in a runaway loop:**
```
1. Press Ctrl+C to interrupt
2. /oh-my-claudecode:cancel
3. /clear
4. Re-state your task fresh
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Hallucination identified and corrected** | Show what was wrong and the verified correction |
| **Loop broken** | Show the alternative approach being taken |
| **Context recovered** | Show re-anchored state and verified context |
| **Quality assessed** | Show score and verdict with next steps |
| **Emergency resolved** | Show recovery steps taken and current clean state |

## Notes

- **Prevention > Recovery**: Use `/compact` regularly, be specific in prompts, verify outputs
- **Three-strike rule**: If the same approach fails 3 times, STOP and change strategy
- **Fresh eyes**: Sometimes `/clear` + re-stating the problem is faster than debugging the AI
- **Complement to /trace**: Use `/trace` for code bugs. Use `/meta-debug` for AI behavior bugs.
- **Not destructive**: This skill guides recovery — it doesn't run destructive git commands without confirmation.

---

Begin meta-debugging now. Parse the mode and start diagnosis.
