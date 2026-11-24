import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { acquireFileLockSync, lockPathFor, releaseFileLock } from '../../lib/file-lock.js';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import { getMemoryPath, loadProjectMemory, saveProjectMemory } from '../../hooks/project-memory/storage.js';
import { projectMemoryAddDirectiveTool, projectMemoryWriteTool } from '../memory-tools.js';
// Match the existing memory-tools test seam: temporary fixture roots are
// outside the live checkout's trusted worktree.
vi.mock('../../lib/worktree-paths.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        validateWorkingDirectory: (workingDirectory) => workingDirectory || process.cwd(),
    };
});
const lockObserver = vi.hoisted(() => ({ onOpen: undefined }));
// Observe lock attempts without changing the real exclusive-create operation.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        openSync: (...args) => {
            lockObserver.onOpen?.(args[0]);
            return actual.openSync(...args);
        },
    };
});
describe.each(['local', 'centralized'])('project-memory MCP writer coordination (%s)', (storageMode) => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tool-lock-'));
        vi.stubEnv('HOME', tempDir);
        vi.stubEnv('USERPROFILE', tempDir);
        vi.stubEnv('OMC_STATE_DIR', storageMode === 'centralized' ? path.join(tempDir, 'state') : '');
        vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(tempDir, '.claude'));
        clearWorktreeCache();
        // Keep both local and centralized state inside this case's isolated home.
    });
    afterEach(async () => {
        lockObserver.onOpen = undefined;
        clearWorktreeCache();
        vi.unstubAllEnvs();
        await fs.rm(tempDir, { recursive: true, force: true });
    });
    async function seedMemory() {
        const result = await projectMemoryWriteTool.handler({
            memory: { retained: 'existing value' },
            workingDirectory: tempDir,
        });
        expect(result.content[0].text).toContain('Successfully wrote');
    }
    it.each(['merge', 'directive'])('%s waits for a locked writer and keeps both updates', async (operation) => {
        await seedMemory();
        const lockPath = lockPathFor(getMemoryPath(tempDir));
        const handle = acquireFileLockSync(lockPath);
        expect(handle).not.toBeNull();
        if (!handle)
            throw new Error('Failed to acquire test writer lock');
        const snapshot = await loadProjectMemory(tempDir);
        expect(snapshot).not.toBeNull();
        let observedAttempt;
        const attempted = new Promise((resolve) => {
            observedAttempt = () => resolve('lock');
        });
        lockObserver.onOpen = (file) => {
            if (file === lockPath)
                observedAttempt();
        };
        const request = operation === 'merge'
            ? projectMemoryWriteTool.handler({ memory: { merged: 'MCP value' }, merge: true, workingDirectory: tempDir })
            : projectMemoryAddDirectiveTool.handler({ directive: 'Keep both writers', workingDirectory: tempDir });
        let first;
        try {
            // No timing assumption: either the real lock is attempted, or the
            // uncoordinated handler finishes while the writer still owns the lock.
            first = await Promise.race([attempted, request.then(() => 'completed')]);
            await saveProjectMemory(tempDir, {
                ...snapshot,
                customNotes: [{ timestamp: Date.now(), source: 'manual', category: 'test', content: 'held writer note' }],
            });
        }
        finally {
            lockObserver.onOpen = undefined;
            releaseFileLock(handle);
        }
        const result = await request;
        const saved = await loadProjectMemory(tempDir);
        expect(result.content[0].text).toContain('Successfully');
        expect(saved?.customNotes).toEqual([expect.objectContaining({ content: 'held writer note' })]);
        if (operation === 'merge') {
            expect(saved).toMatchObject({ retained: 'existing value', merged: 'MCP value' });
        }
        else {
            expect(saved?.userDirectives).toEqual([expect.objectContaining({ directive: 'Keep both writers' })]);
        }
        expect(first).toBe('lock');
    });
    it('replacement waits for the lock but still replaces the prior memory', async () => {
        await seedMemory();
        const lockPath = lockPathFor(getMemoryPath(tempDir));
        const handle = acquireFileLockSync(lockPath);
        expect(handle).not.toBeNull();
        if (!handle)
            throw new Error('Failed to acquire test writer lock');
        let observedAttempt;
        const attempted = new Promise((resolve) => {
            observedAttempt = () => resolve('lock');
        });
        lockObserver.onOpen = (file) => {
            if (file === lockPath)
                observedAttempt();
        };
        const request = projectMemoryWriteTool.handler({ memory: { replacement: true }, workingDirectory: tempDir });
        let first;
        let whileLocked;
        try {
            first = await Promise.race([attempted, request.then(() => 'completed')]);
            whileLocked = await loadProjectMemory(tempDir);
        }
        finally {
            lockObserver.onOpen = undefined;
            releaseFileLock(handle);
        }
        expect((await request).content[0].text).toContain('Successfully wrote');
        expect(whileLocked).toMatchObject({ retained: 'existing value' });
        const saved = await loadProjectMemory(tempDir);
        expect(saved).toMatchObject({ replacement: true, version: '1.0.0', projectRoot: tempDir });
        expect(saved).not.toHaveProperty('retained');
        expect(first).toBe('lock');
    });
    it.each([false, true])('creates missing memory with merge=%s and keeps default fields', async (merge) => {
        const result = await projectMemoryWriteTool.handler({ memory: { value: 'new' }, merge, workingDirectory: tempDir });
        expect(result.content[0].text).toContain('Successfully');
        expect(await loadProjectMemory(tempDir)).toMatchObject({ value: 'new', version: '1.0.0', projectRoot: tempDir });
    });
    it.each(['merge', 'replace', 'directive'])('%s reports lock acquisition errors without changing memory', async (operation) => {
        await seedMemory();
        const memoryPath = getMemoryPath(tempDir);
        const before = await fs.readFile(memoryPath, 'utf8');
        lockObserver.onOpen = (file) => {
            if (file === lockPathFor(memoryPath))
                throw new Error('test lock acquisition denied');
        };
        try {
            const result = operation === 'directive'
                ? await projectMemoryAddDirectiveTool.handler({ directive: 'Must not land', workingDirectory: tempDir })
                : await projectMemoryWriteTool.handler({ memory: { mustNotLand: true }, merge: operation === 'merge', workingDirectory: tempDir });
            expect(result.content[0].text).toBe(`Error ${operation === 'directive' ? 'adding directive' : 'writing project memory'}: test lock acquisition denied`);
            expect(await fs.readFile(memoryPath, 'utf8')).toBe(before);
        }
        finally {
            lockObserver.onOpen = undefined;
        }
    });
    it('still reports missing memory for directives and does not create it', async () => {
        const result = await projectMemoryAddDirectiveTool.handler({ directive: 'No implicit creation', workingDirectory: tempDir });
        expect(result.content[0].text).toBe('Project memory does not exist. Run a session first to auto-detect project environment.');
        expect(await loadProjectMemory(tempDir)).toBeNull();
    });
});
//# sourceMappingURL=memory-tools-concurrency.test.js.map