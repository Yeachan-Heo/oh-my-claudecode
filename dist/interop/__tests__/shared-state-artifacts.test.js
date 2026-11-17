import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { addSharedMessage, addSharedTask, cleanupInterop, initInteropSession, updateSharedTask, } from '../shared-state.js';
describe('shared-state artifact handoff', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'shared-state-artifacts-'));
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        initInteropSession('session-1', tempDir);
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('stores large task descriptions and results as artifacts', () => {
        const largeDescription = 'describe ' + 'x'.repeat(5000);
        const task = addSharedTask(tempDir, {
            source: 'omc',
            target: 'omx',
            type: 'implement',
            description: largeDescription,
        });
        expect(task.descriptionArtifact?.kind).toBe('task-description');
        expect(task.description.length).toBeLessThan(largeDescription.length);
        expect(task.descriptionArtifact?.path).toBeTruthy();
        expect(readFileSync(task.descriptionArtifact.path, 'utf-8')).toBe(largeDescription);
        const updated = updateSharedTask(tempDir, task.id, {
            status: 'completed',
            result: 'result ' + 'y'.repeat(5000),
        });
        expect(updated?.resultArtifact?.kind).toBe('task-result');
        expect(updated?.completedAt).toBeTruthy();
        expect(readFileSync(updated.resultArtifact.path, 'utf-8')).toBe('result ' + 'y'.repeat(5000));
    });
    it('keeps small messages inline and cleans up large artifacts', () => {
        const smallMessage = addSharedMessage(tempDir, {
            source: 'omc',
            target: 'omx',
            content: 'short note',
        });
        expect(smallMessage.contentArtifact).toBeUndefined();
        expect(smallMessage.content).toBe('short note');
        const largeMessage = addSharedMessage(tempDir, {
            source: 'omc',
            target: 'omx',
            content: 'message ' + 'z'.repeat(5000),
        });
        const artifactPath = largeMessage.contentArtifact?.path;
        expect(artifactPath).toBeTruthy();
        expect(existsSync(artifactPath)).toBe(true);
        const cleanup = cleanupInterop(tempDir);
        expect(cleanup.messagesDeleted).toBe(2);
        expect(existsSync(artifactPath)).toBe(false);
    });
});
//# sourceMappingURL=shared-state-artifacts.test.js.map