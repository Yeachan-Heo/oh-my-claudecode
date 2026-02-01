/**
 * Agent Definitions for Oh-My-Claude-Sisyphus
 *
 * This module provides:
 * 1. Re-exports of base agents from individual files
 * 2. Tiered agent variants with dynamically loaded prompts from /agents/*.md
 * 3. getAgentDefinitions() for agent registry
 * 4. omcSystemPrompt for the main orchestrator
 */

import type { AgentConfig, ModelType } from '../shared/types.js';
import { loadAgentPrompt } from './utils.js';

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
export { scientistAgent } from './scientist.js';

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
import { scientistAgent } from './scientist.js';

// Re-export loadAgentPrompt (also exported from index.ts)
export { loadAgentPrompt };

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
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'lsp_diagnostics', 'lsp_diagnostics_directory', 'ast_grep_search'],
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Architect-Low Agent - Quick Analysis (Haiku)
 */
export const architectLowAgent: AgentConfig = {
  name: 'architect-low',
  description: 'Quick code questions & simple lookups (Haiku). Use for simple questions that need fast answers.',
  prompt: loadAgentPrompt('architect-low'),
  tools: ['Read', 'Glob', 'Grep', 'lsp_diagnostics'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Executor-High Agent - Complex Execution (Opus)
 */
export const executorHighAgent: AgentConfig = {
  name: 'executor-high',
  description: 'Complex task executor for multi-file changes (Opus). Use for tasks requiring deep reasoning.',
  prompt: loadAgentPrompt('executor-high'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'lsp_diagnostics', 'lsp_diagnostics_directory', 'ast_grep_search', 'ast_grep_replace'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * Executor-Low Agent - Simple Execution (Haiku)
 */
export const executorLowAgent: AgentConfig = {
  name: 'executor-low',
  description: 'Simple single-file task executor (Haiku). Use for trivial tasks.',
  prompt: loadAgentPrompt('executor-low'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'lsp_diagnostics'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Researcher-Low Agent - Quick Lookups (Haiku)
 */
export const researcherLowAgent: AgentConfig = {
  name: 'researcher-low',
  description: 'Quick documentation lookups (Haiku). Use for simple documentation queries.',
  prompt: loadAgentPrompt('researcher-low'),
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Explore-Medium Agent - Thorough Search (Sonnet)
 */
export const exploreMediumAgent: AgentConfig = {
  name: 'explore-medium',
  description: 'Thorough codebase search with reasoning (Sonnet). Use when search requires more reasoning.',
  prompt: loadAgentPrompt('explore-medium'),
  tools: ['Read', 'Glob', 'Grep', 'ast_grep_search', 'lsp_document_symbols', 'lsp_workspace_symbols'],
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Explore-High Agent - Complex Architectural Search (Opus)
 */
export const exploreHighAgent: AgentConfig = {
  name: 'explore-high',
  description: 'Complex architectural search for deep system understanding (Opus). Use for architectural mapping and design pattern discovery.',
  prompt: loadAgentPrompt('explore-high'),
  tools: ['Read', 'Glob', 'Grep', 'ast_grep_search', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_find_references'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * Designer-Low Agent - Simple UI Tasks (Haiku)
 */
export const designerLowAgent: AgentConfig = {
  name: 'designer-low',
  description: 'Simple styling and minor UI tweaks (Haiku). Use for trivial frontend work.',
  prompt: loadAgentPrompt('designer-low'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Designer-High Agent - Complex UI Architecture (Opus)
 */
export const designerHighAgent: AgentConfig = {
  name: 'designer-high',
  description: 'Complex UI architecture and design systems (Opus). Use for sophisticated frontend work.',
  prompt: loadAgentPrompt('designer-high'),
  tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * QA-Tester-High Agent - Comprehensive Production QA (Opus)
 */
export const qaTesterHighAgent: AgentConfig = {
  name: 'qa-tester-high',
  description: 'Comprehensive production-ready QA testing with Opus. Use for thorough verification, edge case detection, security testing, and high-stakes releases.',
  prompt: loadAgentPrompt('qa-tester-high'),
  tools: ['Bash', 'Read', 'Grep', 'Glob', 'TodoWrite', 'lsp_diagnostics'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * Scientist-Low Agent - Quick Data Inspection (Haiku)
 */
export const scientistLowAgent: AgentConfig = {
  name: 'scientist-low',
  description: 'Quick data inspection and simple statistics (Haiku). Use for fast, simple queries.',
  prompt: loadAgentPrompt('scientist-low'),
  tools: ['Read', 'Glob', 'Grep', 'Bash', 'python_repl'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Scientist-High Agent - Complex Research (Opus)
 */
export const scientistHighAgent: AgentConfig = {
  name: 'scientist-high',
  description: 'Complex research, hypothesis testing, and ML specialist (Opus). Use for deep analysis.',
  prompt: loadAgentPrompt('scientist-high'),
  tools: ['Read', 'Glob', 'Grep', 'Bash', 'python_repl'],
  model: 'opus',
  defaultModel: 'opus'
};

// ============================================================
// SPECIALIZED AGENTS (Security, Build, TDD, Code Review)
// ============================================================

/**
 * Security-Reviewer Agent - Security Vulnerability Detection (Opus)
 */
export const securityReviewerAgent: AgentConfig = {
  name: 'security-reviewer',
  description: 'Security vulnerability detection specialist (Opus). Use for security audits and code review.',
  prompt: loadAgentPrompt('security-reviewer'),
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * Security-Reviewer-Low Agent - Quick Security Scan (Haiku)
 */
export const securityReviewerLowAgent: AgentConfig = {
  name: 'security-reviewer-low',
  description: 'Quick security scan specialist (Haiku). Use for fast security checks on small code changes.',
  prompt: loadAgentPrompt('security-reviewer-low'),
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Build-Fixer Agent - Build Error Resolution (Sonnet)
 */
export const buildFixerAgent: AgentConfig = {
  name: 'build-fixer',
  description: 'Build and compilation error resolution specialist (Sonnet). Use for fixing build/type errors in any language.',
  prompt: loadAgentPrompt('build-fixer'),
  tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'lsp_diagnostics', 'lsp_diagnostics_directory'],
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Build-Fixer-Low Agent - Simple Build Fix (Haiku)
 */
export const buildFixerLowAgent: AgentConfig = {
  name: 'build-fixer-low',
  description: 'Simple build error fixer (Haiku). Use for trivial type errors and single-line fixes.',
  prompt: loadAgentPrompt('build-fixer-low'),
  tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'lsp_diagnostics', 'lsp_diagnostics_directory'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * TDD-Guide Agent - Test-Driven Development (Sonnet)
 */
export const tddGuideAgent: AgentConfig = {
  name: 'tdd-guide',
  description: 'Test-Driven Development specialist (Sonnet). Use for TDD workflows and test coverage.',
  prompt: loadAgentPrompt('tdd-guide'),
  tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'lsp_diagnostics'],
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * TDD-Guide-Low Agent - Quick Test Suggestions (Haiku)
 */
export const tddGuideLowAgent: AgentConfig = {
  name: 'tdd-guide-low',
  description: 'Quick test suggestion specialist (Haiku). Use for simple test case ideas.',
  prompt: loadAgentPrompt('tdd-guide-low'),
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'lsp_diagnostics'],
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Code-Reviewer Agent - Expert Code Review (Opus)
 */
export const codeReviewerAgent: AgentConfig = {
  name: 'code-reviewer',
  description: 'Expert code review specialist (Opus). Use for comprehensive code quality review.',
  prompt: loadAgentPrompt('code-reviewer'),
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'lsp_diagnostics', 'ast_grep_search'],
  model: 'opus',
  defaultModel: 'opus'
};

/**
 * Code-Reviewer-Low Agent - Quick Code Check (Haiku)
 */
export const codeReviewerLowAgent: AgentConfig = {
  name: 'code-reviewer-low',
  description: 'Quick code quality checker (Haiku). Use for fast review of small changes.',
  prompt: loadAgentPrompt('code-reviewer-low'),
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'lsp_diagnostics'],
  model: 'haiku',
  defaultModel: 'haiku'
};

// ============================================================
// AGENT REGISTRY
// ============================================================

/**
 * Agent Role Disambiguation
 *
 * HIGH-tier review/planning agents have distinct, non-overlapping roles:
 *
 * | Agent | Role | What They Do | What They Don't Do |
 * |-------|------|--------------|-------------------|
 * | architect | code-analysis | Analyze code, debug, verify | Requirements, plan creation, plan review |
 * | analyst | requirements-analysis | Find requirement gaps | Code analysis, planning, plan review |
 * | planner | plan-creation | Create work plans | Requirements, code analysis, plan review |
 * | critic | plan-review | Review plan quality | Requirements, code analysis, plan creation |
 *
 * Workflow: explore → analyst → planner → critic → executor → architect (verify)
 */

/**
 * Get all agent definitions as a record for use with Claude Agent SDK
 */
export function getAgentDefinitions(overrides?: Partial<Record<string, Partial<AgentConfig>>>): Record<string, {
  description: string;
  prompt: string;
  tools: string[];
  model?: ModelType;
  defaultModel?: ModelType;
}> {
  const agents = {
    // Base agents (from individual files)
    // Role: code-analysis
    // NotFor: requirements-gathering, plan-creation, plan-review
    architect: architectAgent,
    researcher: researcherAgent,
    explore: exploreAgent,
    designer: designerAgent,
    writer: writerAgent,
    vision: visionAgent,
    // Role: plan-review
    // NotFor: requirements-gathering, plan-creation, code-analysis
    critic: criticAgent,
    // Role: requirements-analysis
    // NotFor: code-analysis, plan-creation, plan-review
    analyst: analystAgent,
    executor: executorAgent,
    // Role: plan-creation
    // NotFor: requirements-gathering, code-analysis, plan-review
    planner: plannerAgent,
    'qa-tester': qaTesterAgent,
    scientist: scientistAgent,
    // Tiered variants (prompts loaded from /agents/*.md)
    'architect-medium': architectMediumAgent,
    'architect-low': architectLowAgent,
    'executor-high': executorHighAgent,
    'executor-low': executorLowAgent,
    'researcher-low': researcherLowAgent,
    'explore-medium': exploreMediumAgent,
    'explore-high': exploreHighAgent,
    'designer-low': designerLowAgent,
    'designer-high': designerHighAgent,
    'qa-tester-high': qaTesterHighAgent,
    'scientist-low': scientistLowAgent,
    'scientist-high': scientistHighAgent,
    // Specialized agents (Security, Build, TDD, Code Review)
    'security-reviewer': securityReviewerAgent,
    'security-reviewer-low': securityReviewerLowAgent,
    'build-fixer': buildFixerAgent,
    'build-fixer-low': buildFixerLowAgent,
    'tdd-guide': tddGuideAgent,
    'tdd-guide-low': tddGuideLowAgent,
    'code-reviewer': codeReviewerAgent,
    'code-reviewer-low': codeReviewerLowAgent
  };

  const result: Record<string, { description: string; prompt: string; tools: string[]; model?: ModelType; defaultModel?: ModelType }> = {};

  for (const [name, config] of Object.entries(agents)) {
    const override = overrides?.[name];
    result[name] = {
      description: override?.description ?? config.description,
      prompt: override?.prompt ?? config.prompt,
      tools: override?.tools ?? config.tools,
      model: (override?.model ?? config.model) as ModelType | undefined,
      defaultModel: (override?.defaultModel ?? config.defaultModel) as ModelType | undefined
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
