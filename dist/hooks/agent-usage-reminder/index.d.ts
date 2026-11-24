/**
 * Agent Usage Reminder Hook
 *
 * Reminds users to use specialized agents when they make direct tool calls
 * for searching or fetching content instead of delegating to agents.
 *
 * This hook tracks tool usage and appends reminder messages to tool outputs
 * when users haven't been using agents effectively.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 * Adapted for Claude Code's shell-based hook system.
 */
export { loadAgentUsageState, saveAgentUsageState, clearAgentUsageState } from './storage.js';
export { TARGET_TOOLS, AGENT_TOOLS, REMINDER_MESSAGE } from './constants.js';
export type { AgentUsageState } from './types.js';
interface ToolExecuteInput {
    tool: string;
    sessionID: string;
    callID: string;
}
interface ToolExecuteOutput {
    title: string;
    output: string;
    metadata: unknown;
}
interface EventInput {
    event: {
        type: string;
        properties?: unknown;
    };
}
export declare function createAgentUsageReminderHook(): {
    'tool.execute.after': (input: ToolExecuteInput, output: ToolExecuteOutput) => Promise<void>;
    event: ({ event }: EventInput) => Promise<void>;
};
//# sourceMappingURL=index.d.ts.map