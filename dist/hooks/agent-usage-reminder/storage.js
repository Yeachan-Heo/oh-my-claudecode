/**
 * Agent Usage Reminder Storage
 *
 * Persists agent usage state across sessions.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */
import { SessionJsonStore } from '../../lib/session-json-store.js';
import { AGENT_USAGE_REMINDER_STORAGE } from './constants.js';
const store = new SessionJsonStore({ storageDir: AGENT_USAGE_REMINDER_STORAGE });
export function loadAgentUsageState(sessionID) {
    return store.load(sessionID);
}
export function saveAgentUsageState(state) {
    store.save(state.sessionID, state);
}
export function clearAgentUsageState(sessionID) {
    store.clear(sessionID);
}
//# sourceMappingURL=storage.js.map