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
import { loadAgentUsageState, saveAgentUsageState, clearAgentUsageState, } from './storage.js';
import { TARGET_TOOLS, AGENT_TOOLS, REMINDER_MESSAGE } from './constants.js';
// Re-export types and utilities
export { loadAgentUsageState, saveAgentUsageState, clearAgentUsageState } from './storage.js';
export { TARGET_TOOLS, AGENT_TOOLS, REMINDER_MESSAGE } from './constants.js';
export function createAgentUsageReminderHook() {
    const sessionStates = new Map();
    function getOrCreateState(sessionID) {
        if (!sessionStates.has(sessionID)) {
            const persisted = loadAgentUsageState(sessionID);
            const state = persisted ?? {
                sessionID,
                agentUsed: false,
                reminderCount: 0,
                updatedAt: Date.now(),
            };
            sessionStates.set(sessionID, state);
        }
        return sessionStates.get(sessionID);
    }
    function markAgentUsed(sessionID) {
        const state = getOrCreateState(sessionID);
        state.agentUsed = true;
        state.updatedAt = Date.now();
        saveAgentUsageState(state);
    }
    function resetState(sessionID) {
        sessionStates.delete(sessionID);
        clearAgentUsageState(sessionID);
    }
    const toolExecuteAfter = async (input, output) => {
        const { tool, sessionID } = input;
        const toolLower = tool.toLowerCase();
        // Mark agent as used if agent tool was called
        if (AGENT_TOOLS.has(toolLower)) {
            markAgentUsed(sessionID);
            return;
        }
        // Only track target tools (search/fetch tools)
        if (!TARGET_TOOLS.has(toolLower)) {
            return;
        }
        const state = getOrCreateState(sessionID);
        // Don't remind if agent has been used
        if (state.agentUsed) {
            return;
        }
        // Append reminder message to output
        output.output += REMINDER_MESSAGE;
        state.reminderCount++;
        state.updatedAt = Date.now();
        saveAgentUsageState(state);
    };
    const eventHandler = async ({ event }) => {
        const props = event.properties;
        // Clean up state when session is deleted
        if (event.type === 'session.deleted') {
            const sessionInfo = props?.info;
            if (sessionInfo?.id) {
                resetState(sessionInfo.id);
            }
        }
        // Clean up state when session is compacted
        if (event.type === 'session.compacted') {
            const sessionID = (props?.sessionID ??
                props?.info?.id);
            if (sessionID) {
                resetState(sessionID);
            }
        }
    };
    return {
        'tool.execute.after': toolExecuteAfter,
        event: eventHandler,
    };
}
//# sourceMappingURL=index.js.map