import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
const { getUsageMock } = vi.hoisted(() => ({
    getUsageMock: vi.fn(),
}));
vi.mock('../../hud/usage-api.js', () => ({
    getUsage: getUsageMock,
}));
import { checkRateLimitStatus } from '../../features/rate-limit-wait/rate-limit-monitor.js';
import { readStdinCache, writeStdinCache } from '../../hud/stdin.js';
import { getSessionStateDir } from '../../lib/worktree-paths.js';
describe('detached daemon HUD cache context', () => {
    let worktreeRoot;
    let centralStateRoot;
    let originalCwd;
    const originalStateDir = process.env.OMC_STATE_DIR;
    const originalSessionId = process.env.CLAUDE_SESSION_ID;
    const originalLegacySessionId = process.env.CLAUDECODE_SESSION_ID;
    beforeEach(() => {
        worktreeRoot = mkdtempSync(join(tmpdir(), 'omc-daemon-cache-context-'));
        centralStateRoot = mkdtempSync(join(tmpdir(), 'omc-daemon-cache-central-'));
        execSync('git init --quiet', { cwd: worktreeRoot });
        originalCwd = process.cwd();
        process.chdir(worktreeRoot);
        process.env.OMC_STATE_DIR = centralStateRoot;
        delete process.env.CLAUDE_SESSION_ID;
        delete process.env.CLAUDECODE_SESSION_ID;
        getUsageMock.mockReset();
        getUsageMock.mockResolvedValue({ rateLimits: null, error: 'no_credentials' });
    });
    afterEach(() => {
        process.chdir(originalCwd);
        if (originalStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = originalStateDir;
        if (originalSessionId === undefined)
            delete process.env.CLAUDE_SESSION_ID;
        else
            process.env.CLAUDE_SESSION_ID = originalSessionId;
        if (originalLegacySessionId === undefined)
            delete process.env.CLAUDECODE_SESSION_ID;
        else
            process.env.CLAUDECODE_SESSION_ID = originalLegacySessionId;
        rmSync(worktreeRoot, { recursive: true, force: true });
        rmSync(centralStateRoot, { recursive: true, force: true });
    });
    it('uses a newer live session after the daemon launch session cache is removed', async () => {
        process.env.CLAUDE_SESSION_ID = 'session-a';
        writeStdinCache({ cwd: worktreeRoot, version: '2.1.100' });
        const sessionACache = join(getSessionStateDir('session-a', worktreeRoot), 'hud-stdin-cache.json');
        rmSync(sessionACache);
        process.env.CLAUDE_SESSION_ID = 'session-b';
        writeStdinCache({ cwd: worktreeRoot, version: '2.1.232' });
        // Detached daemons intentionally run without either launch-session ID.
        delete process.env.CLAUDE_SESSION_ID;
        delete process.env.CLAUDECODE_SESSION_ID;
        expect(readStdinCache()?.version).toBe('2.1.232');
        await checkRateLimitStatus();
        expect(getUsageMock).toHaveBeenCalledWith({ clientVersion: '2.1.232' });
    });
});
//# sourceMappingURL=daemon-cache-context.test.js.map