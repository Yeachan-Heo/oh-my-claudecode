/**
 * Deterministic normalization and SHA-256 digests for prompt SSOT (issue #3704).
 */
/**
 * Canonical normalization applied before any digest or comparison:
 * CRLF/CR -> LF, strip trailing spaces/tabs per line, collapse 3+ newlines
 * to exactly one blank line, trim leading/trailing blank lines, end with a
 * single trailing newline.
 */
export declare function normalizePromptText(text: string): string;
export declare function sha256Hex(text: string): string;
/** Digest of one section, binding id + version + normalized body. */
export declare function digestSection(id: string, version: number, body: string): string;
/** Digest of a whole projection body (already normalized by the composer). */
export declare function digestProjection(body: string): string;
//# sourceMappingURL=digest.d.ts.map