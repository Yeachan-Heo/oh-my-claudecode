/**
 * Rules Storage
 *
 * Persistent storage for tracking injected rules per session.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import { SessionJsonStore } from '../../lib/session-json-store.js';
import { RULES_INJECTOR_STORAGE } from './constants.js';
const store = new SessionJsonStore({ storageDir: RULES_INJECTOR_STORAGE });
/**
 * Load injected rules for a session.
 */
export function loadInjectedRules(sessionId) {
    const data = store.load(sessionId);
    if (!data) {
        return { contentHashes: new Set(), realPaths: new Set() };
    }
    return {
        contentHashes: new Set(data.injectedHashes),
        realPaths: new Set(data.injectedRealPaths ?? []),
    };
}
/**
 * Save injected rules for a session.
 */
export function saveInjectedRules(sessionId, data) {
    const storageData = {
        sessionId,
        injectedHashes: [...data.contentHashes],
        injectedRealPaths: [...data.realPaths],
        updatedAt: Date.now(),
    };
    store.save(sessionId, storageData);
}
/**
 * Clear injected rules for a session.
 */
export function clearInjectedRules(sessionId) {
    store.clear(sessionId);
}
//# sourceMappingURL=storage.js.map