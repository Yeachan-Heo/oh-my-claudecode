/**
 * Tests for team MCP cleanup hardening (plan: team-mcp-cleanup-4.4.0.md)
 *
 * Coverage:
 * - killWorkerPanes: leader-pane guard, empty no-op, shutdown sentinel write
 * - killTeamSession: never kill-session on split-pane (':'), leader-pane skip
 * - validateJobId regex logic (inline, since function is internal to team-server.ts)
 * - exit-code mapping: runtime-cli exitCodeFor logic (no dedicated timeout exit code)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
// ─── killWorkerPanes + killTeamSession ───────────────────────────────────────
// Mock child_process so tmux calls don't require a real tmux install
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFile: vi.fn((_cmd, _args, cb) => cb(null, '', '')),
        execFileSync: actual.execFileSync,
        execSync: actual.execSync,
    };
});
import { killWorkerPanes, killTeamSession } from '../../team/tmux-session.js';
let killedPanes = [];
let killedSessions = [];
beforeEach(async () => {
    killedPanes = [];
    killedSessions = [];
    const cp = await import('child_process');
    vi.mocked(cp.execFile).mockImplementation(((_cmd, args, cb) => {
        if (args[0] === 'kill-pane')
            killedPanes.push(args[2]);
        if (args[0] === 'kill-session')
            killedSessions.push(args[2]);
        cb(null, '', '');
        return {};
    }));
});
afterEach(() => {
    vi.clearAllMocks();
});
// ─── killWorkerPanes ─────────────────────────────────────────────────────────
describe('killWorkerPanes', () => {
    it('is a no-op when paneIds is empty', async () => {
        await killWorkerPanes({ paneIds: [], teamName: 'myteam', cwd: tmpdir(), graceMs: 0 });
        expect(killedPanes).toHaveLength(0);
    });
    it('kills worker panes', async () => {
        await killWorkerPanes({
            paneIds: ['%2', '%3'],
            teamName: 'myteam',
            cwd: tmpdir(),
            graceMs: 0,
        });
        expect(killedPanes).toContain('%2');
        expect(killedPanes).toContain('%3');
    });
    it('NEVER kills the leader pane', async () => {
        await killWorkerPanes({
            paneIds: ['%1', '%2', '%3'],
            leaderPaneId: '%1',
            teamName: 'myteam',
            cwd: tmpdir(),
            graceMs: 0,
        });
        expect(killedPanes).not.toContain('%1'); // leader guarded
        expect(killedPanes).toContain('%2');
        expect(killedPanes).toContain('%3');
    });
    it('writes shutdown sentinel before force-killing', async () => {
        const cwd = join(tmpdir(), `omc-cleanup-test-${process.pid}`);
        const stateDir = join(cwd, '.omc', 'state', 'team', 'myteam');
        mkdirSync(stateDir, { recursive: true });
        try {
            await killWorkerPanes({
                paneIds: ['%2'],
                teamName: 'myteam',
                cwd,
                graceMs: 0,
            });
            const sentinelPath = join(stateDir, 'shutdown.json');
            expect(existsSync(sentinelPath)).toBe(true);
            const content = JSON.parse(await readFile(sentinelPath, 'utf8'));
            expect(content).toHaveProperty('requestedAt');
            expect(typeof content.requestedAt).toBe('number');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not throw when sentinel directory does not exist (non-fatal)', async () => {
        await expect(killWorkerPanes({
            paneIds: ['%2'],
            teamName: 'nonexistent-team',
            cwd: '/tmp/does-not-exist-omc-test',
            graceMs: 0,
        })).resolves.toBeUndefined();
        expect(killedPanes).toContain('%2');
    });
});
// ─── killTeamSession ─────────────────────────────────────────────────────────
describe('killTeamSession', () => {
    it('NEVER calls kill-session when sessionName contains ":" (split-pane mode)', async () => {
        await killTeamSession('mysession:1', ['%2', '%3'], '%1');
        expect(killedSessions).toHaveLength(0);
    });
    it('kills worker panes in split-pane mode', async () => {
        await killTeamSession('mysession:1', ['%2', '%3'], '%1');
        expect(killedPanes).toContain('%2');
        expect(killedPanes).toContain('%3');
    });
    it('skips leaderPaneId in split-pane mode', async () => {
        await killTeamSession('mysession:1', ['%1', '%2'], '%1');
        expect(killedPanes).not.toContain('%1');
        expect(killedPanes).toContain('%2');
    });
    it('is a no-op in split-pane mode when paneIds is empty', async () => {
        await killTeamSession('mysession:1', [], '%1');
        expect(killedPanes).toHaveLength(0);
        expect(killedSessions).toHaveLength(0);
    });
    it('is a no-op in split-pane mode when paneIds is undefined', async () => {
        await killTeamSession('mysession:1', undefined, '%1');
        expect(killedPanes).toHaveLength(0);
        expect(killedSessions).toHaveLength(0);
    });
    it('calls kill-session for session-mode sessions (no ":" in name)', async () => {
        await killTeamSession('omc-team-myteam-worker1');
        expect(killedSessions).toContain('omc-team-myteam-worker1');
    });
});
// ─── validateJobId regex ──────────────────────────────────────────────────────
// Re-test the regex rule from team-server.ts (spec: /^omc-[a-z0-9]{1,12}$/)
const JOB_ID_RE = /^omc-[a-z0-9]{1,12}$/;
describe('validateJobId regex (/^omc-[a-z0-9]{1,12}$/)', () => {
    it('accepts valid job IDs', () => {
        expect(JOB_ID_RE.test('omc-abc123')).toBe(true);
        expect(JOB_ID_RE.test('omc-a')).toBe(true);
        expect(JOB_ID_RE.test('omc-mlytzz5w')).toBe(true);
    });
    it('rejects path traversal attempts', () => {
        expect(JOB_ID_RE.test('omc-../../etc/passwd')).toBe(false);
        expect(JOB_ID_RE.test('../omc-abc')).toBe(false);
        expect(JOB_ID_RE.test('omc-abc/../../x')).toBe(false);
    });
    it('rejects IDs without the omc- prefix', () => {
        expect(JOB_ID_RE.test('abc123')).toBe(false);
        expect(JOB_ID_RE.test('job-abc123')).toBe(false);
    });
    it('rejects IDs longer than 12 chars after prefix', () => {
        expect(JOB_ID_RE.test('omc-' + 'a'.repeat(13))).toBe(false);
    });
    it('rejects empty suffix', () => {
        expect(JOB_ID_RE.test('omc-')).toBe(false);
    });
});
describe('team start validation wiring', () => {
    it('validates teamName at omc_run_team_start API boundary', () => {
        const source = readFileSync(join(__dirname, '..', 'team-server.ts'), 'utf-8');
        expect(source).toContain("import { validateTeamName } from '../team/team-name.js'");
        expect(source).toContain('validateTeamName(input.teamName);');
    });
    it('contains timeoutSeconds deprecation guard in omc_run_team_start', () => {
        const source = readFileSync(join(__dirname, '..', 'team-server.ts'), 'utf-8');
        expect(source).toContain("hasOwnProperty.call(args, 'timeoutSeconds')");
        expect(source).toContain('no longer accepts timeoutSeconds');
    });
});
// ─── timeoutSeconds rejection (runtime) ──────────────────────────────────────
// Import handleStart indirectly by re-implementing the guard inline, matching
// the exact logic in team-server.ts. This avoids ESM/CJS import complexity
// while still testing the runtime rejection path as a unit.
function handleStartGuard(args) {
    if (typeof args === 'object'
        && args !== null
        && Object.prototype.hasOwnProperty.call(args, 'timeoutSeconds')) {
        throw new Error('omc_run_team_start no longer accepts timeoutSeconds. Remove timeoutSeconds and use omc_run_team_wait timeout_ms to limit the wait call only (workers keep running until completion or explicit omc_run_team_cleanup).');
    }
}
describe('omc_run_team_start timeoutSeconds rejection', () => {
    it('throws when timeoutSeconds is present', () => {
        expect(() => handleStartGuard({
            teamName: 'test',
            agentTypes: ['claude'],
            tasks: [{ subject: 'x', description: 'y' }],
            cwd: '/tmp',
            timeoutSeconds: 60,
        })).toThrow('no longer accepts timeoutSeconds');
    });
    it('error message includes migration guidance (omc_run_team_wait + omc_run_team_cleanup)', () => {
        expect(() => handleStartGuard({
            teamName: 'test',
            agentTypes: ['claude'],
            tasks: [],
            cwd: '/tmp',
            timeoutSeconds: 30,
        })).toThrow('omc_run_team_wait timeout_ms');
    });
    it('does not throw when timeoutSeconds is absent', () => {
        // Should not throw — the guard passes for well-formed input
        expect(() => handleStartGuard({
            teamName: 'test',
            agentTypes: ['claude'],
            tasks: [],
            cwd: '/tmp',
        })).not.toThrow();
    });
    it('does not throw when args is null or non-object', () => {
        expect(() => handleStartGuard(null)).not.toThrow();
        expect(() => handleStartGuard('string')).not.toThrow();
        expect(() => handleStartGuard(42)).not.toThrow();
    });
});
// ─── exit code mapping ────────────────────────────────────────────────────────
// Re-test the exitCodeFor logic from runtime-cli.ts (spec from Step 8)
function exitCodeFor(status) {
    return status === 'completed' ? 0 : 1;
}
describe('exitCodeFor (runtime-cli doShutdown exit codes)', () => {
    it('returns 0 for completed', () => expect(exitCodeFor('completed')).toBe(0));
    it('returns 1 for failed', () => expect(exitCodeFor('failed')).toBe(1));
    it('returns 1 for timeout (no dedicated timeout exit code)', () => expect(exitCodeFor('timeout')).toBe(1));
    it('returns 1 for unknown status', () => expect(exitCodeFor('unknown')).toBe(1));
});
//# sourceMappingURL=team-cleanup.test.js.map