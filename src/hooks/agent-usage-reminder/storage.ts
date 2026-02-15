/**
 * Agent Usage Reminder Storage
 *
 * Persists agent usage state across sessions.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */

import { SessionJsonStore } from '../../lib/session-json-store.js';
import { AGENT_USAGE_REMINDER_STORAGE } from './constants.js';
import type { AgentUsageState } from './types.js';

const store = new SessionJsonStore<AgentUsageState>({ storageDir: AGENT_USAGE_REMINDER_STORAGE });

export function loadAgentUsageState(sessionID: string): AgentUsageState | null {
  return store.load(sessionID);
}

export function saveAgentUsageState(state: AgentUsageState): void {
  store.save(state.sessionID, state);
}

export function clearAgentUsageState(sessionID: string): void {
  store.clear(sessionID);
}
