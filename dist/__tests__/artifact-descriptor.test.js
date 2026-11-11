import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createArtifactHandoff, DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES, writeTextArtifact, } from '../shared/artifact-descriptor.js';
describe('artifact descriptor helpers', () => {
    it('writes descriptors with stable metadata', () => {
        const dir = mkdtempSync(join(tmpdir(), 'artifact-descriptor-'));
        try {
            const descriptor = writeTextArtifact({
                path: join(dir, 'artifact.md'),
                content: 'hello artifact world',
                kind: 'prompt',
                producer: { system: 'omc', component: 'test' },
                retention: 'persistent',
            });
            expect(descriptor.kind).toBe('prompt');
            expect(descriptor.path).toContain('artifact.md');
            expect(descriptor.contentHash).toMatch(/^[a-f0-9]{64}$/);
            expect(descriptor.sizeBytes).toBeGreaterThan(0);
            expect(readFileSync(descriptor.path, 'utf-8')).toBe('hello artifact world');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('keeps small payloads inline without creating descriptors', () => {
        const descriptorFactory = vi.fn(() => {
            throw new Error('should not be called');
        });
        const handoff = createArtifactHandoff({
            body: 'small payload',
            thresholdBytes: DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES,
            descriptorFactory,
        });
        expect(handoff.mode).toBe('inline');
        expect(descriptorFactory).not.toHaveBeenCalled();
        if (handoff.mode === 'inline') {
            expect(handoff.body).toBe('small payload');
        }
    });
    it('switches large payloads to descriptor mode', () => {
        const descriptorFactory = vi.fn(() => ({
            kind: 'task-result',
            path: '/tmp/result.md',
            createdAt: new Date().toISOString(),
            producer: { system: 'omc', component: 'test' },
            retention: 'until-completion',
            sizeBytes: 4096,
            contentHash: 'abc123',
        }));
        const handoff = createArtifactHandoff({
            body: 'x'.repeat(DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES + 32),
            thresholdBytes: DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES,
            descriptorFactory,
        });
        expect(handoff.mode).toBe('descriptor');
        expect(descriptorFactory).toHaveBeenCalledTimes(1);
        if (handoff.mode === 'descriptor') {
            expect(handoff.descriptor.path).toBe('/tmp/result.md');
            expect(handoff.summary.length).toBeLessThan(handoff.sizeBytes);
        }
    });
});
//# sourceMappingURL=artifact-descriptor.test.js.map