/**
 * Minimal prompt SSOT composer for #3705.
 * Intended seam for #3704 structured sections.
 *
 * Today: canonical source is docs/CLAUDE.md between OMC markers.
 * Composer renders root/.github CLAUDE projections deterministically
 * and exposes digests for parity checks and file writers.
 *
 * Design notes (per plan 6.2):
 * - Each projection includes schemaVersion, sourceRevision, version marker.
 * - Section deltas (provider/model/role) are future work under #3704.
 * - This module provides the deterministic narrow adapter until that lands.
 */
export declare const COMPOSER_SCHEMA_VERSION: 1;
export interface ComposerInput {
    /** Canonical docs/CLAUDE.md raw content (with markers + version). */
    canonicalDocsRaw: string;
    /** Package version to stamp in projection header. */
    version: string;
}
export interface ComposedClaudeProjection {
    path: 'CLAUDE.md' | '.github/CLAUDE.md';
    content: string;
    /** Digest of normalized projection body (including markers+version line). */
    digest: string;
}
/**
 * Render a CLAUDE.md projection with the same block structure the
 * claude-md transaction expects: START, VERSION line, body, END.
 */
export declare function composeManagedBlock(input: ComposerInput): string;
/**
 * Normalized sourceRevision for handshake/manifest:
 * digest of the canonical body WITHOUT version marker, LF-normalized.
 */
export declare function canonicalSourceRevision(canonicalDocsRaw: string): string;
export declare function composeAllClaudeProjections(input: ComposerInput): ComposedClaudeProjection[];
//# sourceMappingURL=composer.d.ts.map