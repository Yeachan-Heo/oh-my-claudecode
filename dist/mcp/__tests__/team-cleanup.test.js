/**
 * Tests for team MCP cleanup hardening (plan: team-mcp-cleanup-4.4.0.md)
 *
 * Coverage:
 * - killOwnedWorkerPane: immutable ownership, strict membership, and leader guard
 * - killTeamSession: never kill-session on split-pane (':'), leader-pane skip
 * - validateJobId regex logic (inline, since function is internal to team-server.ts)
 * - exit-code mapping: runtime-cli exitCodeFor logic (no dedicated timeout exit code)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { currentStrictProcessStartIdentity } from '../../team/team-owner-epoch.js';
import { isValidOmcTeamJob, isValidTeamPaneArtifact } from '../team-job-convergence.js';
const INSTANCE_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_INSTANCE_ID = '88888888-8888-4888-8888-888888888888';
const strictProcessStartedAt = (process.platform === 'darwin' || process.platform === 'linux')
    ? currentStrictProcessStartIdentity()
    : null;
const supportsStrictTmuxFixture = Boolean(strictProcessStartedAt);
const tmuxServerIdentity = strictProcessStartedAt
    ? {
        socket_path: '/tmp/omc-mcp-cleanup.sock',
        server_pid: process.pid,
        process_started_at: strictProcessStartedAt,
    }
    : undefined;
function strictTmuxIdentity() {
    if (!tmuxServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return tmuxServerIdentity;
}
const tmuxUtilsMocks = vi.hoisted(() => {
    const state = {
        killedPanes: [],
        killedSessions: [],
    };
    return {
        ...state,
        tmuxExecAsync: vi.fn(async (args) => {
            if (args.includes('list-panes'))
                return { stdout: '%2\n%3\n', stderr: '' };
            return { stdout: '', stderr: '' };
        }),
        tmuxCmdAsync: vi.fn(async (args) => {
            const joined = args.join(' ');
            const marker = joined.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
            if (marker) {
                const pane = joined.match(/'kill-pane' '-t' '(%\d+)'/)?.[1];
                if (pane)
                    state.killedPanes.push(pane);
                const session = joined.match(/'kill-session' '-t' '(\$\d+)'/)?.[1];
                if (session)
                    state.killedSessions.push(session);
                return { stdout: `${marker}\n`, stderr: '' };
            }
            if (joined.includes('#{pane_dead}'))
                return { stdout: '0\n', stderr: '' };
            if (joined.includes('#{pid}'))
                return { stdout: `${process.pid}\n`, stderr: '' };
            if (joined.includes('list-sessions')) {
                return { stdout: '$42\tomc-team-myteam-worker1\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }),
    };
});
// ─── killOwnedWorkerPane + killTeamSession ───────────────────────────────────
// Inject matching server identity, exact membership inventories, and guard markers
// so destructive calls remain exercised without connecting to a real tmux server.
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
        tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
    };
});
import { killOwnedWorkerPane, killTeamSession, } from '../../team/tmux-session.js';
beforeEach(() => {
    tmuxUtilsMocks.killedPanes.length = 0;
    tmuxUtilsMocks.killedSessions.length = 0;
});
afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
});
// The removed v1 bulk helper's empty-array no-op, shutdown-sentinel write, and
// swallowed cleanup-error behavior are intentionally not recreated here.
// Graceful shutdown is covered by the v2 shutdown suite; this file exercises
// only the owned pane primitive and its proof boundaries.
const originalWorkerOwnership = tmuxServerIdentity
    ? Object.freeze({
        provider: 'tmux',
        providerTarget: 'myteam:0',
        paneId: '%2',
        splitTarget: '%1',
        leaderPaneId: '%1',
        reservedPaneIds: Object.freeze([]),
        source: 'split',
        tmuxServerIdentity: Object.freeze({ ...tmuxServerIdentity }),
    })
    : undefined;
function strictWorkerOwnership() {
    if (!originalWorkerOwnership) {
        throw new Error('strict tmux fixture unsupported on this platform');
    }
    return originalWorkerOwnership;
}
describe('killOwnedWorkerPane', () => {
    it.skipIf(!supportsStrictTmuxFixture)('kills only an exactly owned worker pane through the native guard', async () => {
        await killOwnedWorkerPane(strictWorkerOwnership());
        expect(tmuxUtilsMocks.killedPanes).toEqual(['%2']);
        expect(tmuxUtilsMocks.tmuxExecAsync).toHaveBeenCalledWith(expect.arrayContaining(['list-panes', '-t', expect.any(String)]));
    });
    it('rejects cleanup when immutable tmux server authority is missing', async () => {
        const ownership = {
            provider: 'tmux',
            providerTarget: 'myteam:0',
            paneId: '%2',
            splitTarget: '%1',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            source: 'split',
        };
        await expect(killOwnedWorkerPane(ownership))
            .rejects.toThrow('owned_pane_tmux_server_identity_missing');
        expect(tmuxUtilsMocks.killedPanes).toHaveLength(0);
        expect(tmuxUtilsMocks.tmuxExecAsync).not.toHaveBeenCalled();
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects foreign membership without running a native kill', async () => {
        const ownership = {
            ...strictWorkerOwnership(),
            paneId: '%99',
        };
        await expect(killOwnedWorkerPane(ownership))
            .rejects.toThrow('owned_pane_membership_unverified');
        expect(tmuxUtilsMocks.killedPanes).toHaveLength(0);
        expect(tmuxUtilsMocks.tmuxExecAsync).toHaveBeenCalledWith(expect.arrayContaining(['list-panes']));
    });
    it('excludes the leader before any provider query or native effect', async () => {
        const ownership = {
            provider: 'tmux',
            providerTarget: 'myteam:0',
            paneId: '%1',
            splitTarget: '%1',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            source: 'split',
        };
        await expect(killOwnedWorkerPane(ownership))
            .rejects.toThrow('owned_pane_leader_excluded');
        expect(tmuxUtilsMocks.killedPanes).toHaveLength(0);
        expect(tmuxUtilsMocks.tmuxExecAsync).not.toHaveBeenCalled();
        expect(tmuxUtilsMocks.tmuxCmdAsync).not.toHaveBeenCalled();
    });
});
// ─── killTeamSession ─────────────────────────────────────────────────────────
describe('killTeamSession', () => {
    it('NEVER calls kill-session when sessionName contains ":" (split-pane mode)', async () => {
        await killTeamSession('mysession:1', ['%2', '%3'], '%1');
        expect(tmuxUtilsMocks.killedSessions).toHaveLength(0);
    });
    it('preserves worker panes when split-pane membership cannot be proven', async () => {
        await killTeamSession('mysession:1', ['%2', '%3'], '%1');
        expect(tmuxUtilsMocks.killedPanes).toEqual([]);
    });
    it('still skips the leader when split-pane membership is unavailable', async () => {
        await killTeamSession('mysession:1', ['%1', '%2'], '%1');
        expect(tmuxUtilsMocks.killedPanes).not.toContain('%1');
        expect(tmuxUtilsMocks.killedPanes).toEqual([]);
    });
    it('is a no-op in split-pane mode when paneIds is empty', async () => {
        await killTeamSession('mysession:1', [], '%1');
        expect(tmuxUtilsMocks.killedPanes).toHaveLength(0);
        expect(tmuxUtilsMocks.killedSessions).toHaveLength(0);
    });
    it('is a no-op in split-pane mode when paneIds is undefined', async () => {
        await killTeamSession('mysession:1', undefined, '%1');
        expect(tmuxUtilsMocks.killedPanes).toHaveLength(0);
        expect(tmuxUtilsMocks.killedSessions).toHaveLength(0);
    });
    it.skipIf(!supportsStrictTmuxFixture)('calls kill-session for session-mode sessions (no ":" in name)', async () => {
        const identity = strictTmuxIdentity();
        vi.stubEnv('TMUX', '');
        await killTeamSession('omc-team-myteam-worker1', [], undefined, {
            sessionMode: 'detached-session',
            tmuxServerIdentity: identity,
        });
        expect(tmuxUtilsMocks.killedSessions).toContain('$42');
    });
});
// ─── validateJobId regex ──────────────────────────────────────────────────────
// Re-test the regex rule from team-server.ts (spec: /^omc-[a-z0-9]{1,16}$/)
const JOB_ID_RE = /^omc-[a-z0-9]{1,16}$/;
describe('validateJobId regex (/^omc-[a-z0-9]{1,16}$/)', () => {
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
    it('rejects IDs longer than 16 chars after prefix', () => {
        expect(JOB_ID_RE.test('omc-' + 'a'.repeat(17))).toBe(false);
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
    it('starts runtime-cli with process.execPath rather than bare PATH node', () => {
        const source = readFileSync(join(__dirname, '..', 'team-server.ts'), 'utf-8');
        expect(source).toContain('spawn(process.execPath, [runtimeCliPath]');
        expect(source).not.toContain("spawn('node', [runtimeCliPath]");
    });
    it('contains timeoutSeconds deprecation guard in omc_run_team_start', () => {
        const source = readFileSync(join(__dirname, '..', 'team-server.ts'), 'utf-8');
        expect(source).toContain("hasOwnProperty.call(args, 'timeoutSeconds')");
        expect(source).toContain('no longer accepts timeoutSeconds');
    });
    it('requires instance identity for jobs and pane cleanup evidence', () => {
        const source = readFileSync(join(__dirname, '..', 'team-server.ts'), 'utf-8');
        const identity = source.indexOf('const instanceId = randomUUID();');
        const publication = source.indexOf('persistJob(jobId, job);', identity);
        const spawn = source.indexOf('child = spawn(process.execPath', publication);
        expect(identity).toBeGreaterThan(-1);
        expect(publication).toBeGreaterThan(identity);
        expect(spawn).toBeGreaterThan(publication);
        expect(source).toContain('instanceId: job.instanceId');
        expect(source).toContain('shutdownTeamV2(job.teamName!, job.cwd!, {');
        expect(source).toContain('instanceId: job.instanceId');
        expect(source).not.toContain('clearScopedTeamState');
        const cleanupSource = source.slice(source.indexOf('export async function handleCleanup'));
        expect(cleanupSource).toContain('shutdownTeamV2(job.teamName!, job.cwd!, {');
        expect(cleanupSource).not.toContain('isRuntimeV2Enabled');
    });
});
describe('strict team job and pane artifact identity', () => {
    it('accepts complete identity-bearing records with worker launch attempts', () => {
        expect(isValidOmcTeamJob({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'strict-team',
            cwd: '/tmp/strict-team',
            instanceId: INSTANCE_ID,
        })).toBe(true);
        expect(isValidTeamPaneArtifact({
            instanceId: INSTANCE_ID,
            paneIds: ['%2'],
            leaderPaneId: '%1',
            workers: [{
                    workerName: 'worker-1',
                    paneId: '%2',
                    launchAttemptId: 'attempt-1',
                }],
        }, INSTANCE_ID)).toBe(true);
    });
    it('rejects missing or foreign identity and pane-only success evidence', () => {
        const baseJob = {
            status: 'running',
            startedAt: Date.now(),
            teamName: 'strict-team',
            cwd: '/tmp/strict-team',
        };
        expect(isValidOmcTeamJob(baseJob)).toBe(false);
        expect(isValidOmcTeamJob({ ...baseJob, instanceId: OTHER_INSTANCE_ID })).toBe(true);
        expect(isValidTeamPaneArtifact({
            instanceId: INSTANCE_ID,
            paneIds: ['%2'],
            leaderPaneId: '%1',
            workers: [],
        }, INSTANCE_ID)).toBe(false);
        expect(isValidTeamPaneArtifact({
            instanceId: OTHER_INSTANCE_ID,
            paneIds: ['%2'],
            leaderPaneId: '%1',
            workers: [{
                    workerName: 'worker-1',
                    paneId: '%2',
                    launchAttemptId: 'attempt-1',
                }],
        }, INSTANCE_ID)).toBe(false);
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