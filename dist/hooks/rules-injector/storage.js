/**
 * Rules Storage
 *
 * Persistent storage for tracking injected rules per session.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, } from 'fs';
import { join } from 'path';
import { RULES_INJECTOR_STORAGE } from './constants.js';
/**
 * Get storage path for a session.
 */
function getStoragePath(sessionId) {
    return join(RULES_INJECTOR_STORAGE, `${sessionId}.json`);
}
/**
 * Load injected rules for a session.
 */
export function loadInjectedRules(sessionId) {
    const filePath = getStoragePath(sessionId);
    if (!existsSync(filePath)) {
        return { contentHashes: new Set(), realPaths: new Set() };
    }
    try {
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        return {
            contentHashes: new Set(data.injectedHashes),
            realPaths: new Set(data.injectedRealPaths ?? []),
        };
    }
    catch {
        return { contentHashes: new Set(), realPaths: new Set() };
    }
}
/**
 * Save injected rules for a session.
 */
export function saveInjectedRules(sessionId, data) {
    if (!existsSync(RULES_INJECTOR_STORAGE)) {
        mkdirSync(RULES_INJECTOR_STORAGE, { recursive: true });
    }
    const storageData = {
        sessionId,
        injectedHashes: [...data.contentHashes],
        injectedRealPaths: [...data.realPaths],
        updatedAt: Date.now(),
    };
    writeFileSync(getStoragePath(sessionId), JSON.stringify(storageData, null, 2));
}
/**
 * Clear injected rules for a session.
 */
export function clearInjectedRules(sessionId) {
    const filePath = getStoragePath(sessionId);
    if (existsSync(filePath)) {
        unlinkSync(filePath);
    }
}
//# sourceMappingURL=storage.js.map