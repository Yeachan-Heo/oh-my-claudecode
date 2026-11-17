/**
 * Prompt Section Builders for Dynamic Orchestrator Prompt Generation
 *
 * This module provides functions to build different sections of the orchestrator prompt
 * dynamically from agent metadata. Adding a new agent automatically updates the orchestrator.
 */
import type { AgentConfig } from '../types.js';
/**
 * Build the header section with core orchestrator identity
 */
export declare function buildHeader(): string;
/**
 * Build the agent registry section with descriptions
 */
export declare function buildAgentRegistry(agents: AgentConfig[]): string;
/**
 * Build the trigger table showing when to use each agent
 */
export declare function buildTriggerTable(agents: AgentConfig[]): string;
/**
 * Build tool selection guidance section
 */
export declare function buildToolSelectionSection(agents: AgentConfig[]): string;
/**
 * Build delegation matrix/guide table
 */
export declare function buildDelegationMatrix(agents: AgentConfig[]): string;
/**
 * Build orchestration principles section
 */
export declare function buildOrchestrationPrinciples(): string;
/**
 * Build workflow section
 */
export declare function buildWorkflow(): string;
/**
 * Build critical rules section
 */
export declare function buildCriticalRules(): string;
/**
 * Build completion checklist section
 */
export declare function buildCompletionChecklist(): string;
//# sourceMappingURL=index.d.ts.map