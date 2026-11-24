import { createHash } from 'crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
export const DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES = 2048;
const DEFAULT_HANDOFF_SUMMARY_MAX_CHARS = 160;
export function summarizeArtifactBody(body, maxChars = DEFAULT_HANDOFF_SUMMARY_MAX_CHARS) {
    const normalized = body.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
export function createArtifactDescriptorFromPath(path, options) {
    const content = readFileSync(path);
    const stats = statSync(path);
    return {
        kind: options.kind,
        path,
        contentHash: createHash('sha256').update(content).digest('hex'),
        createdAt: options.createdAt ?? new Date(stats.mtimeMs).toISOString(),
        producer: options.producer,
        sizeBytes: stats.size,
        retention: options.retention,
        expiresAt: options.expiresAt,
    };
}
export function writeTextArtifact(options) {
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, options.content, { encoding: 'utf-8', mode: 0o600 });
    return createArtifactDescriptorFromPath(options.path, options);
}
export function createArtifactHandoff(options) {
    const thresholdBytes = options.thresholdBytes ?? DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES;
    const sizeBytes = Buffer.byteLength(options.body, 'utf-8');
    const summary = options.summary ?? summarizeArtifactBody(options.body);
    if (sizeBytes <= thresholdBytes) {
        return {
            mode: 'inline',
            body: options.body,
            summary,
            sizeBytes,
            thresholdBytes,
        };
    }
    return {
        mode: 'descriptor',
        summary,
        descriptor: options.descriptorFactory(),
        sizeBytes,
        thresholdBytes,
    };
}
//# sourceMappingURL=artifact-descriptor.js.map