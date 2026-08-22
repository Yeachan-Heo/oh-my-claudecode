/**
 * Deterministic normalization and SHA-256 digests for prompt SSOT (issue #3704).
 */
import { createHash } from 'node:crypto';
/**
 * Canonical normalization applied before any digest or comparison:
 * CRLF/CR -> LF, strip trailing spaces/tabs per line, collapse 3+ newlines
 * to exactly one blank line, trim leading/trailing blank lines, end with a
 * single trailing newline.
 */
export function normalizePromptText(text) {
    return (text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '') + '\n');
}
export function sha256Hex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Digest of one section, binding id + version + normalized body. */
export function digestSection(id, version, body) {
    return sha256Hex(normalizePromptText(`${id}@${version}\n${body}`));
}
/** Digest of a whole projection body (already normalized by the composer). */
export function digestProjection(body) {
    return sha256Hex(normalizePromptText(body));
}
//# sourceMappingURL=digest.js.map