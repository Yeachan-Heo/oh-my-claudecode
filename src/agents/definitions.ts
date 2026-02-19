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
import { loadAgentPrompt, parseDisallowedTools } from './utils.js';

// Re-export base agents from individual files (rebranded names)
export { architectAgent } from './architect.js';
export { designerAgent } from './designer.js';
export { writerAgent } from './writer.js';
export { visionAgent } from './vision.js';
export { criticAgent } from './critic.js';
export { analystAgent } from './analyst.js';
export { executorAgent } from './executor.js';
export { plannerAgent } from './planner.js';
export { deepExecutorAgent } from './deep-executor.js';
export { qaTesterAgent } from './qa-tester.js';
export { scientistAgent } from './scientist.js';
export { exploreAgent } from './explore.js';

// Backward compatibility: Deprecated aliases
/** @deprecated Use dependency-expert agent instead */
export { documentSpecialistAgent } from './document-specialist.js';
/** @deprecated Use document-specialist agent instead */
export { documentSpecialistAgent as researcherAgent } from './document-specialist.js';

// Import base agents for use in getAgentDefinitions
import { architectAgent } from './architect.js';
import { designerAgent } from './designer.js';
import { writerAgent } from './writer.js';
import { visionAgent } from './vision.js';
import { criticAgent } from './critic.js';
import { analystAgent } from './analyst.js';
import { executorAgent } from './executor.js';
import { plannerAgent } from './planner.js';
import { deepExecutorAgent } from './deep-executor.js';
import { qaTesterAgent } from './qa-tester.js';
import { scientistAgent } from './scientist.js';
import { exploreAgent } from './explore.js';
import { documentSpecialistAgent } from './document-specialist.js';

// Re-export loadAgentPrompt (also exported from index.ts)
export { loadAgentPrompt };

// ============================================================
// REFORMED AGENTS (BUILD/ANALYSIS LANE)
// ============================================================

/**
 * Debugger Agent - Root-Cause Analysis & Debugging (Sonnet)
 */
export const debuggerAgent: AgentConfig = {
  name: 'debugger',
  description: 'Root-cause analysis, regression isolation, failure diagnosis (Sonnet).',
  prompt: loadAgentPrompt('debugger'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Verifier Agent - Completion Evidence & Test Validation (Sonnet)
 */
export const verifierAgent: AgentConfig = {
  name: 'verifier',
  description: 'Completion evidence, claim validation, test adequacy (Sonnet).',
  prompt: loadAgentPrompt('verifier'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

// ============================================================
// REFORMED AGENTS (REVIEW LANE)
// ============================================================

/**
 * Style-Reviewer Agent - Code Style & Conventions (Haiku)
 */
export const styleReviewerAgent: AgentConfig = {
  name: 'style-reviewer',
  description: 'Formatting, naming, idioms, lint/style conventions (Haiku).',
  prompt: loadAgentPrompt('style-reviewer'),
  model: 'haiku',
  defaultModel: 'haiku'
};

/**
 * Quality-Reviewer Agent - Logic Defects & Maintainability (Sonnet)
 */
export const qualityReviewerAgent: AgentConfig = {
  name: 'quality-reviewer',
  description: 'Logic defects, maintainability, anti-patterns (Sonnet).',
  prompt: loadAgentPrompt('quality-reviewer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * API-Reviewer Agent - API Contracts & Versioning (Sonnet)
 */
export const apiReviewerAgent: AgentConfig = {
  name: 'api-reviewer',
  description: 'API contracts, versioning, backward compatibility (Sonnet).',
  prompt: loadAgentPrompt('api-reviewer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Performance-Reviewer Agent - Performance & Complexity (Sonnet)
 */
export const performanceReviewerAgent: AgentConfig = {
  name: 'performance-reviewer',
  description: 'Hotspots, complexity, memory/latency optimization (Sonnet).',
  prompt: loadAgentPrompt('performance-reviewer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

// ============================================================
// REFORMED AGENTS (DOMAIN SPECIALISTS)
// ============================================================

/**
 * Dependency-Expert Agent - External SDK/API/Package Evaluation (Sonnet)
 * Replaces: researcher agent
 */
export const dependencyExpertAgent: AgentConfig = {
  name: 'dependency-expert',
  description: 'External SDK/API/package evaluation (Sonnet).',
  prompt: loadAgentPrompt('dependency-expert'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Test-Engineer Agent - Test Strategy & Coverage (Sonnet)
 * Replaces: tdd-guide agent
 */
export const testEngineerAgent: AgentConfig = {
  name: 'test-engineer',
  description: 'Test strategy, coverage, flaky test hardening (Sonnet).',
  prompt: loadAgentPrompt('test-engineer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Quality-Strategist Agent - Quality Strategy & Release Readiness (Sonnet)
 */
export const qualityStrategistAgent: AgentConfig = {
  name: 'quality-strategist',
  description: 'Quality strategy, release readiness, risk assessment, and quality gates (Sonnet).',
  prompt: loadAgentPrompt('quality-strategist'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

// ============================================================
// REFORMED AGENTS (PRODUCT LANE)
// ============================================================

/**
 * Product Manager Agent - Problem Framing & Value Hypothesis (Sonnet)
 */
export const productManagerAgent: AgentConfig = {
  name: 'product-manager',
  description: 'Problem framing, personas/JTBD, value hypothesis, PRDs, KPI trees (Sonnet).',
  prompt: loadAgentPrompt('product-manager'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * UX Researcher Agent - Heuristic Audits & Usability (Sonnet)
 */
export const uxResearcherAgent: AgentConfig = {
  name: 'ux-researcher',
  description: 'Heuristic audits, usability risks, accessibility, research plans (Sonnet).',
  prompt: loadAgentPrompt('ux-researcher'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Information Architect Agent - Taxonomy & Navigation (Sonnet)
 */
export const informationArchitectAgent: AgentConfig = {
  name: 'information-architect',
  description: 'Taxonomy, navigation, findability, naming consistency (Sonnet).',
  prompt: loadAgentPrompt('information-architect'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Product Analyst Agent - Metrics & Experiment Design (Sonnet)
 */
export const productAnalystAgent: AgentConfig = {
  name: 'product-analyst',
  description: 'Product metrics, funnel analysis, experiment design, KPI definitions (Sonnet).',
  prompt: loadAgentPrompt('product-analyst'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

// ============================================================
// SPECIALIZED AGENTS (Security, Build, TDD, Code Review)
// ============================================================

/**
 * Security-Reviewer Agent - Security Vulnerability Detection (Sonnet)
 */
export const securityReviewerAgent: AgentConfig = {
  name: 'security-reviewer',
  description: 'Security vulnerability detection specialist (Sonnet). Use for security audits and OWASP detection.',
  prompt: loadAgentPrompt('security-reviewer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Build-Fixer Agent - Build Error Resolution (Sonnet)
 */
export const buildFixerAgent: AgentConfig = {
  name: 'build-fixer',
  description: 'Build and compilation error resolution specialist (Sonnet). Use for fixing build/type errors in any language.',
  prompt: loadAgentPrompt('build-fixer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Code-Reviewer Agent - Expert Code Review (Opus)
 */
export const codeReviewerAgent: AgentConfig = {
  name: 'code-reviewer',
  description: 'Expert code review specialist (Opus). Use for comprehensive code quality review.',
  prompt: loadAgentPrompt('code-reviewer'),
  model: 'opus',
  defaultModel: 'opus'
};


/**
 * Git-Master Agent - Git Operations Expert (Sonnet)
 */
export const gitMasterAgent: AgentConfig = {
  name: 'git-master',
  description: 'Git expert for atomic commits, rebasing, and history management with style detection',
  prompt: loadAgentPrompt('git-master'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

/**
 * Code-Simplifier Agent - Code Simplification & Refactoring (Opus)
 */
export const codeSimplifierAgent: AgentConfig = {
  name: 'code-simplifier',
  description: 'Simplifies and refines code for clarity, consistency, and maintainability (Opus).',
  prompt: loadAgentPrompt('code-simplifier'),
  model: 'opus',
  defaultModel: 'opus'
};

// ============================================================
// DEPRECATED ALIASES (Backward Compatibility)
// ============================================================

/**
 * @deprecated Use dependency-expert agent instead
 */
export const researcherAgentAlias = dependencyExpertAgent;

/**
 * @deprecated Use test-engineer agent instead
 */
export const tddGuideAgentAlias = testEngineerAgent;

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
  tools?: string[];
  disallowedTools?: string[];
  model?: ModelType;
  defaultModel?: ModelType;
}> {
  const agents = {
    // ============================================================
    // BUILD/ANALYSIS LANE
    // ============================================================
    explore: exploreAgent,
    analyst: analystAgent,
    planner: plannerAgent,
    architect: architectAgent,
    debugger: debuggerAgent,
    executor: executorAgent,
    'deep-executor': deepExecutorAgent,
    verifier: verifierAgent,

    // ============================================================
    // REVIEW LANE
    // ============================================================
    'style-reviewer': styleReviewerAgent,
    'quality-reviewer': qualityReviewerAgent,
    'api-reviewer': apiReviewerAgent,
    'security-reviewer': securityReviewerAgent,
    'performance-reviewer': performanceReviewerAgent,
    'code-reviewer': codeReviewerAgent,

    // ============================================================
    // DOMAIN SPECIALISTS
    // ============================================================
    'dependency-expert': dependencyExpertAgent,
    'test-engineer': testEngineerAgent,
    'quality-strategist': qualityStrategistAgent,
    'build-fixer': buildFixerAgent,
    designer: designerAgent,
    writer: writerAgent,
    'qa-tester': qaTesterAgent,
    scientist: scientistAgent,
    'git-master': gitMasterAgent,
    'code-simplifier': codeSimplifierAgent,

    // ============================================================
    // PRODUCT LANE
    // ============================================================
    'product-manager': productManagerAgent,
    'ux-researcher': uxResearcherAgent,
    'information-architect': informationArchitectAgent,
    'product-analyst': productAnalystAgent,

    // ============================================================
    // COORDINATION
    // ============================================================
    critic: criticAgent,
    vision: visionAgent,

    // ============================================================
    // BACKWARD COMPATIBILITY (Deprecated)
    // ============================================================
    'document-specialist': documentSpecialistAgent,
    researcher: documentSpecialistAgent,
    'tdd-guide': testEngineerAgent
  };

  const result: Record<string, { description: string; prompt: string; tools?: string[]; disallowedTools?: string[]; model?: ModelType; defaultModel?: ModelType }> = {};

  for (const [name, config] of Object.entries(agents)) {
    const override = overrides?.[name];
    const disallowedTools = config.disallowedTools ?? parseDisallowedTools(name);
    result[name] = {
      description: override?.description ?? config.description,
      prompt: override?.prompt ?? config.prompt,
      tools: override?.tools ?? config.tools,
      disallowedTools,
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

## Available Subagents (28 Agents)

### Build/Analysis Lane
- **explore**: Internal codebase discovery (haiku) — fast pattern matching
- **analyst**: Requirements clarity (opus) — hidden constraint analysis
- **planner**: Task sequencing (opus) — execution plans and risk flags
- **architect**: System design (opus) — boundaries, interfaces, tradeoffs
- **debugger**: Root-cause analysis (sonnet) — regression isolation, diagnosis
- **executor**: Code implementation (sonnet) — features and refactoring
- **deep-executor**: Complex execution (opus) — autonomous goal-oriented work
- **verifier**: Completion validation (sonnet) — evidence, claims, test adequacy

### Review Lane
- **style-reviewer**: Code style (haiku) — formatting, naming, idioms
- **quality-reviewer**: Logic defects (sonnet) — maintainability, anti-patterns
- **api-reviewer**: API contracts (sonnet) — versioning, backward compatibility
- **security-reviewer**: Security audits (sonnet) — vulns, trust boundaries, authn/authz
- **performance-reviewer**: Performance (sonnet) — hotspots, complexity, optimization
- **code-reviewer**: Comprehensive review (opus) — orchestrates all review aspects

### Domain Specialists
- **dependency-expert**: SDK/API evaluation (sonnet) — external package research
- **test-engineer**: Test strategy (sonnet) — coverage, flaky test hardening
- **quality-strategist**: Quality strategy (sonnet) — release readiness, risk assessment, quality gates
- **build-fixer**: Build errors (sonnet) — toolchain/type failures
- **designer**: UI/UX architecture (sonnet) — interaction design
- **writer**: Documentation (haiku) — docs, migration notes
- **qa-tester**: CLI testing (sonnet) — interactive runtime validation via tmux
- **scientist**: Data analysis (sonnet) — statistics and research
- **git-master**: Git operations (sonnet) — commits, rebasing, history

### Product Lane
- **product-manager**: Problem framing (sonnet) — personas, JTBD, PRDs, KPI trees
- **ux-researcher**: UX research (sonnet) — heuristic audits, usability, accessibility
- **information-architect**: Info architecture (sonnet) — taxonomy, navigation, findability
- **product-analyst**: Product analytics (sonnet) — metrics, funnels, experiment design

### Coordination
- **critic**: Plan review (opus) — critical challenge and evaluation
- **vision**: Visual analysis (sonnet) — images, screenshots, diagrams

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
1. **Existing tests** (run the project's test command) - PREFERRED, cheapest
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
