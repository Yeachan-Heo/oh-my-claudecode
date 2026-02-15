/**
 * Directory README Injector Storage
 *
 * Persistent storage for tracking which directory READMEs have been injected per session.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */
import { SessionJsonStore } from '../../lib/session-json-store.js';
import { README_INJECTOR_STORAGE } from './constants.js';
const store = new SessionJsonStore({ storageDir: README_INJECTOR_STORAGE });
/**
 * Load set of injected directory paths for a session.
 */
export function loadInjectedPaths(sessionID) {
    const data = store.load(sessionID);
    if (!data)
        return new Set();
    return new Set(data.injectedPaths);
}
/**
 * Save set of injected directory paths for a session.
 */
export function saveInjectedPaths(sessionID, paths) {
    const data = {
        sessionID,
        injectedPaths: Array.from(paths),
        updatedAt: Date.now(),
    };
    store.save(sessionID, data);
}
/**
 * Clear injected paths for a session.
 */
export function clearInjectedPaths(sessionID) {
    store.clear(sessionID);
}
//# sourceMappingURL=storage.js.map