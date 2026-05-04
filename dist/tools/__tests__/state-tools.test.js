import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
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
                mode: 'ralph',
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
        it('should also remove non-session legacy state files during session clear', async () => {
            const sessionId = 'legacy-cleanup-session';
            const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, session_id: sessionId }));
            const legacyRootPath = join(TEST_DIR, '.omc', 'ralph-state.json');
            writeFileSync(legacyRootPath, JSON.stringify({ active: true, session_id: sessionId }));
            const result = await stateClearTool.handler({
                mode: 'ralph',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('ghost legacy file also removed');
            expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
            expect(existsSync(legacyRootPath)).toBe(false);
        });
        it('should clear only the requested session for every execution mode', async () => {
            const modes = ['autopilot', 'autoresearch', 'ralph', 'ultrawork', 'ultraqa', 'team'];
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
        it('should clear skill-active state with session_id (fix for #2118)', async () => {
            const sessionId = 'test-skill-active-clear';
            await stateWriteTool.handler({
                mode: 'skill-active',
                active: true,
                state: { skill_name: 'sciomc', reinforcement_count: 2 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            // Verify skill-active appears in the active list before clearing
            const listBefore = await stateListActiveTool.handler({
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(listBefore.content[0].text).toContain('skill-active');
            const clearResult = await stateClearTool.handler({
                mode: 'skill-active',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(clearResult.content[0].text).toContain('cleared');
            const readResult = await stateReadTool.handler({
                mode: 'skill-active',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            // stateReadTool returning "No state found" is authoritative proof the file is gone
            expect(readResult.content[0].text).toContain('No state found');
        });
        it('clears completed-session orphan state when cancel runs from a fresh session id', async () => {
            const freshSessionId = 'fresh-cancel-session';
            const liveSessionId = 'live-sibling-session';
            const orphanSessionIds = ['ended-session-one', 'ended-session-two'];
            const modes = ['ralph', 'ultrawork', 'team'];
            mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
            for (const orphanSessionId of orphanSessionIds) {
                mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
                writeFileSync(join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`), JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }));
            }
            mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId), { recursive: true });
            for (const mode of modes) {
                for (const orphanSessionId of orphanSessionIds) {
                    writeFileSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`), JSON.stringify({
                        active: true,
                        session_id: orphanSessionId,
                        ...(mode === 'team' ? { team_name: `team-${orphanSessionId}` } : {}),
                    }));
                }
                writeFileSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`), JSON.stringify({ active: true, session_id: liveSessionId }));
                const result = await stateClearTool.handler({
                    mode,
                    session_id: freshSessionId,
                    workingDirectory: TEST_DIR,
                });
                expect(result.content[0].text).toContain('completed-session orphan');
                for (const orphanSessionId of orphanSessionIds) {
                    expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`))).toBe(false);
                }
                expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`))).toBe(true);
            }
        });
        it('reports completed-session orphan state on session-scoped read misses', async () => {
            const freshSessionId = 'fresh-read-session';
            const orphanSessionId = 'ended-read-session';
            mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
            mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
            writeFileSync(join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`), JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }));
            writeFileSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, 'ralph-state.json'), JSON.stringify({ active: true, session_id: orphanSessionId }));
            const result = await stateReadTool.handler({
                mode: 'ralph',
                session_id: freshSessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('completed-session orphan');
            expect(result.content[0].text).toContain(orphanSessionId);
        });
        it('clears completed-session orphan state through a symlinked .omc directory', async () => {
            const symlinkTestDir = mkdtempSync(join(tmpdir(), 'state-tools-symlink-'));
            const realOmcDir = mkdtempSync(join(tmpdir(), 'state-tools-real-omc-'));
            try {
                rmSync(join(symlinkTestDir, '.omc'), { recursive: true, force: true });
                symlinkSync(realOmcDir, join(symlinkTestDir, '.omc'), 'dir');
                const orphanSessionId = 'ended-symlink-session';
                const freshSessionId = 'fresh-symlink-session';
                mkdirSync(join(realOmcDir, 'sessions'), { recursive: true });
                mkdirSync(join(realOmcDir, 'state', 'sessions', orphanSessionId), { recursive: true });
                writeFileSync(join(realOmcDir, 'sessions', `${orphanSessionId}.json`), JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }));
                writeFileSync(join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'), JSON.stringify({ active: true, session_id: orphanSessionId }));
                const result = await stateClearTool.handler({
                    mode: 'ultrawork',
                    session_id: freshSessionId,
                    workingDirectory: symlinkTestDir,
                });
                expect(result.content[0].text).toContain('completed-session orphan');
                expect(existsSync(join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'))).toBe(false);
            }
            finally {
                rmSync(symlinkTestDir, { recursive: true, force: true });
                rmSync(realOmcDir, { recursive: true, force: true });
            }
        });
        it('should list skill-active as active when state file is present', async () => {
            const sessionId = 'skill-active-list-test';
            await stateWriteTool.handler({
                mode: 'skill-active',
                active: true,
                state: { skill_name: 'learner' },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('skill-active');
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
        it('should include autoresearch mode when autoresearch state is active', async () => {
            await stateWriteTool.handler({
                mode: 'autoresearch',
                active: true,
                state: { phase: 'running' },
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('autoresearch');
        });
        it('should include deep-interview mode when deep-interview state is active', async () => {
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { phase: 'questioning' },
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('deep-interview');
        });
        it('should include self-improve mode when self-improve state is active', async () => {
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 1 },
                workingDirectory: TEST_DIR,
            });
            const result = await stateListActiveTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('self-improve');
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
        it('deep-interview and self-improve appear in all-mode status listing', async () => {
            const result = await stateGetStatusTool.handler({
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('deep-interview');
            expect(result.content[0].text).toContain('self-improve');
        });
    });
    // -----------------------------------------------------------------------
    // Registry parity: deep-interview and self-improve as first-class modes
    // -----------------------------------------------------------------------
    describe('deep-interview and self-improve registry parity (T1)', () => {
        it('writes deep-interview state to session-scoped path via MODE_CONFIGS routing', async () => {
            const sessionId = 'di-registry-write';
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { current_phase: 'questioning', round: 3 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
            expect(existsSync(statePath)).toBe(true);
        });
        it('writes self-improve state to session-scoped path via MODE_CONFIGS routing', async () => {
            const sessionId = 'si-registry-write';
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 1, best_score: 0.85 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
            expect(existsSync(statePath)).toBe(true);
        });
        it('reads deep-interview state back from session-scoped path', async () => {
            const sessionId = 'di-registry-read';
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { current_phase: 'questioning', ambiguity_score: 0.34 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateReadTool.handler({
                mode: 'deep-interview',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('current_phase');
            expect(result.content[0].text).toContain('ambiguity_score');
        });
        it('reads self-improve state back from session-scoped path', async () => {
            const sessionId = 'si-registry-read';
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 2, generation: 5 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const result = await stateReadTool.handler({
                mode: 'self-improve',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('tournament_round');
            expect(result.content[0].text).toContain('generation');
        });
        it('clears deep-interview state file for given session', async () => {
            const sessionId = 'di-registry-clear';
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { current_phase: 'analysis' },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const clearResult = await stateClearTool.handler({
                mode: 'deep-interview',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
            const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
            expect(existsSync(statePath)).toBe(false);
        });
        it('clears self-improve state file for given session', async () => {
            const sessionId = 'si-registry-clear';
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 3 },
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            const clearResult = await stateClearTool.handler({
                mode: 'self-improve',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
            const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
            expect(existsSync(statePath)).toBe(false);
        });
        it('state_get_status reports self-improve as active when state file is present', async () => {
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 2 },
                workingDirectory: TEST_DIR,
            });
            const result = await stateGetStatusTool.handler({
                mode: 'self-improve',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Status: self-improve');
            expect(result.content[0].text).toContain('**Active:** Yes');
        });
        it('state_get_status reports deep-interview as active when state file is present', async () => {
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { current_phase: 'contrarian' },
                workingDirectory: TEST_DIR,
            });
            const result = await stateGetStatusTool.handler({
                mode: 'deep-interview',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Status: deep-interview');
            expect(result.content[0].text).toContain('**Active:** Yes');
        });
        it('deep-interview session isolation: write to session A does not appear under session B', async () => {
            const sessionA = 'di-iso-a';
            const sessionB = 'di-iso-b';
            await stateWriteTool.handler({
                mode: 'deep-interview',
                active: true,
                state: { current_phase: 'questioning' },
                session_id: sessionA,
                workingDirectory: TEST_DIR,
            });
            const resultB = await stateReadTool.handler({
                mode: 'deep-interview',
                session_id: sessionB,
                workingDirectory: TEST_DIR,
            });
            expect(resultB.content[0].text).toContain('No state found');
        });
        it('self-improve session isolation: write to session A does not appear under session B', async () => {
            const sessionA = 'si-iso-a';
            const sessionB = 'si-iso-b';
            await stateWriteTool.handler({
                mode: 'self-improve',
                active: true,
                state: { tournament_round: 1 },
                session_id: sessionA,
                workingDirectory: TEST_DIR,
            });
            const resultB = await stateReadTool.handler({
                mode: 'self-improve',
                session_id: sessionB,
                workingDirectory: TEST_DIR,
            });
            expect(resultB.content[0].text).toContain('No state found');
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
        it('should clear session-specific state without affecting legacy owned by another session', async () => {
            const sessionId = 'test-session-clear';
            const otherSessionId = 'other-session-owner';
            // Create legacy state owned by a different session
            writeFileSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'), JSON.stringify({ active: true, source: 'legacy', _meta: { sessionId: otherSessionId } }));
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
            // Legacy file should remain (belongs to different session)
            expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
        });
        it('should clear recovered session-owned state stranded under another session directory', async () => {
            const sessionId = 'continued-session';
            const strandedDir = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-session-dir');
            mkdirSync(strandedDir, { recursive: true });
            writeFileSync(join(strandedDir, 'ralph-state.json'), JSON.stringify({ active: true, session_id: sessionId, source: 'recovered-session-state' }));
            const result = await stateClearTool.handler({
                mode: 'ralph',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('recovered session file');
            expect(existsSync(join(strandedDir, 'ralph-state.json'))).toBe(false);
        });
        it('should clear ralph stop-hook runtime artifacts with session-scoped cancel cleanup', async () => {
            const sessionId = 'ralph-stop-artifact-session';
            const stateDir = join(TEST_DIR, '.omc', 'state');
            const sessionDir = join(stateDir, 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, session_id: sessionId }));
            writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
            writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
            writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
            writeFileSync(join(stateDir, 'ralph-continue-steer.lock'), `${process.pid}`);
            const result = await stateClearTool.handler({
                mode: 'ralph',
                session_id: sessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('runtime artifact');
            expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
            expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-continue-steer.lock'))).toBe(false);
        });
        it('should clear the owning session when the current session resumed ralph from a different conversation', async () => {
            const currentSessionId = 'resume-session-b';
            const ownerSessionId = 'resume-session-a';
            const ownerDir = join(TEST_DIR, '.omc', 'state', 'sessions', ownerSessionId);
            mkdirSync(ownerDir, { recursive: true });
            writeFileSync(join(ownerDir, 'ralph-state.json'), JSON.stringify({
                active: true,
                session_id: ownerSessionId,
                iteration: 4,
                linked_ultrawork: true,
            }));
            const result = await stateClearTool.handler({
                mode: 'ralph',
                session_id: currentSessionId,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain(`cleared owning session: ${ownerSessionId}`);
            expect(existsSync(join(ownerDir, 'ralph-state.json'))).toBe(false);
            expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', currentSessionId, 'cancel-signal-state.json'))).toBe(true);
            expect(existsSync(join(ownerDir, 'cancel-signal-state.json'))).toBe(true);
        });
        it('should clear ralph runtime artifacts during broad cancel cleanup', async () => {
            const sessionId = 'ralph-broad-runtime-cleanup';
            const stateDir = join(TEST_DIR, '.omc', 'state');
            const sessionDir = join(stateDir, 'sessions', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
            writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
            writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
            const result = await stateClearTool.handler({
                mode: 'ralph',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Locations cleared: 3');
            expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
        });
        it('should discover and clear session-scoped autopilot state when no session_id is provided', async () => {
            const sessionId = 'missing-env-autopilot-session';
            const stateDir = join(TEST_DIR, '.omc', 'state');
            const sessionDir = join(stateDir, 'sessions', sessionId);
            const autopilotPath = join(sessionDir, 'autopilot-state.json');
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(autopilotPath, JSON.stringify({
                active: true,
                session_id: sessionId,
                phase: 'expansion',
            }));
            const result = await stateClearTool.handler({
                mode: 'autopilot',
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Cleared state for mode: autopilot');
            expect(existsSync(autopilotPath)).toBe(false);
            expect(existsSync(join(sessionDir, 'cancel-signal-state.json'))).toBe(true);
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
    describe('payload size validation', () => {
        it('should reject oversized custom state payloads', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { huge: 'x'.repeat(2_000_000) },
                workingDirectory: TEST_DIR,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('payload rejected');
            expect(result.content[0].text).toContain('exceeds maximum');
        });
        it('should reject deeply nested custom state payloads', async () => {
            let obj = { leaf: true };
            for (let i = 0; i < 15; i++) {
                obj = { nested: obj };
            }
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: obj,
                workingDirectory: TEST_DIR,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('nesting depth');
        });
        it('should reject state with too many top-level keys', async () => {
            const state = {};
            for (let i = 0; i < 150; i++) {
                state[`key_${i}`] = 'value';
            }
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state,
                workingDirectory: TEST_DIR,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('top-level keys');
        });
        it('should still allow normal-sized state writes', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                state: { active: true, task: 'normal task', items: [1, 2, 3] },
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
        });
        it('should not validate when no custom state is provided', async () => {
            const result = await stateWriteTool.handler({
                mode: 'ralph',
                active: true,
                iteration: 1,
                workingDirectory: TEST_DIR,
            });
            expect(result.content[0].text).toContain('Successfully wrote');
        });
    });
});
//# sourceMappingURL=state-tools.test.js.map