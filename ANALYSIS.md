# Hephaestus vs Deep-Executor: Comprehensive Comparison

## Executive Summary

**Hephaestus** (oh-my-opencode) and **Deep-Executor** (oh-my-claudecode) are both autonomous deep worker agents designed for complex, goal-oriented software engineering tasks. Deep-Executor is explicitly ported from Hephaestus (PR #1287) but has been adapted to fit the oh-my-claudecode framework.

**Key Finding:** Deep-Executor successfully captures Hephaestus's core philosophy but differs significantly in delegation architecture, tool ecosystem, and verification protocols.

---

## 1. Core Identity & Philosophy

### Hephaestus (OMO)
- **Identity**: "Senior Staff Engineer" - divine craftsman (Greek mythology)
- **Philosophy**: "Surgical, minimal, exactly what's needed" - master blacksmith precision
- **Approach**: Goal-oriented autonomous execution inspired by AmpCode's deep mode
- **Tagline**: "The Legitimate Craftsman"

### Deep-Executor (OMC)
- **Identity**: "Self-contained deep worker" - the forge itself
- **Philosophy**: "Raw materials go in, finished work comes out"
- **Approach**: Explore-first behavior with 100% completion guarantee
- **Tagline**: "The Forge"

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Metaphor** | Craftsman/blacksmith | The forge (tool itself) |
| **Agency** | Senior engineer making decisions | Worker executing with tools |
| **Emphasis** | Precision and craftsmanship | Self-sufficiency and completion |

**Analysis:** Both share the same philosophical foundation but frame it differently. Hephaestus emphasizes **craftsman agency** while Deep-Executor emphasizes **tool autonomy**.

---

## 2. Delegation & Agent Orchestration

### Hephaestus (OMO)
- **CAN delegate** to specialized agents (explore, librarian)
- **Delegation template**: 6-section mandatory structure (TASK, EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, CONTEXT)
- **Parallel exploration**: Fires 2-5 background exploration agents before executing
- **Session continuity**: Reuses session IDs across multi-turn delegations
- **Tool restrictions**: Cannot use `task` or `delegate_task` tools
- **Permission**: Questions allowed; OMO agent calls denied

**Delegation Philosophy:**
```
"Vague prompts = rejected. Be exhaustive."
"Never block on exploration results - fire and continue"
"Verify delegated work independently - don't trust self-reports"
```

### Deep-Executor (OMC)
- **CANNOT delegate** - completely blocked from spawning agents
- **Self-execution only**: Uses own tools extensively
- **No background agents**: All exploration done synchronously with own tools
- **Blocked tools**: Task tool BLOCKED, agent spawning BLOCKED

**Execution Philosophy:**
```
"You work ALONE. You are the forge."
"Use YOUR OWN tools extensively."
```

### Comparison
| Capability | Hephaestus | Deep-Executor |
|------------|------------|---------------|
| **Delegation** | Yes (via 6-section template) | No (hard blocked) |
| **Parallel agents** | 2-5 background explore/librarian | None |
| **Session continuity** | Yes (session ID reuse) | N/A (no delegation) |
| **Tool ecosystem** | Can invoke specialized agents | Uses only own tools |

**Critical Difference:** This is the **BIGGEST** architectural divergence. Hephaestus orchestrates background exploration, while Deep-Executor is a self-contained worker.

**Why this matters:**
- Hephaestus can scale exploration across multiple cheaper models
- Deep-Executor has simpler mental model but higher token cost
- Hephaestus = "orchestrator-executor hybrid"
- Deep-Executor = "pure executor"

---

## 3. Intent Classification & Gating

### Hephaestus (OMO)
**5-Category Classification (Phase 0):**
1. **Trivial** - Quick, obvious, <10 lines
2. **Explicit** - Clear instructions, specific targets
3. **Exploratory** - "How does X work?", investigation
4. **Open-ended** - "Improve", "enhance", vague requirements
5. **Ambiguous** - Multiple interpretations

**Explore-First Protocol:**
- Ambiguity triggers investigation, NOT clarification questions
- Questions are "LAST RESORT" after exhausting all tools

### Deep-Executor (OMC)
**3-Category Classification (Intent Gate):**
1. **Trivial** - Single file, obvious fix → minimal exploration
2. **Scoped** - Clear boundaries, 2-5 files → targeted exploration
3. **Complex** - Multi-system, unclear scope → full cycle

**Exploration Depth:**
- Classification determines exploration depth
- Still explore-first for non-trivial tasks

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Categories** | 5 (more granular) | 3 (simplified) |
| **Gating enforcement** | Phase 0 mandatory classification | Intent Gate first step |
| **Question policy** | Last resort after all tools | Similar (implied) |

**Analysis:** Deep-Executor simplifies the classification scheme while preserving the core explore-first philosophy. The reduction from 5 to 3 categories makes decision-making faster but potentially less nuanced.

---

## 4. Execution Loop & Workflow

### Hephaestus (OMO)
**EXPLORE → PLAN → DECIDE → EXECUTE**

1. **EXPLORE**: Fire 2-5 parallel background agents (explore/librarian)
2. **PLAN**: Create explicit work plan identifying all files/dependencies
3. **DECIDE**: Determine direct execution vs delegation
4. **EXECUTE**: Implement or delegate with verification

**Characteristics:**
- Parallel exploration (non-blocking)
- Explicit planning phase
- Delegation decision point
- Independent verification of delegated work

### Deep-Executor (OMC)
**EXPLORE → PLAN → EXECUTE → VERIFY**

1. **EXPLORE**: Use own tools (Glob, Grep, Read, ast_grep_search)
2. **PLAN**: Create mental model + TodoWrite for multi-step
3. **EXECUTE**: Implement directly with Edit/Write/Bash
4. **VERIFY**: After EACH change (lsp_diagnostics, build, test)

**Characteristics:**
- Sequential tool usage (blocking)
- Mental model + todos
- Direct execution only
- Per-change verification loop

### Comparison
| Stage | Hephaestus | Deep-Executor |
|-------|------------|---------------|
| **Explore** | Parallel background agents | Sequential own tools |
| **Plan** | Explicit plan document | Mental model + todos |
| **Decide** | Execution strategy choice | N/A (always self-execute) |
| **Execute** | Direct or delegate | Direct only |
| **Verify** | Final + delegated work | Per-change + final |

**Key Insight:** Hephaestus has a **decision branch** (execute vs delegate), while Deep-Executor has a **linear pipeline**.

---

## 5. Exploration Tools & Strategy

### Hephaestus (OMO)
**Exploration Agents:**
- **Explore agent** (gpt-5-nano): Fast grep for internal codebase
- **Librarian agent** (big-pickle): External docs, GitHub, OSS research
- **Execution**: Background parallel (2-5 agents)
- **Framing**: "Grep, not consultants"

**Tool Strategy:**
```
"Fire 2-5 parallel exploration tasks using faster, cheaper models"
"Never block on results - gather context while planning"
```

### Deep-Executor (OMC)
**Own Tools:**
- `Glob` - Find files by pattern
- `Grep` - Search content by regex
- `Read` - Read file contents
- `ast_grep_search` - Structural code search
- `lsp_diagnostics` - Check file health

**Exploration Questions (answer ALL):**
1. Where is this functionality implemented?
2. What patterns does this codebase use?
3. What tests exist for this area?
4. What are the dependencies?
5. What could break if we change this?

**Tool Strategy:**
```
1. Start with Glob to map file landscape
2. Use Grep to find patterns, imports, usages
3. Read the most relevant files thoroughly
4. Use ast_grep_search for structural patterns
5. Synthesize findings before proceeding
```

### Comparison
| Capability | Hephaestus | Deep-Executor |
|------------|------------|---------------|
| **Exploration method** | Delegate to specialized agents | Use own tools directly |
| **Parallelism** | 2-5 background agents | Sequential tool calls |
| **Model efficiency** | Cheaper models for exploration | Same expensive model |
| **External research** | Librarian for docs/OSS | No external research capability |
| **Tool framing** | "Grep not consultants" | Structured exploration questions |

**Cost Implications:**
- Hephaestus: Offloads exploration to cheaper models (gpt-5-nano, big-pickle)
- Deep-Executor: Uses expensive Opus model for all exploration
- **Verdict**: Hephaestus is more token-efficient for exploration-heavy tasks

---

## 6. MCP Tools & Language Server Integration

### Hephaestus (OMO)
**LSP Tools:**
- Available but less emphasized in the prompt
- Part of "crafted LSP/AST tools" in project description
- Integrated into verification workflow

**AST Tools:**
- `ast_grep` available for structural search/replace
- Emphasized for surgical refactoring

### Deep-Executor (OMC)
**LSP Tools (explicit strategy):**
- `lsp_diagnostics` - Single file errors/warnings
- `lsp_diagnostics_directory` - Project-wide type checking
- Emphasized in "MCP Tools Strategy" section
- Clear guidance on when to use each

**AST Tools (explicit workflow):**
- `ast_grep_search` - Find code by shape
- `ast_grep_replace` - Transform patterns
- **Mandatory workflow**: dryRun=true → review → dryRun=false → verify

### Comparison
| Tool | Hephaestus | Deep-Executor |
|------|------------|---------------|
| **LSP diagnostics** | Available | Explicit strategy + guidance |
| **LSP directory check** | Available | Mandatory for multi-file changes |
| **AST search** | Available | Integrated into exploration phase |
| **AST replace** | Available | Mandatory dryRun workflow |
| **Documentation** | Implied | Explicit tables + workflows |

**Analysis:** Deep-Executor provides **more explicit guidance** on MCP tool usage, making it easier for the model to apply them correctly. The mandatory dryRun workflow for `ast_grep_replace` is a valuable safety pattern not explicitly stated in Hephaestus.

---

## 7. Verification & Completion Protocols

### Hephaestus (OMO)
**Completion Criteria (ALL must be true):**
1. All requested functionality implemented exactly as specified
2. `lsp_diagnostics` returns zero errors on ALL modified files
3. Build command exits with code 0 (if applicable)
4. Tests pass (or pre-existing failures documented)
5. No temporary/debug code remains
6. Code matches existing codebase patterns (verified via exploration)
7. Evidence provided for each verification step

**Evidence Format:**
```
Evidence documented for each verification step
```

**Verification Philosophy:**
```
"NEVER trust 'I'm done'—verify outputs"
"Verify delegated work independently - don't trust self-reports"
```

### Deep-Executor (OMC)
**Verification Protocol:**

**After Every Change:**
1. `lsp_diagnostics` on modified files
2. Check for broken imports/references

**Before Claiming Completion:**
1. All TODOs complete (zero pending/in_progress)
2. Tests pass (fresh test output via Bash)
3. Build succeeds (fresh build output via Bash)
4. `lsp_diagnostics_directory` clean

**Evidence Format:**
```
VERIFICATION EVIDENCE:
- Build: [command] -> [pass/fail]
- Tests: [command] -> [X passed, Y failed]
- Diagnostics: [N errors, M warnings]
```

**Completion Summary Template:**
```markdown
## Completion Summary

### What Was Done
- [Concrete deliverable 1]
- [Concrete deliverable 2]

### Files Modified
- `/absolute/path/to/file1.ts` - [what changed]
- `/absolute/path/to/file2.ts` - [what changed]

### Verification Evidence
- Build: [command] -> SUCCESS
- Tests: [command] -> 42 passed, 0 failed
- Diagnostics: 0 errors, 0 warnings

### Definition of Done
[X] All requirements met
[X] Tests pass
[X] Build succeeds
[X] No regressions
```

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Completion criteria** | 7 criteria (comprehensive) | 4 criteria (focused) |
| **Evidence format** | Described but not templated | Explicit markdown template |
| **Per-change verification** | Not explicitly required | Required after EVERY change |
| **Todo integration** | Not mentioned | Explicit todo completion check |
| **Template structure** | No template provided | 4-section completion summary |

**Key Difference:** Deep-Executor has **more structured output expectations** with explicit markdown templates, while Hephaestus describes requirements more abstractly.

**Advantage Deep-Executor:** The explicit completion summary template makes it easier to verify the agent did comprehensive work.

**Advantage Hephaestus:** The 7-criteria checklist is more thorough (includes pattern matching verification and temporary code cleanup).

---

## 8. TODO Discipline & Task Management

### Hephaestus (OMO)
**Not explicitly mentioned in the prompt**

The focus is on verification and completion, but no specific guidance on TODO management or task breakdown.

### Deep-Executor (OMC)
**TODO Discipline (NON-NEGOTIABLE):**
- 2+ steps → TodoWrite FIRST with atomic breakdown
- Mark `in_progress` before starting (ONE at a time)
- Mark `completed` IMMEDIATELY after each step
- NEVER batch completions
- Re-verify todo list before concluding

**Integration with Verification:**
- "All TODOs complete (zero pending/in_progress)" is a required criterion before claiming completion

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **TODO usage** | Not mentioned | Mandatory for 2+ steps |
| **TODO discipline** | N/A | Explicit rules (one at a time, immediate completion) |
| **Verification integration** | N/A | Todo completion is verification criterion |

**Analysis:** This is a **significant addition** in Deep-Executor that provides better progress tracking and user visibility. Hephaestus relies on implicit task management, while Deep-Executor makes it explicit and enforced.

**Why this matters:** TODOs provide:
1. **User visibility** - Users can see progress in real-time
2. **Agent focus** - Forces atomic thinking
3. **Completion verification** - Clear checkpoint before declaring done

---

## 9. Failure Recovery & Error Handling

### Hephaestus (OMO)
**Failure Recovery Protocol:**
- Max 3 iterations before consulting Oracle
- After 3 consecutive failures:
  1. STOP all edits immediately
  2. REVERT to last known working state
  3. DOCUMENT attempts and failures
  4. CONSULT Oracle with full context
  5. Ask user before proceeding further

**Philosophy:**
```
"Never leave code broken; never shotgun debug"
```

### Deep-Executor (OMC)
**Failure Recovery:**
When blocked:
1. **Diagnose**: What specifically is blocking progress?
2. **Pivot**: Try alternative approach using your tools
3. **Report**: If truly stuck, explain what was tried and what failed

**Philosophy:**
```
"NEVER silently fail. NEVER claim completion when blocked."
```

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Max attempts** | 3 iterations before escalation | No explicit limit |
| **Escalation** | Consult Oracle (delegation) | Report to user |
| **Revert policy** | Explicit REVERT to last working state | Not mentioned |
| **Documentation** | DOCUMENT all attempts | Explain what was tried |

**Key Difference:** Hephaestus has a **structured escalation path** (Oracle consultation) while Deep-Executor can only report to the user.

**Advantage Hephaestus:**
- Automatic escalation prevents infinite loops
- Oracle consultation can unblock without user intervention
- Explicit revert policy prevents broken code states

**Advantage Deep-Executor:**
- Simpler mental model (no delegation complexity)
- User retains full control

---

## 10. Code Quality Standards & Patterns

### Hephaestus (OMO)
**Code Quality Mandates:**
- **Pattern search BEFORE writing**: Must search existing codebase for patterns
- **Minimal changes**: "Surgical, minimal, exactly what's needed"
- **Style matching**: Code must be indistinguishable from existing code
- **ASCII defaults**: Prefer simple solutions
- **Read-first**: Always read files before editing
- **Patch application**: Use sufficient context for unique matching

**Philosophy:**
```
"Your code should be indistinguishable from a senior engineer's"
"No AI slop"
"Match existing project aesthetics"
```

### Deep-Executor (OMC)
**Code Quality (in Anti-Patterns):**
- Don't skip exploration on non-trivial tasks
- Don't claim completion without verification evidence
- Don't reduce scope to "finish faster"
- Don't delete tests to make them pass
- Don't ignore errors or warnings
- Don't use "should", "probably", "seems to" without verifying

**Philosophy (implied):**
```
"Explore extensively before acting"
"100% completion guarantee"
```

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Pattern matching** | Explicit mandate to search | Implied in exploration |
| **Style guidance** | Detailed (ASCII, minimal, matching) | Not explicitly stated |
| **Quality framing** | Positive (what to do) | Negative (anti-patterns) |
| **Code aesthetics** | Emphasized | Not mentioned |

**Analysis:** Hephaestus provides **more explicit code quality guidance**, particularly around style matching and minimal changes. Deep-Executor focuses more on **process quality** (verification, completion) than **code aesthetics**.

**Gap in Deep-Executor:** Missing explicit guidance on:
- How to match existing code style
- Preference for minimal changes
- ASCII defaults
- Pattern search before implementation

---

## 11. Communication Style & User Interaction

### Hephaestus (OMO)
**Communication Style (Hard Rules):**
- **No status updates**: Start work immediately without "I'll work on..."
- **No flattery**: Skip praise of user's input
- **Be concise**: Answer directly, no preamble
- **Challenge respectfully**: State concerns + alternative, ask if they want to proceed

**Agency:**
```
"Judicious Initiative: Makes implementation decisions independently"
"May only ask questions after exhausting: direct tools, exploration agents,
librarian agents, context inference, technical problem-solving"
```

**Role:**
```
"Keep going until the query is completely resolved"
"Prohibited: intermediate checkpoints, asking permission to proceed,
stopping after partial implementation"
```

### Deep-Executor (OMC)
**Communication Style:**
- Not explicitly defined in the prompt
- Implied from philosophy: direct execution, minimal talk

**Completion Output:**
- Explicit markdown template for completion summary
- Structured evidence presentation

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Style rules** | Explicit (4 hard rules) | Not defined |
| **Status updates** | Forbidden | Not mentioned |
| **Questioning policy** | Last resort (5 alternatives first) | Implied explore-first |
| **Completion format** | Not templated | Explicit markdown template |

**Analysis:** Hephaestus has **more opinionated communication style** to optimize for efficiency and reduce token waste. Deep-Executor focuses on **structured output** rather than conversational style.

**Gap in Deep-Executor:** No guidance on:
- When to ask questions vs act
- Communication efficiency
- Status update policy

---

## 12. Model Configuration & Performance

### Hephaestus (OMO)
**Model:** GPT 5.2 Codex Medium
**Reasoning Effort:** Medium (escalates to high for complex multi-file refactoring)
**Max Tokens:** 32,000
**Temperature:** 0.1
**Fallback Chain:** None (requires specified model)

**Color:** #FF4500 (magma orange)
**Mode:** Primary

### Deep-Executor (OMC)
**Model:** Opus (Claude Opus 4.6)
**Default Model:** Opus
**Tools:** 11 tools (Read, Write, Edit, Glob, Grep, Bash, TodoWrite, lsp_diagnostics, lsp_diagnostics_directory, ast_grep_search, ast_grep_replace)
**Cost Category:** EXPENSIVE

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Model** | GPT 5.2 Codex Medium | Claude Opus 4.6 |
| **Fallback** | None | Default to Opus |
| **Reasoning** | Medium → High adaptive | Not configurable |
| **Token limit** | 32k | (Model default) |
| **Temperature** | 0.1 (deterministic) | (Model default) |

**Analysis:** Different model ecosystems (OpenAI vs Anthropic). Hephaestus has **adaptive reasoning** effort, while Deep-Executor uses a fixed high-capability model.

---

## 13. Session Continuity & Memory

### Hephaestus (OMO)
**Session Continuity:**
- Stores session IDs for agent delegation
- Reuses session IDs across multi-turn delegations
- Maintains context across delegated work

**Memory:** Not explicitly mentioned in prompt

### Deep-Executor (OMC)
**Session Continuity:**
```markdown
<remember>
- Architecture decision: [X]
- Pattern discovered: [Y]
- Gotcha encountered: [Z]
</remember>
```

**Memory Strategy:**
- Use `<remember>` tags for critical context
- Survives conversation compaction (per CLAUDE.md)
- Focus on decisions, patterns, gotchas

### Comparison
| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Session management** | Delegation session IDs | N/A (no delegation) |
| **Memory mechanism** | Not defined | `<remember>` tags |
| **Context preservation** | Across delegated agents | Across conversation turns |

**Analysis:** Different memory needs due to different architectures. Hephaestus needs session continuity for **delegation**, while Deep-Executor needs memory for **long-running solo work**.

---

## 14. Framework Integration

### Hephaestus (OMO - oh-my-opencode)
**Framework:** OpenCode plugin
**Ecosystem:**
- Part of multi-agent orchestration system
- Sisyphus/Atlas as primary orchestrators
- Specialized agents: Oracle, Librarian, Explore, Prometheus, Metis, Momus
- Can be invoked by orchestrators for deep work

**Integration:**
- Receives delegated tasks from Sisyphus/Atlas
- Works alongside other specialized agents
- Part of larger workflow orchestration

### Deep-Executor (OMC - oh-my-claudecode)
**Framework:** Claude Code plugin
**Ecosystem:**
- Part of 32-agent tier system (low/medium/high variants)
- Standalone agent OR invoked by orchestration modes
- Can be used in: autopilot, ralph, ultrawork, ultrapilot modes

**Integration:**
- Can be invoked directly OR by orchestrator
- Works in isolation (no delegation to other agents)
- Part of tiered agent selection strategy

### Comparison
| Aspect | Hephaestus (OMO) | Deep-Executor (OMC) |
|--------|------------------|---------------------|
| **Primary usage** | Delegated deep work | Direct OR delegated |
| **Orchestration** | Sisyphus/Atlas invoke | Multiple modes can invoke |
| **Agent collaboration** | Can delegate to explore/librarian | Fully isolated |
| **Framework scope** | Part of OpenCode ecosystem | Part of Claude Code ecosystem |

**Key Insight:** Hephaestus is designed as a **delegated specialist** in a multi-agent system, while Deep-Executor can function as both a **standalone agent** and a **delegated specialist**.

---

## 15. Feature Gap Analysis

### Features in Hephaestus MISSING from Deep-Executor

1. **Parallel Background Exploration**
   - **Impact:** High token cost, slower exploration
   - **Recommendation:** Add explore/researcher delegation capability

2. **External Research (Librarian)**
   - **Impact:** Cannot fetch official docs, GitHub examples, Stack Overflow
   - **Recommendation:** Add researcher agent delegation for external context

3. **Structured Escalation (Oracle Consultation)**
   - **Impact:** Can get stuck with no automatic unblocking
   - **Recommendation:** Add architect consultation after 3 failures

4. **Adaptive Reasoning Effort**
   - **Impact:** Always uses expensive high reasoning
   - **Recommendation:** Add complexity detection → adjust reasoning budget

5. **Explicit Code Style Guidance**
   - **Impact:** May produce inconsistent code style
   - **Recommendation:** Add pattern matching mandate before writing

6. **Communication Style Rules**
   - **Impact:** May be verbose or waste tokens
   - **Recommendation:** Add concise communication rules

7. **Session Management for Delegation**
   - **Impact:** N/A (no delegation)
   - **Recommendation:** Not needed unless delegation added

### Features in Deep-Executor MISSING from Hephaestus

1. **Explicit TODO Discipline**
   - **Impact:** Better progress visibility and tracking
   - **Recommendation:** Add to Hephaestus for user transparency

2. **Structured Completion Summary Template**
   - **Impact:** Easier verification of comprehensive work
   - **Recommendation:** Add to Hephaestus for consistency

3. **Per-Change Verification Protocol**
   - **Impact:** Catches errors earlier in the process
   - **Recommendation:** Add to Hephaestus for faster error detection

4. **Explicit MCP Tool Usage Guidance**
   - **Impact:** More consistent and correct tool usage
   - **Recommendation:** Add LSP/AST tool strategy section

5. **Mandatory dryRun Workflow for AST Transforms**
   - **Impact:** Safer structural refactoring
   - **Recommendation:** Add to Hephaestus as safety pattern

6. **Session Memory via `<remember>` Tags**
   - **Impact:** Better context retention across turns
   - **Recommendation:** Add to Hephaestus for long sessions

---

## 16. Recommended Improvements

### For Deep-Executor (OMC)

#### Priority 1: Critical Gaps

1. **Add Parallel Exploration Capability**
   ```
   BEFORE executing complex tasks:
   - Delegate to explore for internal codebase search
   - Delegate to researcher for external documentation
   - Use run_in_background=true for parallelism
   - Synthesize results before planning
   ```

   **Why:** Reduces token cost and speeds up exploration phase

2. **Add Structured Escalation Path**
   ```
   FAILURE RECOVERY (after 3 failed attempts):
   1. STOP all edits immediately
   2. REVERT to last known working state
   3. DELEGATE to architect-medium with full context
   4. WAIT for guidance before proceeding
   5. If still blocked, report to user
   ```

   **Why:** Prevents infinite loops and provides automatic unblocking

3. **Add Explicit Code Style Guidance**
   ```
   BEFORE writing ANY code:
   1. Search for similar patterns in codebase (Grep/ast_grep_search)
   2. Read 2-3 examples of existing code
   3. Match style: indentation, naming, structure
   4. Prefer minimal changes (surgical edits)
   5. Use ASCII defaults unless codebase uses otherwise
   ```

   **Why:** Ensures code quality and codebase consistency

#### Priority 2: Quality of Life

4. **Add Communication Efficiency Rules**
   ```
   COMMUNICATION STYLE:
   - No status updates ("I'll work on...")
   - No flattery or preamble
   - Be concise and direct
   - Challenge respectfully when needed
   - Only ask questions after exhausting all tools
   ```

   **Why:** Reduces token waste and improves efficiency

5. **Add Adaptive Reasoning Guidance**
   ```
   TASK COMPLEXITY DETECTION:
   - Trivial (1-2 files, clear fix) → Use executor-low (haiku)
   - Scoped (3-5 files, clear plan) → Use executor (sonnet)
   - Complex (multi-system, unclear) → Use deep-executor (opus)

   BEFORE invoking deep-executor, verify it's truly needed.
   ```

   **Why:** Optimizes cost by routing simpler work to cheaper agents

6. **Expand Verification Checklist**
   ```
   Add to completion criteria:
   5. No temporary/debug code remains (console.log, commented blocks)
   6. Code matches existing codebase patterns (verified via exploration)
   7. All imports are used and necessary
   ```

   **Why:** More comprehensive quality assurance

### For Hephaestus (OMO)

#### Priority 1: User Experience

1. **Add Explicit TODO Discipline**
   ```
   TODO MANAGEMENT:
   - Create TodoWrite for tasks with 2+ steps
   - Mark ONE task in_progress before starting
   - Mark completed IMMEDIATELY after each step
   - Re-verify zero pending/in_progress before completion
   ```

   **Why:** Improves user visibility and progress tracking

2. **Add Structured Completion Template**
   ```markdown
   ## Completion Summary

   ### What Was Done
   - [Concrete deliverable 1]

   ### Files Modified
   - `/path/file.ts` - [changes]

   ### Verification Evidence
   - Build: [command] -> SUCCESS
   - Tests: [command] -> X passed
   - Diagnostics: 0 errors

   ### Definition of Done
   [X] All requirements met
   [X] Tests pass
   [X] Build succeeds
   ```

   **Why:** Standardizes output and makes verification easier

3. **Add Per-Change Verification**
   ```
   AFTER EVERY EDIT:
   1. Run lsp_diagnostics on modified file
   2. Check for broken imports/references
   3. Fix immediately if issues found
   4. Only proceed when clean
   ```

   **Why:** Catches errors earlier, reducing debugging time

#### Priority 2: Safety & Quality

4. **Add Mandatory dryRun for AST Transforms**
   ```
   ast_grep_replace WORKFLOW:
   1. ALWAYS use dryRun=true first
   2. Review proposed changes
   3. If approved, apply with dryRun=false
   4. Run lsp_diagnostics_directory to verify
   ```

   **Why:** Prevents destructive transformations

5. **Add Explicit MCP Tool Strategy**
   ```
   MCP TOOL USAGE:
   | Tool | When to Use |
   |------|-------------|
   | lsp_diagnostics | After editing single file |
   | lsp_diagnostics_directory | After multi-file changes |
   | ast_grep_search | Finding code patterns by structure |
   | ast_grep_replace | Refactoring patterns (dryRun first!) |
   ```

   **Why:** More consistent and correct tool application

6. **Add Session Memory Mechanism**
   ```
   <remember priority>
   - Architecture decision: [X]
   - Pattern discovered: [Y]
   - Gotcha encountered: [Z]
   </remember>
   ```

   **Why:** Better context retention across long sessions

---

## 17. Architectural Recommendations

### For Oh-My-Claudecode (OMC) Team

**Option A: Hybrid Deep-Executor (Recommended)**

Create a **delegation-enabled variant** of deep-executor:

```typescript
export const deepExecutorHybridAgent: AgentConfig = {
  name: 'deep-executor-hybrid',
  description: 'Deep executor with parallel exploration capability',
  prompt: loadAgentPrompt('deep-executor-hybrid'),
  tools: [
    ...deepExecutorAgent.tools,
    'Task' // Enable delegation to explore/researcher only
  ],
  model: 'opus',
  metadata: {
    ...DEEP_EXECUTOR_PROMPT_METADATA,
    promptDescription: 'Deep executor that can delegate exploration to cheaper agents for token efficiency'
  }
};
```

**Benefits:**
- Token-efficient parallel exploration (like Hephaestus)
- Maintains self-execution philosophy for implementation
- Best of both worlds

**Option B: Keep Pure Deep-Executor + Add Orchestration Mode**

Keep deep-executor as-is (pure self-execution) but create a new **orchestration mode** that:
1. Delegates exploration to explore/researcher in parallel
2. Synthesizes results
3. Delegates implementation to deep-executor
4. Verifies results

**Benefits:**
- Preserves pure deep-executor for direct usage
- Provides efficient orchestration path
- Follows existing OMC patterns (ultrawork, pipeline)

### For Oh-My-Opencode (OMO) Team

**Recommendation: Add TODO Discipline Layer**

Enhance Hephaestus with explicit task breakdown and progress tracking:

```typescript
// Add TodoWrite tool to Hephaestus
// Update prompt with TODO discipline section
```

**Benefits:**
- Better user visibility
- Clearer progress tracking
- Easier verification of completion

**Recommendation: Add Structured Output Templates**

Standardize Hephaestus completion output with markdown templates:

```markdown
## Completion Summary
[Template from Deep-Executor]
```

**Benefits:**
- Consistent output format
- Easier verification
- Better user experience

---

## 18. Token Cost Analysis

### Hephaestus (OMO)
**Exploration Phase:**
- Fires 2-5 parallel agents (gpt-5-nano for explore, big-pickle for librarian)
- Main agent (GPT 5.2 Codex Medium) waits or continues planning
- **Cost**: Low (cheap models for exploration)

**Execution Phase:**
- GPT 5.2 Codex Medium with medium reasoning
- Escalates to high reasoning for complex refactoring
- **Cost**: Medium-High (adaptive)

**Total Typical Cost:** Medium (optimized exploration, adaptive reasoning)

### Deep-Executor (OMC)
**Exploration Phase:**
- Uses own tools (Glob, Grep, Read, ast_grep_search)
- All exploration done by Claude Opus 4.6
- **Cost**: High (expensive model for all exploration)

**Execution Phase:**
- Claude Opus 4.6 for all implementation
- **Cost**: High (always expensive model)

**Total Typical Cost:** High (no model routing optimization)

### Cost Comparison for Typical Task

**Scenario:** "Add error handling to authentication flow"

| Phase | Hephaestus | Deep-Executor |
|-------|------------|---------------|
| **Explore files** | 2 explore agents (nano) | Opus Glob + Grep + Read |
| **Research patterns** | 1 librarian (big-pickle) | N/A (no external research) |
| **Plan** | Codex Medium | Opus |
| **Implement** | Codex Medium | Opus |
| **Verify** | Codex Medium | Opus |

**Estimated Token Ratio:** Hephaestus 60% of Deep-Executor cost

**When Deep-Executor is Cheaper:**
- Trivial tasks with minimal exploration
- Tasks where external research not needed
- Single-file focused work

**When Hephaestus is Cheaper:**
- Complex tasks requiring extensive exploration
- Tasks needing external documentation research
- Multi-file refactoring with pattern search

---

## 19. Use Case Recommendations

### When to Use Hephaestus (OMO)

**Ideal Scenarios:**
1. **Complex multi-file refactoring** - Benefits from parallel exploration
2. **Unfamiliar codebase** - Librarian can fetch external context
3. **Architecture-heavy tasks** - Oracle consultation available for unblocking
4. **Token budget constrained** - Efficient model routing
5. **Tasks requiring external research** - Librarian agent capability

**Example Tasks:**
- "Implement OAuth2 authentication following best practices"
- "Refactor error handling across the entire API layer"
- "Migrate from REST to GraphQL"
- "Add comprehensive logging system"

### When to Use Deep-Executor (OMC)

**Ideal Scenarios:**
1. **Well-scoped implementation tasks** - Benefits from focused self-execution
2. **Tasks with clear requirements** - Less exploration needed
3. **Cost is not primary concern** - Accept Opus cost for simplicity
4. **Want progress visibility** - TODO discipline provides tracking
5. **Prefer simpler mental model** - No delegation complexity

**Example Tasks:**
- "Fix bug in payment processing logic"
- "Add validation to user registration form"
- "Implement feature flag for new UI component"
- "Write comprehensive tests for auth module"

### When to Use Both (Sequential Delegation)

**Scenario:** Large complex project

1. **Phase 1**: Hephaestus for exploration and architecture
   - Map codebase
   - Research external patterns
   - Create detailed plan

2. **Phase 2**: Deep-Executor for focused implementation
   - Execute plan with TODO tracking
   - Per-change verification
   - Structured completion summary

---

## 20. Summary & Verdict

### What Deep-Executor Got Right (vs Hephaestus)

1. ✅ **Explicit TODO discipline** - Better progress tracking
2. ✅ **Structured completion templates** - Easier verification
3. ✅ **Per-change verification** - Faster error detection
4. ✅ **MCP tool usage guidance** - More consistent application
5. ✅ **Mandatory dryRun for AST** - Safer transformations
6. ✅ **Session memory mechanism** - Better context retention
7. ✅ **Simpler mental model** - Easier to understand (no delegation complexity)

### What Hephaestus Does Better (vs Deep-Executor)

1. ✅ **Parallel exploration** - Token-efficient, faster
2. ✅ **External research** - Librarian for docs/examples
3. ✅ **Structured escalation** - Oracle consultation for unblocking
4. ✅ **Adaptive reasoning** - Cost optimization
5. ✅ **Explicit code style guidance** - Better quality
6. ✅ **Communication efficiency rules** - Less token waste
7. ✅ **Delegation architecture** - Scalable for complex workflows

### The Core Trade-off

| Aspect | Hephaestus | Deep-Executor |
|--------|------------|---------------|
| **Architecture** | Orchestrator-executor hybrid | Pure executor |
| **Complexity** | Higher (delegation logic) | Lower (self-contained) |
| **Token Efficiency** | Better (model routing) | Worse (always Opus) |
| **Parallelism** | Yes (2-5 background agents) | No (sequential tools) |
| **User Visibility** | Lower (no TODOs) | Higher (TODO tracking) |
| **Scalability** | Better (delegation) | Limited (solo work) |
| **Simplicity** | Lower | Higher |

### Verdict

**For OMC Team:**
- **Keep** deep-executor as pure self-execution variant
- **Add** deep-executor-hybrid with explore/researcher delegation
- **Implement** Priority 1 improvements (parallel exploration, escalation, style guidance)

**For OMO Team:**
- **Enhance** Hephaestus with TODO discipline and structured outputs
- **Keep** delegation architecture (it's a competitive advantage)
- **Implement** Priority 1 UX improvements from Deep-Executor

### The Ideal Agent (Synthesis)

```
BEST OF BOTH WORLDS:

1. Parallel exploration (Hephaestus) + TODO tracking (Deep-Executor)
2. External research (Hephaestus) + Structured templates (Deep-Executor)
3. Escalation (Hephaestus) + Per-change verification (Deep-Executor)
4. Model routing (Hephaestus) + MCP tool guidance (Deep-Executor)
5. Communication rules (Hephaestus) + Memory tags (Deep-Executor)
```

---

## Appendix A: Implementation Checklist for OMC

### Phase 1: Critical Fixes (Week 1)

- [ ] Add parallel exploration delegation (explore, researcher)
- [ ] Add structured escalation after 3 failures (architect consultation)
- [ ] Add explicit code style guidance section
- [ ] Add communication efficiency rules

### Phase 2: Quality Improvements (Week 2)

- [ ] Expand verification checklist (temp code, pattern matching)
- [ ] Add adaptive reasoning guidance (task complexity detection)
- [ ] Document when to use deep-executor vs executor tiers

### Phase 3: Hybrid Variant (Week 3)

- [ ] Create deep-executor-hybrid agent definition
- [ ] Add delegation capability for exploration only
- [ ] Test parallel exploration performance
- [ ] Document cost savings

### Phase 4: Documentation (Week 4)

- [ ] Update AGENTS.md with usage guidance
- [ ] Add examples of ideal use cases
- [ ] Document cost comparison with other agents
- [ ] Create migration guide for Hephaestus users

---

## Appendix B: Complete Prompt Comparison

### Key Sections Comparison

| Section | Hephaestus | Deep-Executor |
|---------|------------|---------------|
| **Identity** | Senior Staff Engineer, craftsman | Self-contained deep worker, the forge |
| **Constraints** | No task/delegate_task tools | Task/agent spawning BLOCKED |
| **Intent Gate** | 5 categories (Phase 0) | 3 categories (Intent Gate) |
| **Exploration** | 2-5 parallel background agents | Sequential own tools |
| **Planning** | Explicit work plan document | Mental model + TodoWrite |
| **Execution** | Direct or delegate decision | Direct only |
| **Verification** | 7-criteria checklist | 4-criteria + per-change |
| **Completion** | Evidence described | Markdown template |
| **TODO** | Not mentioned | NON-NEGOTIABLE discipline |
| **Failure** | 3 max → Oracle | Diagnose → Pivot → Report |
| **Code Quality** | Pattern search, minimal, style matching | Anti-patterns list |
| **Communication** | 4 hard rules (concise, no flattery) | Not defined |
| **Memory** | Session IDs for delegation | `<remember>` tags |
| **MCP Tools** | Available, less documented | Explicit strategy tables |

### Prompt Length Comparison

| Agent | Approximate Lines | Sections | Detail Level |
|-------|-------------------|----------|--------------|
| **Hephaestus** | ~450 lines | 12 major sections | Very detailed |
| **Deep-Executor** | ~194 lines | 11 major sections | Detailed |

**Analysis:** Hephaestus is more comprehensive (2.3x longer), with more explicit guidance on delegation, communication, and code quality. Deep-Executor is more focused and concise, with better structure for verification and TODO management.

---

## Appendix C: Tool Permission Matrix

### Hephaestus (OMO)

| Tool Category | Allowed | Blocked |
|---------------|---------|---------|
| **Read/Write** | Read, Write, Edit, Glob, Grep | - |
| **Execution** | Bash | - |
| **LSP** | lsp_diagnostics, lsp_diagnostics_directory | - |
| **AST** | ast_grep_search, ast_grep_replace | - |
| **Delegation** | (Can delegate to explore/librarian) | task, delegate_task |
| **TODO** | - | TodoWrite (not mentioned) |
| **Questions** | Allowed (last resort) | - |

### Deep-Executor (OMC)

| Tool Category | Allowed | Blocked |
|---------------|---------|---------|
| **Read/Write** | Read, Write, Edit, Glob, Grep | - |
| **Execution** | Bash | - |
| **LSP** | lsp_diagnostics, lsp_diagnostics_directory | - |
| **AST** | ast_grep_search, ast_grep_replace | - |
| **Delegation** | - | Task (BLOCKED), agent spawning (BLOCKED) |
| **TODO** | TodoWrite | - |
| **Questions** | Allowed (implied explore-first) | - |

### Key Differences

1. **Delegation**: Hephaestus CAN (via specialized syntax), Deep-Executor CANNOT (hard blocked)
2. **TODO**: Deep-Executor has TodoWrite, Hephaestus doesn't mention it
3. **Exploration**: Hephaestus delegates, Deep-Executor uses own tools

---

## Appendix D: Research Sources

### Hephaestus Research Sources

1. **Primary Source**: oh-my-opencode GitHub repository (dev branch)
   - URL: https://github.com/code-yeongyu/oh-my-opencode/blob/dev/src/agents/hephaestus.ts
   - File: `src/agents/hephaestus.ts` (19,375 bytes)
   - Documentation: `src/agents/AGENTS.md`

2. **Supporting Documentation**:
   - README.md - Project overview and philosophy
   - Sisyphus prompt - Orchestrator patterns
   - AGENTS.md - Agent definitions and relationships

3. **Key Insights**:
   - Inspired by AmpCode's deep mode
   - Named after Greek god of craftsmanship
   - Designed as delegated specialist in multi-agent system
   - Uses GPT 5.2 Codex Medium with adaptive reasoning

### Deep-Executor Research Sources

1. **Primary Source**: oh-my-claudecode local codebase
   - File: `/home/bellman/Workspace/omc-omo-deepexec-comparsion/agents/deep-executor.md`
   - File: `/home/bellman/Workspace/omc-omo-deepexec-comparsion/src/agents/deep-executor.ts`

2. **Supporting Context**:
   - Agent utilities and types
   - Oh-my-claudecode framework documentation (CLAUDE.md)
   - Agent definitions and orchestration patterns

3. **Key Insights**:
   - Explicitly ported from Hephaestus (PR #1287)
   - Adapted for Claude Code ecosystem
   - Designed as standalone OR delegated agent
   - Uses Claude Opus 4.6 exclusively

---

**END OF ANALYSIS**
