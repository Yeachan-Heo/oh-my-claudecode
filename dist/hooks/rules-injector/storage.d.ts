/**
 * Rules Storage
 *
 * Persistent storage for tracking injected rules per session.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
/**
 * Load injected rules for a session.
 */
export declare function loadInjectedRules(sessionId: string): {
    contentHashes: Set<string>;
    realPaths: Set<string>;
};
/**
 * Save injected rules for a session.
 */
export declare function saveInjectedRules(sessionId: string, data: {
    contentHashes: Set<string>;
    realPaths: Set<string>;
}): void;
/**
 * Clear injected rules for a session.
 */
export declare function clearInjectedRules(sessionId: string): void;
//# sourceMappingURL=storage.d.ts.map