import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { stateReadTool, stateWriteTool, stateClearTool, stateListActiveTool, stateGetStatusTool, } from '../state-tools.js';
import { getProcessSessionId } from '../../lib/worktree-paths.js';
const TEST_DIR = '/tmp/state-tools-test';
// Mock validateWorkingDirectory to allow test directory
vi.mock('../../lib/worktree-paths.js', async () => {
    const actual = await vi.importActual('../../lib/worktree-paths.js');
    return {
        ...actual,
        validateWorkingDirectory: vi.fn((workingDirectory) => {
            return workingDirectory || process.cwd();
        }),
    };
});
describe('state-tools', () => {
    beforeEach(() => {
        mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
    });
    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });
    describe('state_read', () => {
        it('should return state when file exists at session-scoped path', async () => {
            // With auto-session-id, state_read looks at session-scoped path
            const sessionId = getProcessSessionId();
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 3 }));
            const result = await stateReadTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('active');
            expect(result.content[0].text).toContain('iteration');
        });
        it('should indicate when no state exists', async () => {
            const result = await stateReadTool.handler({
                mode: 'ultrawork',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('No state found');
        });
    });
    describe('state_write', () => {
        it('should write state to session-scoped path by default', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true, iteration: 1 },
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
            // State should be written to session-scoped path, not legacy
            const sessionId = getProcessSessionId();
            const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
            expect(existsSync(sessionPath)).toBe(true);
            // Legacy path should NOT exist
            expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(false);
        });
        it('should add _meta field to written state', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ecomode',
                state: { someField: 'value' },
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
            expect(result.content[0].text).toContain('_meta');
        });
        it('should include session ID in _meta', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true },
                workingDirectory: TEST_DIR,
            });
            const sessionId = getProcessSessionId();
            expect(result.content[0].text).toContain(`"sessionId": "${sessionId}"`);
        });
    });
    describe('state_clear', () => {
        it('should remove session-scoped state file', async () => {
            // First write state (goes to session-scoped path)
            await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true },
                workingDirectory: TEST_DIR,
            });
            const sessionId = getProcessSessionId();
            const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
            expect(existsSync(sessionPath)).toBe(true);
            // Now clear it
            const result = await stateClearTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toMatch(/cleared|Successfully/i);
            expect(existsSync(sessionPath)).toBe(false);
        });
        it('should clear ralplan state with explicit session_id', async () => {
            const sessionId = 'test-session-ralplan';
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralplan-state.json'), JSON.stringify({ active: true }));
            const result = await stateClearTool.handler({
                mode: 'ralplan',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('cleared');
            expect(existsSync(join(sessionDir, 'ralplan-state.json'))).toBe(false);
        });
    });
    describe('state_list_active', () => {
        it('should list active modes in current session', async () => {
            // Write state via tool (goes to session-scoped path)
            await stateWriteTool.handler({
                mode: 'ralph',
                active: true,
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('ralph');
        });
    });
    describe('state_get_status', () => {
        it('should return status for specific mode', async () => {
            const result = await stateGetStatusTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Status: ralph');
            expect(result.content[0].text).toContain('Active:');
        });
        it('should return all mode statuses when no mode specified', async () => {
            const result = await stateGetStatusTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('All Mode Statuses');
            expect(result.content[0].text.includes('[ACTIVE]') || result.content[0].text.includes('[INACTIVE]')).toBe(true);
        });
    });
    describe('session_id parameter', () => {
        it('should write state with explicit session_id to session-scoped path', async () => {
            const sessionId = 'test-session-123';
            const result = await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
            const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
            expect(existsSync(sessionPath)).toBe(true);
        });
        it('should read state with explicit session_id from session-scoped path', async () => {
            const sessionId = 'test-session-read';
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, session_id: sessionId }));
            const result = await stateReadTool.handler({
                mode: 'ralph',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('active');
        });
        it('should clear session-specific state without affecting legacy', async () => {
            const sessionId = 'test-session-clear';
            // Create both legacy and session-scoped state
            writeFileSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'), JSON.stringify({ active: true, source: 'legacy' }));
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, source: 'session' }));
            const result = await stateClearTool.handler({
                mode: 'ralph',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('cleared');
            // Session-scoped file should be gone
            expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
            // Legacy file should remain
            expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
        });
    });
    describe('auto session ID injection (Issue #456)', () => {
        it('should auto-inject process session ID format pid-{PID}-{timestamp}', () => {
            const sessionId = getProcessSessionId();
            expect(sessionId).toMatch(/^pid-\d+-\d+$/);
        });
        it('should return stable session ID across calls', () => {
            const id1 = getProcessSessionId();
            const id2 = getProcessSessionId();
            expect(id1).toBe(id2);
        });
        it('should prevent cross-process state bleeding', async () => {
            // Simulate two processes writing to the same mode
            const processASessionId = 'pid-11111-1000000';
            const processBSessionId = 'pid-22222-2000000';
            // Process A writes
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true, task: 'Process A task' },
                session_id: processASessionId,
                workingDirectory: TEST_DIR,
            });
            // Process B writes
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true, task: 'Process B task' },
                session_id: processBSessionId,
                workingDirectory: TEST_DIR,
            });
            // Process A reads its own state
            const resultA = await stateReadTool.handler({
                mode: 'ultrawork',
                session_id: processASessionId,
                workingDirectory: TEST_DIR,
            });
            expect(resultA.content[0].text).toContain('Process A task');
            expect(resultA.content[0].text).not.toContain('Process B task');
            // Process B reads its own state
            const resultB = await stateReadTool.handler({
                mode: 'ultrawork',
                session_id: processBSessionId,
                workingDirectory: TEST_DIR,
            });
            expect(resultB.content[0].text).toContain('Process B task');
            expect(resultB.content[0].text).not.toContain('Process A task');
        });
        it('should write state to session-scoped path even without explicit session_id', async () => {
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true },
                workingDirectory: TEST_DIR,
            });
            // Should NOT be at legacy path
            const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
            expect(existsSync(legacyPath)).toBe(false);
            // Should be at session-scoped path
            const sessionId = getProcessSessionId();
            const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
            expect(existsSync(sessionPath)).toBe(true);
        });
    });
});
//# sourceMappingURL=state-tools.test.js.map