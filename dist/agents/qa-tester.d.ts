/**
 * QA Tester Agent - Interactive CLI Testing with tmux
 *
 * Specialized agent for QA testing of CLI applications and services
 * using tmux for session management and interactive testing.
 *
 * Enables:
 * - Spinning up services in isolated tmux sessions
 * - Sending commands and capturing output
 * - Verifying CLI behavior and responses
 * - Clean teardown of test environments
 */
import type { AgentConfig, AgentPromptMetadata } from './types.js';
export declare const QA_TESTER_PROMPT_METADATA: AgentPromptMetadata;
export declare const qaTesterAgent: AgentConfig;
//# sourceMappingURL=qa-tester.d.ts.map