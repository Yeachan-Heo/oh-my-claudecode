import { describe, it, expect } from 'vitest';
import { sanitizeName, sessionName, createSession, killSession } from '../tmux-session.js';
describe('sanitizeName', () => {
    it('passes alphanumeric names', () => {
        expect(sanitizeName('worker1')).toBe('worker1');
    });
    it('removes invalid characters', () => {
        expect(sanitizeName('worker@1!')).toBe('worker1');
    });
    it('allows hyphens', () => {
        expect(sanitizeName('my-worker')).toBe('my-worker');
    });
    it('truncates to 50 chars', () => {
        const long = 'a'.repeat(100);
        expect(sanitizeName(long).length).toBe(50);
    });
    it('throws for all-invalid names', () => {
        expect(() => sanitizeName('!!!@@@')).toThrow('no valid characters');
    });
    it('rejects 1-char result after sanitization', () => {
        expect(() => sanitizeName('a')).toThrow('too short');
    });
    it('accepts 2-char result after sanitization', () => {
        expect(sanitizeName('ab')).toBe('ab');
    });
});
describe('sessionName', () => {
    it('builds correct session name', () => {
        expect(sessionName('myteam', 'codex1')).toBe('omc-team-myteam-codex1');
    });
    it('sanitizes both parts', () => {
        expect(sessionName('my team!', 'work@er')).toBe('omc-team-myteam-worker');
    });
});
// NOTE: createSession, killSession require tmux to be installed.
// Gate with: describe.skipIf(!hasTmux)('tmux integration', () => { ... })
function hasTmux() {
    try {
        const { execSync } = require('child_process');
        execSync('tmux -V', { stdio: 'pipe', timeout: 3000 });
        return true;
    }
    catch {
        return false;
    }
}
describe.skipIf(!hasTmux())('createSession with workingDirectory', () => {
    it('accepts optional workingDirectory param', () => {
        // Should not throw — workingDirectory is optional
        const name = createSession('tmuxtest', 'wdtest', '/tmp');
        expect(name).toBe('omc-team-tmuxtest-wdtest');
        killSession('tmuxtest', 'wdtest');
    });
    it('works without workingDirectory param', () => {
        const name = createSession('tmuxtest', 'nowd');
        expect(name).toBe('omc-team-tmuxtest-nowd');
        killSession('tmuxtest', 'nowd');
    });
});
//# sourceMappingURL=tmux-session.test.js.map