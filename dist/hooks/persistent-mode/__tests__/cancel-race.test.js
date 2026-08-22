import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
function makeRalphSession(tempDir, sessionId) {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 10,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        prompt: 'Finish all work',
        session_id: sessionId,
        project_path: tempDir,
        linked_ultrawork: true
    }, null, 2));
    return stateDir;
}
describe('persistent-mode cancel race guard (issue #921)', () => {
    it.each([
        '/oh-my-claudecode:cancel',
        '/oh-my-claudecode:cancel --force'
    ])('should not re-enforce while explicit cancel prompt is "%s"', async (cancelPrompt) => {
        const sessionId = `session-921-${cancelPrompt.includes('force') ? 'force' : 'normal'}`;
        const tempDir = mkdtempSync(join(tmpdir(), 'persistent-cancel-race-'));
        try {
            execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
            const stateDir = makeRalphSession(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir, {
                prompt: cancelPrompt
            });
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
            const ralphState = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'));
            expect(ralphState.iteration).toBe(10);
            expect(ralphState.max_iterations).toBe(10);
            expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('should not trigger ralph max-iteration extension or ultrawork self-heal when cancel signal exists', async () => {
        const sessionId = 'session-921-cancel-signal';
        const tempDir = mkdtempSync(join(tmpdir(), 'persistent-cancel-signal-'));
        try {
            execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
            const stateDir = makeRalphSession(tempDir, sessionId);
            const requestedAt = Date.now();
            writeFileSync(join(stateDir, 'cancel-signal-state.json'), JSON.stringify({
                active: true,
                requested_at: new Date(requestedAt).toISOString(),
                expires_at: new Date(requestedAt + 30_000).toISOString(),
                source: 'test'
            }, null, 2));
            const result = await checkPersistentModes(sessionId, tempDir, {
                stop_reason: 'end_turn'
            });
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
            const ralphState = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'));
            expect(ralphState.iteration).toBe(10);
            expect(ralphState.max_iterations).toBe(10);
            expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('should not re-enforce when a resumed session clears the owning session and writes a foreign cancel signal', async () => {
        const ownerSessionId = 'session-2743-owner';
        const resumedSessionId = 'session-2743-resumed';
        const tempDir = mkdtempSync(join(tmpdir(), 'persistent-cross-session-cancel-'));
        try {
            execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
            const ownerDir = makeRalphSession(tempDir, ownerSessionId);
            const resumedDir = join(tempDir, '.omc', 'state', 'sessions', resumedSessionId);
            mkdirSync(resumedDir, { recursive: true });
            const requestedAt = Date.now();
            writeFileSync(join(ownerDir, 'cancel-signal-state.json'), JSON.stringify({
                active: true,
                requested_at: new Date(requestedAt).toISOString(),
                expires_at: new Date(requestedAt + 30_000).toISOString(),
                mode: 'ralph',
                source: 'state_clear'
            }, null, 2));
            const result = await checkPersistentModes(resumedSessionId, tempDir, {
                stop_reason: 'end_turn'
            });
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
            expect(existsSync(join(ownerDir, 'ultrawork-state.json'))).toBe(false);
            const ralphState = JSON.parse(readFileSync(join(ownerDir, 'ralph-state.json'), 'utf-8'));
            expect(ralphState.iteration).toBe(10);
            expect(ralphState.max_iterations).toBe(10);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=cancel-race.test.js.map