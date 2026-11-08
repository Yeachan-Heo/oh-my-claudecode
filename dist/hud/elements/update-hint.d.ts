/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
export interface UpdateHintInput {
    /** Latest OMC version when an update is available, else null */
    omcUpdateAvailable: string | null;
    /** Update channel the OMC update belongs to; 'marketplace' means a plugin install */
    omcUpdateSource: 'npm' | 'marketplace' | null;
    /** Latest Claude Code version when an update is available, else null */
    claudeCodeUpdateAvailable: string | null;
}
/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: marketplace installs cannot be updated through npm.
 */
export declare function renderUpdateHints(input: UpdateHintInput): string[];
//# sourceMappingURL=update-hint.d.ts.map