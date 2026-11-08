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

import {
  loadAgentUsageState,
  saveAgentUsageState,
  clearAgentUsageState,
} from './storage.js';
import { TARGET_TOOLS, AGENT_TOOLS, REMINDER_MESSAGE } from './constants.js';
import type { AgentUsageState } from './types.js';

// Re-export types and utilities
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

export function createAgentUsageReminderHook() {
  const sessionStates = new Map<string, AgentUsageState>();

  function getOrCreateState(sessionID: string): AgentUsageState {
    if (!sessionStates.has(sessionID)) {
      const persisted = loadAgentUsageState(sessionID);
      const state: AgentUsageState = persisted ?? {
        sessionID,
        agentUsed: false,
        reminderCount: 0,
        updatedAt: Date.now(),
      };
      sessionStates.set(sessionID, state);
    }
    return sessionStates.get(sessionID)!;
  }

  function markAgentUsed(sessionID: string): void {
    const state = getOrCreateState(sessionID);
    state.agentUsed = true;
    state.updatedAt = Date.now();
    saveAgentUsageState(state);
  }

  function resetState(sessionID: string): void {
    sessionStates.delete(sessionID);
    clearAgentUsageState(sessionID);
  }

  const toolExecuteAfter = async (
    input: ToolExecuteInput,
    output: ToolExecuteOutput,
  ) => {
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

  const eventHandler = async ({ event }: EventInput) => {
    const props = event.properties as Record<string, unknown> | undefined;

    // Clean up state when session is deleted
    if (event.type === 'session.deleted') {
      const sessionInfo = props?.info as { id?: string } | undefined;
      if (sessionInfo?.id) {
        resetState(sessionInfo.id);
      }
    }

    // Clean up state when session is compacted
    if (event.type === 'session.compacted') {
      const sessionID = (props?.sessionID ??
        (props?.info as { id?: string } | undefined)?.id) as string | undefined;
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
