/**
 * Deep Executor Agent - Autonomous Deep Worker
 *
 * Ported from oh-my-opencode's Hephaestus agent (PR #1287).
 * Inspired by AmpCode's deep mode - goal-oriented autonomous execution with explore-first behavior.
 *
 * Key behaviors:
 * - Explore-first: Uses own tools extensively before acting
 * - Self-execution: Does all work itself (no delegation)
 * - 100% completion guarantee with verification evidence
 */
import type { AgentConfig, AgentPromptMetadata } from './types.js';
export declare const DEEP_EXECUTOR_PROMPT_METADATA: AgentPromptMetadata;
export declare const deepExecutorAgent: AgentConfig;
//# sourceMappingURL=deep-executor.d.ts.map