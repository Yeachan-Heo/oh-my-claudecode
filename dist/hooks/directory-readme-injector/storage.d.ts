/**
 * Directory README Injector Storage
 *
 * Persistent storage for tracking which directory READMEs have been injected per session.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */
/**
 * Load set of injected directory paths for a session.
 */
export declare function loadInjectedPaths(sessionID: string): Set<string>;
/**
 * Save set of injected directory paths for a session.
 */
export declare function saveInjectedPaths(sessionID: string, paths: Set<string>): void;
/**
 * Clear injected paths for a session.
 */
export declare function clearInjectedPaths(sessionID: string): void;
//# sourceMappingURL=storage.d.ts.map