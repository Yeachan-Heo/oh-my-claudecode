import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { stateReadTool, stateWriteTool, stateClearTool, stateListActiveTool, stateGetStatusTool, } from '../state-tools.js';
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
            const sessionId = 'session-read-test';
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 3 }));
            const result = await stateReadTool.handler({
                mode: 'ralph',
                session_id: sessionId,
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
        it('should write state to legacy path when no session_id provided', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true, iteration: 1 },
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
            const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
            expect(existsSync(legacyPath)).toBe(true);
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
        it('should include session ID in _meta when provided', async () => {
            const sessionId = 'session-meta-test';
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain(`"sessionId": "${sessionId}"`);
        });
    });
    describe('state_clear', () => {
        it('should remove legacy state file when no session_id provided', async () => {
            await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true },
                workingDirectory: TEST_DIR,
            });
            const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
            expect(existsSync(legacyPath)).toBe(true);
            const result = await stateClearTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toMatch(/cleared|Successfully/i);
            expect(existsSync(legacyPath)).toBe(false);
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
        it('should clear only the requested session for every execution mode', async () => {
            const modes = ['autopilot', 'ultrapilot', 'pipeline', 'ralph', 'ultrawork', 'ultraqa', 'ecomode'];
            const sessionA = 'session-a';
            const sessionB = 'session-b';
            for (const mode of modes) {
                await stateWriteTool.handler({
                    mode,
                    state: { active: true, owner: 'A' },
                    session_id: sessionA,
                    workingDirectory: TEST_DIR,
                });
                await stateWriteTool.handler({
                    mode,
                    state: { active: true, owner: 'B' },
                    session_id: sessionB,
                    workingDirectory: TEST_DIR,
                });
                const clearResult = await stateClearTool.handler({
                    mode,
                    session_id: sessionA,
                    workingDirectory: TEST_DIR,
                });
                expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
                const sessionAPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionA, `${mode}-state.json`);
                const sessionBPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionB, `${mode}-state.json`);
                expect(existsSync(sessionAPath)).toBe(false);
                expect(existsSync(sessionBPath)).toBe(true);
            }
        });
        it('should clear legacy and all sessions when session_id is omitted and show warning', async () => {
            const sessionId = 'aggregate-clear';
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true, source: 'legacy' },
                workingDirectory: TEST_DIR,
            });
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true, source: 'session' },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateClearTool.handler({
                mode: 'ultrawork',
                workingDirectory: TEST_DIR,
            });
            const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
            const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
            expect(result.content[0].text).toContain('WARNING: No session_id provided');
            expect(existsSync(legacyPath)).toBe(false);
            expect(existsSync(sessionPath)).toBe(false);
        });
        it('should not report false errors for sessions with no state file during broad clear', async () => {
            // Create a session directory but no state file for ralph mode
            const sessionId = 'empty-session';
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            // Note: no state file created - simulating a session with no ralph state
            // Create state for a different mode in the same session
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            // Now clear ralph mode (which has no state in this session)
            const result = await stateClearTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            // Should report "No state found" not errors
            expect(result.content[0].text).toContain('No state found');
            expect(result.content[0].text).not.toContain('Errors:');
        });
        it('should only count actual deletions in broad clear count', async () => {
            // Create state in only one session out of multiple
            const sessionWithState = 'has-state';
            const sessionWithoutState = 'no-state';
            // Create session directories
            mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithState), { recursive: true });
            mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithoutState), { recursive: true });
            // Only create state for one session
            await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true },
                session_id: sessionWithState,
                workingDirectory: TEST_DIR,
            });
            const result = await stateClearTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            // Should report exactly 1 location cleared (the session with state)
            expect(result.content[0].text).toContain('Locations cleared: 1');
            expect(result.content[0].text).not.toContain('Errors:');
        });
    });
    describe('state_list_active', () => {
        it('should list active modes in current session when session_id provided', async () => {
            const sessionId = 'active-session-test';
            await stateWriteTool.handler({
                mode: 'ralph',
                active: true,
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('ralph');
        });
        it('should list active modes across sessions when session_id omitted', async () => {
            const sessionId = 'aggregate-session';
            await stateWriteTool.handler({
                mode: 'ultrawork',
                active: true,
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('ultrawork');
            expect(result.content[0].text).toContain(sessionId);
        });
        it('should include team mode when team state is active', async () => {
            await stateWriteTool.handler({
                mode: 'team',
                active: true,
                state: { phase: 'team-exec' },
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('team');
        });
        it('should include team in status output when team state is active', async () => {
            await stateWriteTool.handler({
                mode: 'team',
                active: true,
                state: { phase: 'team-verify' },
                workingDirectory: TEST_DIR,
            });
            const result = await stateGetStatusTool.handler({
                mode: 'team',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Status: team');
            expect(result.content[0].text).toContain('**Active:** Yes');
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
    describe('session-scoped behavior', () => {
        it('should prevent cross-process state bleeding when session_id provided', async () => {
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
        it('should write state to legacy path when session_id omitted', async () => {
            await stateWriteTool.handler({
                mode: 'ultrawork',
                state: { active: true },
                workingDirectory: TEST_DIR,
            });
            const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
            expect(existsSync(legacyPath)).toBe(true);
        });
    });
});
//# sourceMappingURL=state-tools.test.js.map