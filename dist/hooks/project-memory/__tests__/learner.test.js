/**
 * Tests for Project Memory Learner
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { learnFromToolOutput, addCustomNote } from '../learner.js';
import { saveProjectMemory, loadProjectMemory, getMemoryPath } from '../storage.js';
import { SCHEMA_VERSION } from '../constants.js';
// Helper to create base memory with all required fields
const createBaseMemory = (projectRoot) => ({
    version: SCHEMA_VERSION,
    lastScanned: Date.now(),
    projectRoot,
    techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
    build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
    conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
    structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
    customNotes: [],
    directoryMap: {},
    hotPaths: [],
    userDirectives: [],
});
describe('Project Memory Learner', () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learner-test-'));
    });
    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });
    const createBasicMemory = () => createBaseMemory(tempDir);
    describe('learnFromToolOutput', () => {
        it('should ignore non-Bash tools', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            await learnFromToolOutput('Read', { file_path: '/test' }, '', tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.build.buildCommand).toBeNull();
        });
        it.each([
            ['simple build command', 'pnpm build'],
            ['simple test command', 'cargo test'],
            ['arbitrary transcript with build/test substrings', 'echo "build passed; test next"'],
            ['heredoc containing build/test substrings', 'cat <<EOF\nbuildCommand=pnpm build\ntestCommand=pnpm test\nEOF'],
            ['copy command with build substring', 'cp build/output.js dist/output.js'],
            ['remove command with test substring', 'rm -rf test-results'],
            ['absolute worktree path command', '/tmp/worktrees/project/scripts/build-and-test.sh'],
            ['compound pipeline command', 'git diff --name-only | xargs pnpm test -- --runInBand'],
            ['echo separator command', 'echo "--- build ---" && echo "--- test ---"'],
        ])('should not learn build/test commands from Bash PostToolUse commands: %s', async (_name, command) => {
            const memory = createBasicMemory();
            memory.build.buildCommand = 'trusted build';
            memory.build.testCommand = 'trusted test';
            await saveProjectMemory(tempDir, memory);
            await learnFromToolOutput('Bash', { command }, 'Node.js v20.10.0', tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.build.buildCommand).toBe('trusted build');
            expect(updated?.build.testCommand).toBe('trusted test');
            expect(updated?.customNotes.some(note => note.content === 'Node.js v20.10.0')).toBe(true);
        });
        it.each([
            ['heredoc', 'cat <<EOF\nnpm run build\nnpm test\nEOF'],
            ['cp/rm', 'cp build.log /tmp/build.log && rm -rf test-output'],
            ['absolute worktree path', '/tmp/worktrees/demo/build-test'],
            ['compound pipeline', 'echo build | tee /tmp/log | xargs echo test'],
            ['echo separators', 'echo "===== build/test ====="'],
        ])('should not populate empty build/test commands from Bash command shape: %s', async (_name, command) => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            await learnFromToolOutput('Bash', { command }, '', tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.build.buildCommand).toBeNull();
            expect(updated?.build.testCommand).toBeNull();
        });
        it('should extract Node.js version from output', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            const output = 'Node.js v20.10.0\n...';
            await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].category).toBe('runtime');
            expect(updated?.customNotes[0].content).toContain('Node.js');
        });
        it('should extract Bash output hints even when command input is missing', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            await learnFromToolOutput('Bash', {}, 'Python 3.11.5', tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.build.buildCommand).toBeNull();
            expect(updated?.build.testCommand).toBeNull();
            expect(updated?.customNotes[0].content).toBe('Python 3.11.5');
        });
        it('should extract Python version from output', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            const output = 'Python 3.11.5\n...';
            await learnFromToolOutput('Bash', { command: 'python --version' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].category).toBe('runtime');
            expect(updated?.customNotes[0].content).toContain('Python 3.11.5');
        });
        it('should extract Rust version from output', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            const output = 'rustc 1.75.0 (82e1608df 2024-01-01)\n...';
            await learnFromToolOutput('Bash', { command: 'rustc --version' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].category).toBe('runtime');
            expect(updated?.customNotes[0].content).toContain('Rust 1.75.0');
        });
        it('should detect missing modules', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            const output = 'Error: Cannot find module \'express\'\n...';
            await learnFromToolOutput('Bash', { command: 'node app.js' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].category).toBe('dependency');
            expect(updated?.customNotes[0].content).toContain('express');
        });
        it('should detect required environment variables', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            const output = 'Error: Missing environment variable: DATABASE_URL\n...';
            await learnFromToolOutput('Bash', { command: 'npm start' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].category).toBe('env');
            expect(updated?.customNotes[0].content).toContain('DATABASE_URL');
        });
        it('should not duplicate existing notes', async () => {
            const memory = createBasicMemory();
            memory.customNotes.push({
                timestamp: Date.now(),
                source: 'learned',
                category: 'runtime',
                content: 'Node.js v20.10.0',
            });
            await saveProjectMemory(tempDir, memory);
            const output = 'Node.js v20.10.0\n...';
            await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
        });
        it('should limit custom notes to 20 entries', async () => {
            const memory = createBasicMemory();
            // Add 20 existing notes
            for (let i = 0; i < 20; i++) {
                memory.customNotes.push({
                    timestamp: Date.now(),
                    source: 'learned',
                    category: 'test',
                    content: `Note ${i}`,
                });
            }
            await saveProjectMemory(tempDir, memory);
            // Add one more
            const output = 'Node.js v20.10.0\n...';
            await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(20);
            expect(updated?.customNotes[19].content).toContain('Node.js');
        });
        it('should ignore non-string Bash tool output without crashing', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            await expect(learnFromToolOutput('Bash', { command: 'node --version' }, { stdout: 'Node.js v20.10.0' }, tempDir)).resolves.not.toThrow();
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(0);
        });
        it('should initialize hot paths when saved memory is missing hotPaths', async () => {
            const memoryPath = getMemoryPath(tempDir);
            const minimalMemory = createBasicMemory();
            const { hotPaths: _hotPaths, ...memoryWithoutHotPaths } = minimalMemory;
            await fs.mkdir(path.dirname(memoryPath), { recursive: true });
            await fs.writeFile(memoryPath, JSON.stringify(memoryWithoutHotPaths), 'utf-8');
            await expect(learnFromToolOutput('Read', { file_path: path.join(tempDir, 'src', 'index.ts') }, '', tempDir)).resolves.not.toThrow();
            const updated = await loadProjectMemory(tempDir);
            expect(Array.isArray(updated?.hotPaths)).toBe(true);
            expect(updated?.hotPaths).toEqual([
                expect.objectContaining({
                    path: 'src/index.ts',
                    accessCount: 1,
                    type: 'file',
                }),
            ]);
        });
        it('should do nothing if memory file does not exist', async () => {
            await expect(learnFromToolOutput('Bash', { command: 'pnpm build' }, '', tempDir)).resolves.not.toThrow();
        });
    });
    describe('addCustomNote', () => {
        it('should add manual custom note', async () => {
            const memory = createBasicMemory();
            await saveProjectMemory(tempDir, memory);
            await addCustomNote(tempDir, 'deploy', 'Requires Docker');
            const updated = await loadProjectMemory(tempDir);
            expect(updated?.customNotes).toHaveLength(1);
            expect(updated?.customNotes[0].source).toBe('manual');
            expect(updated?.customNotes[0].category).toBe('deploy');
            expect(updated?.customNotes[0].content).toBe('Requires Docker');
        });
        it('should do nothing if memory file does not exist', async () => {
            await expect(addCustomNote(tempDir, 'test', 'Test note')).resolves.not.toThrow();
        });
    });
});
//# sourceMappingURL=learner.test.js.map