/**
 * Agent Usage Reminder Storage
 *
 * Persists agent usage state across sessions.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, } from 'fs';
import { join } from 'path';
import { AGENT_USAGE_REMINDER_STORAGE } from './constants.js';
function getStoragePath(sessionID) {
    return join(AGENT_USAGE_REMINDER_STORAGE, `${sessionID}.json`);
}
export function loadAgentUsageState(sessionID) {
    const filePath = getStoragePath(sessionID);
    if (!existsSync(filePath))
        return null;
    try {
        const content = readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
export function saveAgentUsageState(state) {
    if (!existsSync(AGENT_USAGE_REMINDER_STORAGE)) {
        mkdirSync(AGENT_USAGE_REMINDER_STORAGE, { recursive: true });
    }
    const filePath = getStoragePath(state.sessionID);
    writeFileSync(filePath, JSON.stringify(state, null, 2));
}
export function clearAgentUsageState(sessionID) {
    const filePath = getStoragePath(sessionID);
    if (existsSync(filePath)) {
        unlinkSync(filePath);
    }
}
//# sourceMappingURL=storage.js.map