import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { writeModeState, readModeState, clearModeStateFile } from '../mode-state-io.js';
let tempDir;
describe('mode-state-io', () => {
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'mode-state-io-test-'));
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    // -----------------------------------------------------------------------
    // writeModeState
    // -----------------------------------------------------------------------
    describe('writeModeState', () => {
        it('should write state with _meta containing written_at and mode', () => {
            const result = writeModeState('ralph', { active: true, iteration: 3 }, tempDir);
            expect(result).toBe(true);
            const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
            expect(existsSync(filePath)).toBe(true);
            const written = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(written.active).toBe(true);
            expect(written.iteration).toBe(3);
            expect(written._meta).toBeDefined();
            expect(written._meta.mode).toBe('ralph');
            expect(written._meta.written_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
        it('should write session-scoped state when sessionId is provided', () => {
            const result = writeModeState('ultrawork', { active: true }, tempDir, 'pid-123-1000');
            expect(result).toBe(true);
            const filePath = join(tempDir, '.omc', 'state', 'sessions', 'pid-123-1000', 'ultrawork-state.json');
            expect(existsSync(filePath)).toBe(true);
            const written = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(written._meta.mode).toBe('ultrawork');
            expect(written.active).toBe(true);
        });
        it('should create parent directories as needed', () => {
            const result = writeModeState('autopilot', { phase: 'exec' }, tempDir);
            expect(result).toBe(true);
            expect(existsSync(join(tempDir, '.omc', 'state'))).toBe(true);
        });
        it('should resolve writes to the git worktree root when called from a subdirectory', () => {
            const nestedDir = join(tempDir, 'nested', 'cwd');
            mkdirSync(nestedDir, { recursive: true });
            execSync('git init', { cwd: tempDir, stdio: 'pipe' });
            const result = writeModeState('autopilot', { phase: 'exec' }, nestedDir);
            expect(result).toBe(true);
            expect(existsSync(join(tempDir, '.omc', 'state', 'autopilot-state.json'))).toBe(true);
            expect(existsSync(join(nestedDir, '.omc', 'state', 'autopilot-state.json'))).toBe(false);
        });
        it('should write file with 0o600 permissions', () => {
            writeModeState('ralph', { active: true }, tempDir);
            const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
            const { mode } = require('fs').statSync(filePath);
            // 0o600 = owner read+write only (on Linux the file mode bits are in the lower 12 bits)
            expect(mode & 0o777).toBe(0o600);
        });
        it('should not leave shared .tmp file after successful write (uses atomic write with unique temp)', () => {
            writeModeState('ralph', { active: true }, tempDir);
            const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
            expect(existsSync(filePath)).toBe(true);
            // atomicWriteJsonSync uses random UUID-based temp files, not shared .tmp suffix
            expect(existsSync(filePath + '.tmp')).toBe(false);
        });
        it('should include sessionId in _meta when sessionId is provided', () => {
            writeModeState('ralph', { active: true }, tempDir, 'pid-session-42');
            const filePath = join(tempDir, '.omc', 'state', 'sessions', 'pid-session-42', 'ralph-state.json');
            expect(existsSync(filePath)).toBe(true);
            const written = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(written._meta.sessionId).toBe('pid-session-42');
        });
        it('should not include sessionId in _meta when sessionId is not provided', () => {
            writeModeState('ralph', { active: true }, tempDir);
            const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
            const written = JSON.parse(readFileSync(filePath, 'utf-8'));
            expect(written._meta.sessionId).toBeUndefined();
        });
        it('should use atomic write preventing race conditions from shared .tmp path', () => {
            // Two concurrent writes should not collide on temp file paths
            // (atomicWriteJsonSync uses crypto.randomUUID() for temp file names)
            const result1 = writeModeState('ralph', { active: true, iteration: 1 }, tempDir);
            const result2 = writeModeState('ralph', { active: true, iteration: 2 }, tempDir);
            expect(result1).toBe(true);
            expect(result2).toBe(true);
            // The last write should win
            const state = readModeState('ralph', tempDir);
            expect(state).not.toBeNull();
            expect(state.iteration).toBe(2);
        });
    });
    // -----------------------------------------------------------------------
    // readModeState
    // -----------------------------------------------------------------------
    describe('readModeState', () => {
        it('should read state from legacy path when no sessionId', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({ active: true, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }));
            const result = readModeState('ralph', tempDir);
            expect(result).not.toBeNull();
            expect(result.active).toBe(true);
        });
        it('should strip _meta from the returned state', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 5, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }));
            const result = readModeState('ralph', tempDir);
            expect(result).not.toBeNull();
            expect(result.active).toBe(true);
            expect(result.iteration).toBe(5);
            expect(result._meta).toBeUndefined();
        });
        it('should handle files without _meta (pre-migration)', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ultrawork-state.json'), JSON.stringify({ active: true, phase: 'running' }));
            const result = readModeState('ultrawork', tempDir);
            expect(result).not.toBeNull();
            expect(result.active).toBe(true);
            expect(result.phase).toBe('running');
        });
        it('should read state from the git worktree root when given a subdirectory', () => {
            const nestedDir = join(tempDir, 'nested', 'cwd');
            mkdirSync(nestedDir, { recursive: true });
            execSync('git init', { cwd: tempDir, stdio: 'pipe' });
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({ active: true, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }));
            const result = readModeState('ralph', nestedDir);
            expect(result).not.toBeNull();
            expect(result.active).toBe(true);
        });
        it('should read from session path when sessionId is provided', () => {
            const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-999-2000');
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'autopilot-state.json'), JSON.stringify({ active: true, phase: 'exec' }));
            const result = readModeState('autopilot', tempDir, 'pid-999-2000');
            expect(result).not.toBeNull();
            expect(result.active).toBe(true);
            expect(result.phase).toBe('exec');
        });
        it('should NOT read legacy path when sessionId is provided', () => {
            // Write at legacy path only
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({ active: true }));
            // Read with sessionId — should NOT find it at legacy path
            const result = readModeState('ralph', tempDir, 'pid-555-3000');
            expect(result).toBeNull();
        });
        it('should return null when file does not exist', () => {
            const result = readModeState('ralph', tempDir);
            expect(result).toBeNull();
        });
        it('should return null on invalid JSON', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'ralph-state.json'), 'not-json{{{');
            const result = readModeState('ralph', tempDir);
            expect(result).toBeNull();
        });
    });
    // -----------------------------------------------------------------------
    // clearModeStateFile
    // -----------------------------------------------------------------------
    describe('clearModeStateFile', () => {
        it('should clear state from the git worktree root when given a subdirectory', () => {
            const nestedDir = join(tempDir, 'nested', 'cwd');
            mkdirSync(nestedDir, { recursive: true });
            execSync('git init', { cwd: tempDir, stdio: 'pipe' });
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const filePath = join(stateDir, 'ralph-state.json');
            writeFileSync(filePath, JSON.stringify({ active: true }));
            const result = clearModeStateFile('ralph', nestedDir);
            expect(result).toBe(true);
            expect(existsSync(filePath)).toBe(false);
            expect(existsSync(join(nestedDir, '.omc', 'state', 'ralph-state.json'))).toBe(false);
        });
        it('should delete the legacy state file', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const filePath = join(stateDir, 'ralph-state.json');
            writeFileSync(filePath, JSON.stringify({ active: true }));
            const result = clearModeStateFile('ralph', tempDir);
            expect(result).toBe(true);
            expect(existsSync(filePath)).toBe(false);
        });
        it('should delete session-scoped state file', () => {
            const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-100-500');
            mkdirSync(sessionDir, { recursive: true });
            const filePath = join(sessionDir, 'ultrawork-state.json');
            writeFileSync(filePath, JSON.stringify({ active: true }));
            const result = clearModeStateFile('ultrawork', tempDir, 'pid-100-500');
            expect(result).toBe(true);
            expect(existsSync(filePath)).toBe(false);
        });
        it('should perform ghost-legacy cleanup for files with matching session_id', () => {
            // Create legacy file owned by this session (top-level session_id)
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const legacyPath = join(stateDir, 'ralph-state.json');
            writeFileSync(legacyPath, JSON.stringify({ active: true, session_id: 'pid-200-600' }));
            // Create session-scoped file too
            const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-200-600');
            mkdirSync(sessionDir, { recursive: true });
            const sessionPath = join(sessionDir, 'ralph-state.json');
            writeFileSync(sessionPath, JSON.stringify({ active: true }));
            const result = clearModeStateFile('ralph', tempDir, 'pid-200-600');
            expect(result).toBe(true);
            // Both files should be deleted
            expect(existsSync(sessionPath)).toBe(false);
            expect(existsSync(legacyPath)).toBe(false);
        });
        it('should clean up legacy file with no session_id (unowned/orphaned)', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const legacyPath = join(stateDir, 'ultrawork-state.json');
            writeFileSync(legacyPath, JSON.stringify({ active: true }));
            const result = clearModeStateFile('ultrawork', tempDir, 'pid-300-700');
            expect(result).toBe(true);
            expect(existsSync(legacyPath)).toBe(false);
        });
        it('should clean up legacy root-level mode files for the matching session', () => {
            const legacyRootPath = join(tempDir, '.omc', 'ralph-state.json');
            mkdirSync(join(tempDir, '.omc'), { recursive: true });
            writeFileSync(legacyRootPath, JSON.stringify({ active: true, session_id: 'pid-legacy-root-1' }));
            const result = clearModeStateFile('ralph', tempDir, 'pid-legacy-root-1');
            expect(result).toBe(true);
            expect(existsSync(legacyRootPath)).toBe(false);
        });
        it('should NOT delete legacy file owned by a different session', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const legacyPath = join(stateDir, 'ralph-state.json');
            writeFileSync(legacyPath, JSON.stringify({ active: true, session_id: 'pid-other-999' }));
            clearModeStateFile('ralph', tempDir, 'pid-mine-100');
            // Legacy file should survive — it belongs to another session
            expect(existsSync(legacyPath)).toBe(true);
        });
        it('should NOT delete legacy file owned by a different session via _meta.sessionId', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const legacyPath = join(stateDir, 'autopilot-state.json');
            writeFileSync(legacyPath, JSON.stringify({ active: true, _meta: { sessionId: 'session-other-321' } }));
            clearModeStateFile('autopilot', tempDir, 'session-mine-123');
            expect(existsSync(legacyPath)).toBe(true);
        });
        it('should delete legacy file owned by this session via _meta.sessionId', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const legacyPath = join(stateDir, 'autopilot-state.json');
            writeFileSync(legacyPath, JSON.stringify({ active: true, _meta: { sessionId: 'session-mine-123' } }));
            clearModeStateFile('autopilot', tempDir, 'session-mine-123');
            expect(existsSync(legacyPath)).toBe(false);
        });
        it('should remove all session-scoped files when no session_id is provided', () => {
            const sessionAPath = join(tempDir, '.omc', 'state', 'sessions', 'session-a', 'ralph-state.json');
            const sessionBPath = join(tempDir, '.omc', 'state', 'sessions', 'session-b', 'ralph-state.json');
            mkdirSync(join(tempDir, '.omc', 'state', 'sessions', 'session-a'), { recursive: true });
            mkdirSync(join(tempDir, '.omc', 'state', 'sessions', 'session-b'), { recursive: true });
            writeFileSync(sessionAPath, JSON.stringify({ active: true, session_id: 'session-a' }));
            writeFileSync(sessionBPath, JSON.stringify({ active: true, session_id: 'session-b' }));
            const result = clearModeStateFile('ralph', tempDir);
            expect(result).toBe(true);
            expect(existsSync(sessionAPath)).toBe(false);
            expect(existsSync(sessionBPath)).toBe(false);
        });
        it('should remove mode runtime artifacts during session-scoped clear', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            const sessionDir = join(stateDir, 'sessions', 'session-runtime-cleanup');
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true }));
            writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 2 }));
            writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 2 }));
            writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
            writeFileSync(join(stateDir, 'ralph-continue-steer.lock'), `${process.pid}`);
            const result = clearModeStateFile('ralph', tempDir, 'session-runtime-cleanup');
            expect(result).toBe(true);
            expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
            expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
            expect(existsSync(join(stateDir, 'ralph-continue-steer.lock'))).toBe(false);
        });
        it('should return true when file does not exist (already absent)', () => {
            const result = clearModeStateFile('ralph', tempDir);
            expect(result).toBe(true);
        });
    });
});
//# sourceMappingURL=mode-state-io.test.js.map