# Demo 3: Pipeline - Sequential Agent Chaining

**Duration:** 3 minutes
**Objective:** Demonstrate sequential agent workflow with data passing between stages

## Pre-requisites

- Existing codebase to review (can use the TypeScript project from Demo 2, or any small codebase)
- OMC installed and configured
- Understanding that pipeline is for sequential workflows where output of one agent feeds the next

## Setup (1 minute before demo)

Option A: Use the fixed code from Demo 2
```bash
cd ~/demo-workspace/typescript-errors-demo
```

Option B: Create a small sample codebase with intentional code smell
```bash
cd ~/demo-workspace
mkdir -p code-review-demo
cd code-review-demo

cat > calculator.ts << 'EOF'
// TODO: This needs refactoring
export class Calculator {
  private history: any[] = [];  // Code smell: 'any' type

  calculate(a, b, op) {  // Code smell: implicit 'any' types
    var result;  // Code smell: use of 'var'
    switch(op) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b == 0) throw new Error("Division by zero");  // Code smell: '==' instead of '==='
        result = a / b;
        break;
    }
    this.history.push({a: a, b: b, op: op, result: result});
    return result;
  }

  getHistory() {
    return this.history;
  }

  clearHistory() {
    this.history = [];
  }
}
EOF

# Create tsconfig if needed
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true
  }
}
EOF
```

## The Command

```
/oh-my-claudecode:pipeline review
```

Or demonstrate custom pipeline:
```
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> critic:opus -> executor:sonnet
```

## Expected Flow (2-3 minutes)

### Stage 1: Explore (Haiku) - 0:00-0:30
**What happens:**
- Explorer agent scans codebase structure
- Identifies files, dependencies, patterns
- Outputs: File list, architectural overview, identified issues

**Presenter talking points:**
- "Pipeline activates with the 'review' preset"
- "Stage 1: Explorer using Haiku (fast, cheap) to scan the codebase"
- "It's building a map - what files exist, what do they do, what patterns are used"
- Point to output: "See the file structure and initial observations"

### Stage 2: Architect (Opus) - 0:30-1:30
**What happens:**
- Architect agent receives explorer's findings
- Performs deep analysis of architecture and code quality
- Identifies: Code smells, type issues, architectural concerns, missing patterns
- Outputs: Detailed analysis with prioritized issues

**Presenter talking points:**
- "Stage 2: Architect using Opus (powerful reasoning) receives the explorer's map"
- "Now doing deep analysis - not just 'what' but 'why' and 'how to improve'"
- Point to analysis: "Found several issues: 'any' types, 'var' usage, loose equality checks"
- "Notice the prioritization - security issues ranked higher than style issues"

### Stage 3: Critic (Opus) - 1:30-2:00
**What happens:**
- Critic agent receives architect's analysis
- Validates findings and adds context
- Identifies: False positives, severity adjustments, additional concerns
- Outputs: Refined issue list with recommendations

**Presenter talking points:**
- "Stage 3: Critic validates the architect's findings"
- "This is consensus-building - two Opus agents agreeing on what matters"
- "Critic might say 'this issue is actually critical' or 'this one is acceptable given context'"
- "Output: Prioritized, validated list of real issues to fix"

### Stage 4: Executor (Sonnet) - 2:00-2:45
**What happens:**
- Executor agent receives validated issue list
- Applies fixes systematically
- Updates code to address all identified issues
- Outputs: Fixed code with summary

**Presenter talking points:**
- "Stage 4: Executor using Sonnet (balanced) applies the fixes"
- "It's following the critic's recommendations exactly"
- "Watch: Each issue gets addressed - types added, 'var' → 'const', '==' → '==='"

### Stage 5: Completion - 2:45-3:00
**What happens:**
- Pipeline summary generated
- Shows data flow through each stage
- Final verification

**Presenter talking points:**
- "Pipeline complete - see the flow of information through four stages"
- "Each agent specialized: Explorer mapped, Architect analyzed, Critic validated, Executor fixed"
- "This is sequential coordination - each agent builds on previous work"

## Expected Output

### Terminal Output
```
$ /oh-my-claudecode:pipeline review

Activating pipeline with preset 'review':
  Stage 1: explore (haiku) →
  Stage 2: architect (opus) →
  Stage 3: critic (opus) →
  Stage 4: executor (sonnet)

[STAGE 1/4: explore (haiku)]
Scanning codebase...
✓ Completed (8s)

Output:
  - 1 file found: calculator.ts
  - 1 class: Calculator
  - 3 public methods: calculate, getHistory, clearHistory
  - Initial observations:
    • Uses 'any' type in history array
    • Missing type annotations on calculate parameters
    • Uses 'var' keyword (outdated)

[STAGE 2/4: architect (opus)]
Analyzing architecture and code quality...
✓ Completed (35s)

Output:
  Critical Issues:
    1. Implicit 'any' types on calculate parameters (a, b, op)
       - Impact: Type safety lost, runtime errors possible
       - Fix: Add explicit types (number, number, string)

  High Priority:
    2. History array uses 'any' type
       - Impact: No type checking on history entries
       - Fix: Define HistoryEntry interface

  Medium Priority:
    3. Use of 'var' keyword
       - Impact: Function-scoped instead of block-scoped
       - Fix: Replace with 'const' or 'let'

    4. Loose equality check (==)
       - Impact: Type coercion bugs
       - Fix: Use strict equality (===)

[STAGE 3/4: critic (opus)]
Validating analysis...
✓ Completed (18s)

Output:
  Validation Results:
    ✓ Issue #1: Confirmed critical - parameter types must be explicit in strict mode
    ✓ Issue #2: Confirmed high - interface needed for type safety
    ✓ Issue #3: Confirmed medium - modern best practice
    ✓ Issue #4: Confirmed medium - strict equality preferred

  Additional Recommendations:
    • Consider adding JSDoc comments for public API
    • Return type of calculate() should be explicit
    • Consider immutability for history (readonly array)

  Approved for execution: All issues validated

[STAGE 4/4: executor (sonnet)]
Applying fixes...
✓ Completed (22s)

Changes Applied:
  calculator.ts:
    ✓ Added HistoryEntry interface
    ✓ Added explicit types to calculate() parameters
    ✓ Replaced 'var' with 'const'
    ✓ Changed '==' to '==='
    ✓ Added return type annotation
    ✓ Added JSDoc comments

[PIPELINE COMPLETE]

Summary:
  Total stages: 4
  Total time: 1m 23s
  Data flow: explore → architect → critic → executor
  Issues found: 4 critical/high, 2 medium
  Issues fixed: 6
  Files modified: 1

Review complete! Code quality improved.
```

### Fixed Code Output

**calculator.ts** (after pipeline):
```typescript
interface HistoryEntry {
  a: number;
  b: number;
  op: string;
  result: number;
}

/**
 * Calculator with operation history tracking
 */
export class Calculator {
  private history: HistoryEntry[] = [];

  /**
   * Perform a calculation
   * @param a First operand
   * @param b Second operand
   * @param op Operation: '+', '-', '*', '/'
   * @returns Calculation result
   */
  calculate(a: number, b: number, op: string): number {
    const result: number;
    switch(op) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b === 0) throw new Error("Division by zero");
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
    this.history.push({a, b, op, result});
    return result;
  }

  /**
   * Get calculation history
   */
  getHistory(): readonly HistoryEntry[] {
    return this.history;
  }

  /**
   * Clear calculation history
   */
  clearHistory(): void {
    this.history = [];
  }
}
```

## Key Talking Points

### What makes pipeline special?
1. **Sequential coordination** - Each stage builds on previous work, not parallel chaos
2. **Data passing** - Output of Stage N becomes input of Stage N+1
3. **Specialized stages** - Right agent with right model for each phase
4. **Built-in presets** - Common workflows pre-configured (review, implement, debug, etc.)
5. **Custom pipelines** - Define your own stage sequence

### When to use pipeline vs ultrawork
| Use Pipeline When | Use Ultrawork When |
|-------------------|-------------------|
| Sequential dependencies | Independent tasks |
| Analysis → Decision → Action | Parallel fixes across files |
| Multi-stage workflows | Batch operations |
| Consensus needed | Speed is priority |
| Complex reasoning chain | Simple parallelizable work |

### Architecture highlight
- "Each stage runs to completion before next starts"
- "Model selection per stage - Haiku for scanning, Opus for reasoning, Sonnet for execution"
- "This is token-efficient: Don't use Opus for simple file listing"

### Available Presets
- `review` - explore → architect → critic → executor (code review workflow)
- `implement` - planner → executor → tdd-guide (TDD workflow)
- `debug` - explore → architect → build-fixer (debugging workflow)
- `research` - parallel(researcher, explore) → architect → writer (documentation workflow)
- `refactor` - explore → architect → executor-high → qa-tester (refactoring workflow)
- `security` - explore → security-reviewer → executor → security-reviewer-low (security audit)

## Fallback: Pre-recorded Output

Show the complete terminal output from "Expected Output" section above.

Additionally, show a visual diagram:

```
PIPELINE: review

┌─────────────────────────────────────────────────────────────┐
│ Stage 1: explore (haiku, 8s)                                │
│ Output: File map, initial observations                      │
└────────────────────┬────────────────────────────────────────┘
                     │ Data passed to Stage 2
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 2: architect (opus, 35s)                              │
│ Input: File map from Stage 1                                │
│ Output: Detailed analysis, prioritized issues               │
└────────────────────┬────────────────────────────────────────┘
                     │ Data passed to Stage 3
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 3: critic (opus, 18s)                                 │
│ Input: Analysis from Stage 2                                │
│ Output: Validated issues, recommendations                   │
└────────────────────┬────────────────────────────────────────┘
                     │ Data passed to Stage 4
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 4: executor (sonnet, 22s)                             │
│ Input: Validated issues from Stage 3                        │
│ Output: Fixed code                                          │
└─────────────────────────────────────────────────────────────┘

Total: 1m 23s, 4 stages, 6 issues fixed
```

## Common Issues & Troubleshooting

### Issue: Stage takes longer than expected
**Solution:**
- Point out: "Opus is doing deep reasoning - this is where the analysis happens"
- Explain: "We're using the most powerful model here for quality"
- Acceptable: Opus stages can take 30-60s for complex analysis

### Issue: Critic rejects architect's findings
**Solution:**
- Great teaching moment! Point out: "This is consensus-building in action"
- Explain: "Critic found a false positive - protecting us from unnecessary changes"
- Emphasize: "Two heads are better than one, even with AI"

### Issue: Executor doesn't fix all issues
**Solution:**
- Check if critic downgraded severity: "Critic may have said 'this is acceptable'"
- Or point out: "Executor fixed the validated issues - others were deemed non-blocking"

## Demo Variations

### Variation 1: Custom Pipeline
Show custom pipeline syntax:
```
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> executor-high:opus -> qa-tester:sonnet
```

"You can define your own stage sequence - any agent, any model, any order"

### Variation 2: Research Pipeline
```
/oh-my-claudecode:pipeline research
```

"The 'research' preset: Parallel researchers gather data, architect synthesizes, writer documents"

### Variation 3: Show Pipeline State
```bash
cat .omc/state/pipeline-state.json
```

"Pipeline state is persisted - you can resume if interrupted"

## Transition to Next Demo

"That's pipeline - sequential coordination where each agent builds on previous work. But sometimes you don't have clear requirements. You just know you want 'something' but you're not sure exactly what. That's where planning comes in - our next demo."

**Transition action:** Clear terminal, prepare for planning demo with a broad request

## Q&A Preparation

**Q: Can I add my own stages to presets?**
A: Not yet, but you can define fully custom pipelines with `explore:haiku -> architect:opus -> your-custom-agent:sonnet`

**Q: What if a stage fails?**
A: Pipeline stops at failed stage. You can inspect the error, fix it, and resume from that stage using the state file.

**Q: How does data pass between stages?**
A: Each stage's output is added to the next stage's context. Think of it like a relay race - baton passing.

**Q: Can stages run in parallel?**
A: Yes! Use `parallel(agent1, agent2) ->` syntax. The `research` preset does this: multiple researchers work in parallel, then results merge.

**Q: Why not just use autopilot for everything?**
A: Autopilot is great for "build X", but pipeline gives you fine-grained control over the workflow. Use pipeline when you need specific reasoning at specific stages.

**Q: How do I know which preset to use?**
A:
- `review` - Code quality improvements
- `implement` - Building new features with TDD
- `debug` - Tracking down bugs
- `research` - Documentation or investigation tasks
- `refactor` - Major code restructuring
- `security` - Security audits
