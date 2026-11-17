import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getStatusFilePath, persistPrompt, persistResponse, writeJobStatus, } from '../prompt-persistence.js';
describe('prompt persistence artifact descriptors', () => {
    it('returns a descriptor for persisted prompts and embeds descriptors in job status', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'prompt-persistence-artifacts-'));
        try {
            const prompt = persistPrompt({
                provider: 'codex',
                agentRole: 'executor',
                model: 'gpt-5.4',
                prompt: 'ship it',
                fullPrompt: 'full prompt body',
                workingDirectory: tempDir,
            });
            expect(prompt).toBeDefined();
            expect(prompt?.artifact.kind).toBe('prompt');
            expect(prompt?.artifact.path).toBe(prompt?.filePath);
            expect(prompt?.artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
            const responsePath = persistResponse({
                provider: 'codex',
                agentRole: 'executor',
                model: 'gpt-5.4',
                promptId: prompt.id,
                slug: prompt.slug,
                response: 'done',
                workingDirectory: tempDir,
            });
            writeJobStatus({
                provider: 'codex',
                jobId: prompt.id,
                slug: prompt.slug,
                status: 'completed',
                promptFile: prompt.filePath,
                responseFile: responsePath,
                model: 'gpt-5.4',
                agentRole: 'executor',
                spawnedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
            }, tempDir);
            const statusPath = getStatusFilePath('codex', prompt.slug, prompt.id, tempDir);
            const status = JSON.parse(readFileSync(statusPath, 'utf-8'));
            expect(status.promptArtifact?.kind).toBe('prompt');
            expect(status.promptArtifact?.path).toBe(prompt.filePath);
            expect(status.responseArtifact?.kind).toBe('response');
            expect(status.responseArtifact?.path).toBe(responsePath);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=prompt-persistence-artifacts.test.js.map