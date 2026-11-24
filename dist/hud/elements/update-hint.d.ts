/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
export interface OmcUpdateState {
    /** Version to advertise as an update, else null */
    updateAvailable: string | null;
    /** Newer installed version the HUD wrapper skipped because it has no built HUD, else null */
    unbuiltVersion: string | null;
}
/**
 * Decide what the HUD says about newer OMC versions.
 *
 * The HUD wrapper keeps rendering the previous built version while a newer
 * cached version has no dist/hud/index.js, and reports that version through
 * OMC_HUD_UNBUILT_VERSION. That version is already installed, so the update
 * command cannot deliver it: it is reported as unbuilt rather than as an
 * update. A latest version above the unbuilt one is still a real update.
 */
export declare function resolveOmcUpdateState(omcVersion: string | null, latestVersion: unknown, unbuiltVersionEnv: string | undefined): OmcUpdateState;
export interface UpdateHintInput {
    /** Latest OMC version when an update is available, else null */
    omcUpdateAvailable: string | null;
    /** Update channel the OMC update belongs to; 'marketplace' means a plugin install */
    omcUpdateSource: 'npm' | 'marketplace' | null;
    /** Latest Claude Code version when an update is available, else null */
    claudeCodeUpdateAvailable: string | null;
    /** Newer installed OMC version that has no built HUD, else null */
    omcUnbuiltVersion?: string | null;
    /** OMC version this HUD is running */
    omcVersion?: string | null;
}
/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: marketplace installs cannot be updated through npm.
 */
export declare function renderUpdateHints(input: UpdateHintInput): string[];
//# sourceMappingURL=update-hint.d.ts.map