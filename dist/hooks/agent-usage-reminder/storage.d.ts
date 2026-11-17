/**
 * Agent Usage Reminder Storage
 *
 * Persists agent usage state across sessions.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */
import type { AgentUsageState } from './types.js';
export declare function loadAgentUsageState(sessionID: string): AgentUsageState | null;
export declare function saveAgentUsageState(state: AgentUsageState): void;
export declare function clearAgentUsageState(sessionID: string): void;
//# sourceMappingURL=storage.d.ts.map