/**
 * OMC HUD - Multi-Repo Element
 *
 * Renders a multi-repo workspace indicator when the cwd is a parent
 * directory holding multiple sibling git repos (e.g. `bidchex-repos/`
 * containing `bidchex-backend/`, `bidchex-frontend/`, …).
 *
 * Two modes:
 *  - Marker present (`.omc-workspace` at cwd): show
 *      mr:<parent> | repos:N | sessions:M
 *  - Marker missing: show a one-line suggestion to create it.
 *
 * When the cwd IS itself a git repo (single-repo case) this element
 * returns null and the normal repo/branch/status elements take over.
 */
export interface MultiRepoInfo {
    isMultiRepo: boolean;
    hasMarker: boolean;
    parentName: string;
    subrepoCount: number;
    activeSessions: number;
}
/** For tests. */
export declare function resetMultiRepoCache(): void;
/**
 * Detect multi-repo workspace state for the given cwd.
 *
 * Returns null when:
 *  - cwd is itself a git repo (single-repo case — let the normal git
 *    elements handle it)
 *  - cwd has fewer than 2 git-repo children (not actually multi-repo)
 *
 * Returns a populated MultiRepoInfo otherwise.
 */
export declare function detectMultiRepo(cwd?: string): MultiRepoInfo | null;
/**
 * Render the multi-repo chip. Returns null when not in a multi-repo
 * parent (the caller should fall through to renderGitRepo/Branch/Status).
 *
 * Examples:
 *   mr:bidchex-repos repos:11 sessions:2
 *   multi-repo detected — create .omc-workspace to enable shared state
 */
export declare function renderMultiRepo(cwd?: string): string | null;
//# sourceMappingURL=multi-repo.d.ts.map