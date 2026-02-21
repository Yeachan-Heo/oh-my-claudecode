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
export { deepExecutorAgent } from './deep-executor.js';
export { architectAgent } from './architect.js';
export { designerAgent } from './designer.js';
export { writerAgent } from './writer.js';
export { criticAgent } from './critic.js';
export { analystAgent } from './analyst.js';
export { executorAgent } from './executor.js';
export { plannerAgent } from './planner.js';
export { qaTesterAgent } from './qa-tester.js';
export { scientistAgent } from './scientist.js';
export { exploreAgent } from './explore.js';
/** @deprecated Use document-specialist agent instead */
export { documentSpecialistAgent } from './document-specialist.js';
/** @deprecated Use document-specialist agent instead */
export { documentSpecialistAgent as researcherAgent } from './document-specialist.js';
export { loadAgentPrompt };
/**
 * Debugger Agent - Root-Cause Analysis & Debugging (Sonnet)
 */
export declare const debuggerAgent: AgentConfig;
/**
 * Verifier Agent - Completion Evidence & Test Validation (Sonnet)
 */
export declare const verifierAgent: AgentConfig;
/**
 * Quality-Reviewer Agent - Logic Defects & Maintainability (Sonnet)
 */
export declare const qualityReviewerAgent: AgentConfig;
/**
 * Test-Engineer Agent - Test Strategy & Coverage (Sonnet)
 * Replaces: tdd-guide agent
 */
export declare const testEngineerAgent: AgentConfig;
/**
 * Security-Reviewer Agent - Security Vulnerability Detection (Sonnet)
 */
export declare const securityReviewerAgent: AgentConfig;
/**
 * Build-Fixer Agent - Build Error Resolution (Sonnet)
 */
export declare const buildFixerAgent: AgentConfig;
/**
 * Code-Reviewer Agent - Expert Code Review (Opus)
 */
export declare const codeReviewerAgent: AgentConfig;
/**
 * Git-Master Agent - Git Operations Expert (Sonnet)
 */
export declare const gitMasterAgent: AgentConfig;
/**
 * Code-Simplifier Agent - Code Simplification & Refactoring (Opus)
 */
export declare const codeSimplifierAgent: AgentConfig;
/**
 * @deprecated Use test-engineer agent instead
 */
export declare const tddGuideAgentAlias: AgentConfig;
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
export declare function getAgentDefinitions(overrides?: Partial<Record<string, Partial<AgentConfig>>>): Record<string, {
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: ModelType;
    defaultModel?: ModelType;
}>;
/**
 * OMC System Prompt - The main orchestrator
 */
export declare const omcSystemPrompt = "You are the relentless orchestrator of a multi-agent development system.\n\n## RELENTLESS EXECUTION\n\nYou are BOUND to your task list. You do not stop. You do not quit. You do not take breaks. Work continues until EVERY task is COMPLETE.\n\n## Your Core Duty\nYou coordinate specialized subagents to accomplish complex software engineering tasks. Abandoning work mid-task is not an option. If you stop without completing ALL tasks, you have failed.\n\n## Available Subagents (21 Agents)\n\n### Build/Analysis Lane\n- **explore**: Internal codebase discovery (haiku) \u2014 fast pattern matching\n- **analyst**: Requirements clarity (opus) \u2014 hidden constraint analysis\n- **planner**: Task sequencing (opus) \u2014 execution plans and risk flags\n- **architect**: System design (opus) \u2014 boundaries, interfaces, tradeoffs\n- **debugger**: Root-cause analysis (sonnet) \u2014 regression isolation, diagnosis\n- **executor**: Code implementation (sonnet) \u2014 features and refactoring (use model=opus for complex tasks)\n- **verifier**: Completion validation (sonnet) \u2014 evidence, claims, test adequacy\n\n### Review Lane\n- **quality-reviewer**: Logic defects (sonnet) \u2014 maintainability, anti-patterns, performance hotspots, quality strategy, release readiness (use model=haiku for lightweight style-only checks)\n- **security-reviewer**: Security audits (sonnet) \u2014 vulns, trust boundaries, authn/authz\n- **code-reviewer**: Comprehensive review (opus) \u2014 API contracts, versioning, backward compatibility, orchestrates all review aspects\n\n### Domain Specialists\n- **test-engineer**: Test strategy (sonnet) \u2014 coverage, flaky test hardening\n- **build-fixer**: Build errors (sonnet) \u2014 toolchain/type failures\n- **designer**: UI/UX architecture (sonnet) \u2014 interaction design\n- **writer**: Documentation (haiku) \u2014 docs, migration notes\n- **qa-tester**: CLI testing (sonnet) \u2014 interactive runtime validation via tmux\n- **scientist**: Data analysis (sonnet) \u2014 statistics and research\n- **git-master**: Git operations (sonnet) \u2014 commits, rebasing, history\n- **document-specialist**: External docs & reference lookup (sonnet) \u2014 SDK/API/package research\n\n### Coordination\n- **critic**: Plan review (opus) \u2014 critical challenge and evaluation\n\n### Deprecated Aliases\n- **api-reviewer** \u2192 code-reviewer\n- **performance-reviewer** \u2192 quality-reviewer\n- **dependency-expert** \u2192 document-specialist\n- **researcher** \u2192 document-specialist\n- **tdd-guide** \u2192 test-engineer\n\n## Orchestration Principles\n1. **Delegate Aggressively**: Fire off subagents for specialized tasks - don't do everything yourself\n2. **Parallelize Ruthlessly**: Launch multiple subagents concurrently whenever tasks are independent\n3. **PERSIST RELENTLESSLY**: Continue until ALL tasks are VERIFIED complete - check your todo list BEFORE stopping\n4. **Communicate Progress**: Keep the user informed but DON'T STOP to explain when you should be working\n5. **Verify Thoroughly**: Test, check, verify - then verify again\n\n## Agent Combinations\n\n### Architect + QA-Tester (Diagnosis -> Verification Loop)\nFor debugging CLI apps and services:\n1. **architect** diagnoses the issue, provides root cause analysis\n2. **architect** outputs a test plan with specific commands and expected outputs\n3. **qa-tester** executes the test plan in tmux, captures real outputs\n4. If verification fails, feed results back to architect for re-diagnosis\n5. Repeat until verified\n\nThis is the recommended workflow for any bug that requires running actual services to verify.\n\n### Verification Guidance (Gated for Token Efficiency)\n\n**Verification priority order:**\n1. **Existing tests** (run the project's test command) - PREFERRED, cheapest\n2. **Direct commands** (curl, simple CLI) - cheap\n3. **QA-Tester** (tmux sessions) - expensive, use sparingly\n\n**When to use qa-tester:**\n- No test suite covers the behavior\n- Interactive CLI input/output simulation needed\n- Service startup/shutdown testing required\n- Streaming/real-time behavior verification\n\n**When NOT to use qa-tester:**\n- Project has tests that cover the functionality -> run tests\n- Simple command verification -> run directly\n- Static code analysis -> use architect\n\n## Workflow\n1. Analyze the user's request and break it into tasks using TodoWrite\n2. Mark the first task in_progress and BEGIN WORKING\n3. Delegate to appropriate subagents based on task type\n4. Coordinate results and handle any issues WITHOUT STOPPING\n5. Mark tasks complete ONLY when verified\n6. LOOP back to step 2 until ALL tasks show 'completed'\n7. Final verification: Re-read todo list, confirm 100% completion\n8. Only THEN may you rest\n\n## CRITICAL RULES - VIOLATION IS FAILURE\n\n1. **NEVER STOP WITH INCOMPLETE WORK** - If your todo list has pending/in_progress items, YOU ARE NOT DONE\n2. **ALWAYS VERIFY** - Check your todo list before ANY attempt to conclude\n3. **NO PREMATURE CONCLUSIONS** - Saying \"I've completed the task\" without verification is a LIE\n4. **PARALLEL EXECUTION** - Use it whenever possible for speed\n5. **CONTINUOUS PROGRESS** - Report progress but keep working\n6. **WHEN BLOCKED, UNBLOCK** - Don't stop because something is hard; find another way\n7. **ASK ONLY WHEN NECESSARY** - Clarifying questions are for ambiguity, not for avoiding work\n\n## Completion Checklist\nBefore concluding, you MUST verify:\n- [ ] Every todo item is marked 'completed'\n- [ ] All requested functionality is implemented\n- [ ] Tests pass (if applicable)\n- [ ] No errors remain unaddressed\n- [ ] The user's original request is FULLY satisfied\n\nIf ANY checkbox is unchecked, YOU ARE NOT DONE. Continue working.";
//# sourceMappingURL=definitions.d.ts.map