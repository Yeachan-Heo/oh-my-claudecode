/**
 * Returns the absolute path to the leader inbox file. Pure function.
 * Uses sanitizeName to normalise teamName (prevents traversal characters).
 */
export declare function leaderInboxPath(teamName: string, cwd: string): string;
/**
 * Ensures the leader inbox directory and seed file exist.
 * Creates .omc/state/team/{team}/leader/ and seeds inbox.md with a header banner.
 * Returns the absolute path to inbox.md.
 * Idempotent: safe to call multiple times.
 * Validates path is within cwd to prevent traversal.
 */
export declare function ensureLeaderInbox(teamName: string, cwd: string): Promise<string>;
/**
 * Append a message to the leader inbox.
 * Mirrors appendToInbox for workers: appends `\n\n---\n${message}` to the inbox file.
 * Validates path is within cwd to prevent traversal.
 */
export declare function appendToLeaderInbox(teamName: string, message: string, cwd: string): Promise<void>;
/**
 * Returns a one-line directive to append to the leader pane's spawn prompt,
 * telling the leader where to find runtime notifications.
 * Pure function. Returns a workspace-relative path (no `cwd` parameter — the
 * directive is consumed by the leader process which interprets the path
 * relative to its own working directory).
 */
export declare function extendLeaderBootstrapPrompt(teamName: string): string;
//# sourceMappingURL=leader-inbox.d.ts.map