/**
 * Prompt projection manifest for #3705.
 * Records deterministic digests for CLAUDE / agent / command / skill
 * projections so builds, installs, and handshakes can be verified.
 *
 * Depends on #3704 composer contract. When #3704's structured sections
 * land, this manifest should consume its normalized section digests
 * instead of raw file hashes. Until then, raw normalized file digests
 * provide parity and migration evidence without blocking.
 */
export declare const PROMPT_MANIFEST_SCHEMA_VERSION: 1;
export type PromptProjectionKind = 'claude' | 'agent' | 'command' | 'skill';
export interface PromptProjectionRecord {
    kind: PromptProjectionKind;
    /** Repo-relative POSIX path of canonical source. */
    sourcePath: string;
    /** Repo-relative POSIX path of generated projection (empty when source==output). */
    outputPath: string;
    /** SHA-256 of normalized canonical bytes (LF, no BOM, stable trim). */
    digest: string;
    byteLength: number;
    /** Optional git blob sha for historical parity. */
    gitBlob?: string;
}
export interface PromptProjectionManifest {
    schemaVersion: typeof PROMPT_MANIFEST_SCHEMA_VERSION;
    engineVersion: string;
    /** SHA-256 of normalized canonical CLAUDE body (without version marker). */
    sourceRevision: string;
    generatedAt: string;
    projections: PromptProjectionRecord[];
}
/**
 * Normalize prompt bytes for stable digesting:
 * - LF line endings, strip trailing spaces per line is NOT done (literal),
 *   only normalize CRLF -> LF and ensure single trailing newline.
 * - Preserve BOM handling at decode layer; this normalizer works on string.
 */
export declare function normalizeForDigest(content: string): string;
export declare function computeDigest(content: string): string;
export declare function computeRawDigest(bytes: Buffer): string;
export declare function createManifest(engineVersion: string, sourceRevision: string, projections: PromptProjectionRecord[]): PromptProjectionManifest;
export declare function validateManifest(value: unknown): string[];
//# sourceMappingURL=manifest.d.ts.map