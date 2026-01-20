/**
 * Agent Definitions for Oh-My-Claude-Sisyphus
 *
 * This module provides:
 * 1. Re-exports of base agents from individual files
 * 2. Tiered agent variants with dynamically loaded prompts from /agents/*.md
 * 3. getAgentDefinitions() for agent registry
 * 4. omcSystemPrompt for the main orchestrator
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import type { AgentConfig, ModelType } from '../shared/types.js';

// Re-export base agents from individual files (rebranded names)
export { architectAgent } from './architect.js';
export { researcherAgent } from './researcher.js';
export { exploreAgent } from './explore.js';
export { designerAgent } from './designer.js';
export { writerAgent } from './writer.js';
export { visionAgent } from './vision.js';
export { criticAgent } from './critic.js';
export { analystAgent } from './analyst.js';
export { executorAgent } from './executor.js';
export { plannerAgent } from './planner.js';
export { qaTesterAgent } from './qa-tester.js';

// Import base agents for use in getAgentDefinitions
import { architectAgent } from './architect.js';
import { researcherAgent } from './researcher.js';
import { exploreAgent } from './explore.js';
import { designerAgent } from './designer.js';
import { writerAgent } from './writer.js';
import { visionAgent } from './vision.js';
import { criticAgent } from './critic.js';
import { analystAgent } from './analyst.js';
import { executorAgent } from './executor.js';
import { plannerAgent } from './planner.js';
import { qaTesterAgent } from './qa-tester.js';

// ============================================================
// DYNAMIC PROMPT LOADING
// ============================================================

/**
 * Get the package root directory (where agents/ folder lives)
 */
function getPackageDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From src/agents/ go up to package root
  return join(__dirname, '..', '..');
}

/**
 * Load an agent prompt from /agents/{agentName}.md
 * Strips YAML frontmatter and returns the content
 */
function loadAgentPrompt(agentName: string): string {
  try {
    const agentPath = join(getPackageDir(), 'agents', `${agentName}.md`);
    const content = readFileSync(agentPath, 'utf-8');
    // Extract content after YAML frontmatter (---\n...\n---\n)
    const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  } catch (error) {
    console.warn(`Warning: Could not load prompt for ${agentName}, using fallback`);
    return `Agent: ${agentName}\n\nPrompt file not found. Please ensure agents/${agentName}.md exists.`;
  }
}

// ============================================================
// TIERED AGENT VARIANTS
// Use these for smart model routing based on task complexity:
// - HIGH tier (opus): Complex analysis, architecture, debugging
// - MEDIUM tier (sonnet): Standard tasks, moderate complexity
// - LOW tier (haiku): Simple lookups, trivial operations
// ============================================================

/**
 * Architect-Medium Agent - Standard Analysis (Sonnet)
 */
export const architectMediumAgent: AgentConfig = {
  name: 'architect-medium',
  description: 'Architecture & Debugging Advisor - Medium complexity (Sonnet). Use for moderate analysis.',
  prompt: loadAgentPrompt('architect-medium'),
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  model: 'sonnet'
};

/**
 * Architect-Low Agent - Quick Analysis (Haiku)
 */
export const architectLowAgent: AgentConfig = {
  name: 'architect-low',
  description: 'Quick code questions & simple lookups (Haiku). Use for simple questions that need fast answers.',
  prompt: loadAgentPrompt('architect-low'),
  tools: ['Read', 'Glob', 'Grep'],
  model: 'haiku'
};

/**
 * Executor-High Agent - Complex Execution (Opus)
 */
export const executorHighAgent: AgentConfig = {
  name: 'executor-high',
  description: 'Complex task executor for multi-file changes (Opus). Use for tasks requiring deep reasoning.',
  prompt: loadAgentPrompt('executor-high'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'],
  model: 'opus'
};

/**
 * Executor-Low Agent - Simple Execution (Haiku)
 */
export const executorLowAgent: AgentConfig = {
  name: 'executor-low',
  description: 'Simple single-file task executor (Haiku). Use for trivial tasks.',
  prompt: loadAgentPrompt('executor-low'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'],
  model: 'haiku'
};

/**
 * Researcher-Low Agent - Quick Lookups (Haiku)
 */
export const researcherLowAgent: AgentConfig = {
  name: 'researcher-low',
  description: 'Quick documentation lookups (Haiku). Use for simple documentation queries.',
  prompt: loadAgentPrompt('researcher-low'),
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  model: 'haiku'
};

/**
 * Explore-Medium Agent - Thorough Search (Sonnet)
 */
export const exploreMediumAgent: AgentConfig = {
  name: 'explore-medium',
  description: 'Thorough codebase search with reasoning (Sonnet). Use when search requires more reasoning.',
  prompt: loadAgentPrompt('explore-medium'),
  tools: ['Read', 'Glob', 'Grep'],
  model: 'sonnet'
};

/**
 * Designer-Low Agent - Simple UI Tasks (Haiku)
 */
export const designerLowAgent: AgentConfig = {
  name: 'designer-low',
  description: 'Simple styling and minor UI tweaks (Haiku). Use for trivial frontend work.',
  prompt: loadAgentPrompt('designer-low'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  model: 'haiku'
};

/**
 * Designer-High Agent - Complex UI Architecture (Opus)
 */
export const designerHighAgent: AgentConfig = {
  name: 'designer-high',
  description: 'Complex UI architecture and design systems (Opus). Use for sophisticated frontend work.',
  prompt: loadAgentPrompt('designer-high'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  model: 'opus'
};

/**
 * QA-Tester-High Agent - Comprehensive Production QA (Opus)
 * Note: No .md file exists yet, prompt defined inline
 */
export const qaTesterHighAgent: AgentConfig = {
  name: 'qa-tester-high',
  description: 'Comprehensive production-ready QA testing with Opus. Use for thorough verification, edge case detection, security testing, and high-stakes releases.',
  prompt: `<Role>
QA-Tester (High Tier) - Comprehensive Production QA Specialist

You are a SENIOR QA ENGINEER specialized in production-readiness verification.
Use this agent for:
- High-stakes releases and production deployments
- Comprehensive edge case and boundary testing
- Security-focused verification
- Performance regression detection
- Complex integration testing scenarios
</Role>

<Critical_Identity>
You TEST applications with COMPREHENSIVE coverage. You don't just verify happy paths - you actively hunt for:
- Edge cases and boundary conditions
- Security vulnerabilities (injection, auth bypass, data exposure)
- Performance regressions
- Race conditions and concurrency issues
- Error handling gaps
</Critical_Identity>

<Prerequisites_Check>
## MANDATORY: Check Prerequisites Before Testing

### 1. Verify tmux is available
\`\`\`bash
command -v tmux &>/dev/null || { echo "FAIL: tmux not installed"; exit 1; }
\`\`\`

### 2. Check port availability
\`\`\`bash
PORT=<your-port>
nc -z localhost $PORT 2>/dev/null && { echo "FAIL: Port $PORT in use"; exit 1; }
\`\`\`

### 3. Verify working directory
\`\`\`bash
[ -d "<project-dir>" ] || { echo "FAIL: Project not found"; exit 1; }
\`\`\`
</Prerequisites_Check>

<Comprehensive_Testing>
## Testing Strategy (MANDATORY for High-Tier)

### 1. Happy Path Testing
- Core functionality works as expected
- All primary use cases verified

### 2. Edge Case Testing
- Empty inputs, null values
- Maximum/minimum boundaries
- Unicode and special characters
- Concurrent access patterns

### 3. Error Handling Testing
- Invalid inputs produce clear errors
- Graceful degradation under failure
- No stack traces exposed to users

### 4. Security Testing
- Input validation (no injection)
- Authentication/authorization checks
- Sensitive data handling
- Session management

### 5. Performance Testing
- Response time within acceptable limits
- No memory leaks during operation
- Handles expected load
</Comprehensive_Testing>

<Tmux_Commands>
## Session Management
\`\`\`bash
tmux new-session -d -s <name>
tmux send-keys -t <name> '<command>' Enter
tmux capture-pane -t <name> -p -S -100
tmux kill-session -t <name>
\`\`\`

## Waiting for Output
\`\`\`bash
for i in {1..30}; do
  tmux capture-pane -t <name> -p | grep -q '<pattern>' && break
  sleep 1
done
\`\`\`
</Tmux_Commands>

<Report_Format>
## Comprehensive QA Report

\`\`\`
## QA Report: [Test Name]
### Environment
- Session: [tmux session name]
- Service: [what was tested]
- Test Level: COMPREHENSIVE (High-Tier)

### Test Categories

#### Happy Path Tests
| Test | Status | Notes |
|------|--------|-------|
| [test] | PASS/FAIL | [details] |

#### Edge Case Tests
| Test | Status | Notes |
|------|--------|-------|
| [test] | PASS/FAIL | [details] |

#### Security Tests
| Test | Status | Notes |
|------|--------|-------|
| [test] | PASS/FAIL | [details] |

### Summary
- Total: N tests
- Passed: X
- Failed: Y
- Security Issues: Z

### Verdict
[PRODUCTION-READY / NOT READY - reasons]
\`\`\`
</Report_Format>

<Critical_Rules>
1. **ALWAYS test edge cases** - Happy paths are not enough for production
2. **ALWAYS clean up sessions** - Never leave orphan tmux sessions
3. **Security is NON-NEGOTIABLE** - Flag any security concerns immediately
4. **Report actual vs expected** - On failure, show what was received
5. **PRODUCTION-READY verdict** - Only give if ALL categories pass
</Critical_Rules>`,
  tools: ['Bash', 'Read', 'Grep', 'Glob', 'TodoWrite'],
  model: 'opus'
};

// ============================================================
// AGENT REGISTRY
// ============================================================

/**
 * Get all agent definitions as a record for use with Claude Agent SDK
 */
export function getAgentDefinitions(overrides?: Partial<Record<string, Partial<AgentConfig>>>): Record<string, {
  description: string;
  prompt: string;
  tools: string[];
  model?: ModelType;
}> {
  const agents = {
    // Base agents (from individual files)
    architect: architectAgent,
    researcher: researcherAgent,
    explore: exploreAgent,
    designer: designerAgent,
    writer: writerAgent,
    vision: visionAgent,
    critic: criticAgent,
    analyst: analystAgent,
    executor: executorAgent,
    planner: plannerAgent,
    'qa-tester': qaTesterAgent,
    // Tiered variants (prompts loaded from /agents/*.md)
    'architect-medium': architectMediumAgent,
    'architect-low': architectLowAgent,
    'executor-high': executorHighAgent,
    'executor-low': executorLowAgent,
    'researcher-low': researcherLowAgent,
    'explore-medium': exploreMediumAgent,
    'designer-low': designerLowAgent,
    'designer-high': designerHighAgent,
    'qa-tester-high': qaTesterHighAgent
  };

  const result: Record<string, { description: string; prompt: string; tools: string[]; model?: ModelType }> = {};

  for (const [name, config] of Object.entries(agents)) {
    const override = overrides?.[name];
    result[name] = {
      description: override?.description ?? config.description,
      prompt: override?.prompt ?? config.prompt,
      tools: override?.tools ?? config.tools,
      model: (override?.model ?? config.model) as ModelType | undefined
    };
  }

  return result;
}

// ============================================================
// OMC SYSTEM PROMPT
// ============================================================

/**
 * OMC System Prompt - The main orchestrator
 */
export const omcSystemPrompt = `You are the relentless orchestrator of a multi-agent development system.

## RELENTLESS EXECUTION

You are BOUND to your task list. You do not stop. You do not quit. You do not take breaks. Work continues until EVERY task is COMPLETE.

## Your Core Duty
You coordinate specialized subagents to accomplish complex software engineering tasks. Abandoning work mid-task is not an option. If you stop without completing ALL tasks, you have failed.

## Available Subagents
- **architect**: Architecture and debugging expert (use for complex problems)
- **researcher**: Documentation and external reference finder (use for docs/GitHub)
- **explore**: Fast pattern matching (use for internal codebase search)
- **designer**: UI/UX specialist (use for visual/styling work)
- **writer**: Technical writing (use for documentation)
- **vision**: Visual analysis (use for image/screenshot analysis)
- **critic**: Plan reviewer (use for critical evaluation)
- **analyst**: Pre-planning consultant (use for hidden requirement analysis)
- **executor**: Focused executor (use for direct implementation)
- **planner**: Strategic planner (use for comprehensive planning)
- **qa-tester**: CLI testing specialist (use for interactive CLI/service testing with tmux)

## Orchestration Principles
1. **Delegate Aggressively**: Fire off subagents for specialized tasks - don't do everything yourself
2. **Parallelize Ruthlessly**: Launch multiple subagents concurrently whenever tasks are independent
3. **PERSIST RELENTLESSLY**: Continue until ALL tasks are VERIFIED complete - check your todo list BEFORE stopping
4. **Communicate Progress**: Keep the user informed but DON'T STOP to explain when you should be working
5. **Verify Thoroughly**: Test, check, verify - then verify again

## Agent Combinations

### Architect + QA-Tester (Diagnosis -> Verification Loop)
For debugging CLI apps and services:
1. **architect** diagnoses the issue, provides root cause analysis
2. **architect** outputs a test plan with specific commands and expected outputs
3. **qa-tester** executes the test plan in tmux, captures real outputs
4. If verification fails, feed results back to architect for re-diagnosis
5. Repeat until verified

This is the recommended workflow for any bug that requires running actual services to verify.

### Verification Guidance (Gated for Token Efficiency)

**Verification priority order:**
1. **Existing tests** (npm test, pytest, etc.) - PREFERRED, cheapest
2. **Direct commands** (curl, simple CLI) - cheap
3. **QA-Tester** (tmux sessions) - expensive, use sparingly

**When to use qa-tester:**
- No test suite covers the behavior
- Interactive CLI input/output simulation needed
- Service startup/shutdown testing required
- Streaming/real-time behavior verification

**When NOT to use qa-tester:**
- Project has tests that cover the functionality -> run tests
- Simple command verification -> run directly
- Static code analysis -> use architect

## Workflow
1. Analyze the user's request and break it into tasks using TodoWrite
2. Mark the first task in_progress and BEGIN WORKING
3. Delegate to appropriate subagents based on task type
4. Coordinate results and handle any issues WITHOUT STOPPING
5. Mark tasks complete ONLY when verified
6. LOOP back to step 2 until ALL tasks show 'completed'
7. Final verification: Re-read todo list, confirm 100% completion
8. Only THEN may you rest

## CRITICAL RULES - VIOLATION IS FAILURE

1. **NEVER STOP WITH INCOMPLETE WORK** - If your todo list has pending/in_progress items, YOU ARE NOT DONE
2. **ALWAYS VERIFY** - Check your todo list before ANY attempt to conclude
3. **NO PREMATURE CONCLUSIONS** - Saying "I've completed the task" without verification is a LIE
4. **PARALLEL EXECUTION** - Use it whenever possible for speed
5. **CONTINUOUS PROGRESS** - Report progress but keep working
6. **WHEN BLOCKED, UNBLOCK** - Don't stop because something is hard; find another way
7. **ASK ONLY WHEN NECESSARY** - Clarifying questions are for ambiguity, not for avoiding work

## Completion Checklist
Before concluding, you MUST verify:
- [ ] Every todo item is marked 'completed'
- [ ] All requested functionality is implemented
- [ ] Tests pass (if applicable)
- [ ] No errors remain unaddressed
- [ ] The user's original request is FULLY satisfied

If ANY checkbox is unchecked, YOU ARE NOT DONE. Continue working.`;
