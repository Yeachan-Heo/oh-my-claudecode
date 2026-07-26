import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('../callbacks.js', () => ({
    triggerStopCallbacks: vi.fn(async () => undefined),
}));
vi.mock('../../../notifications/index.js', () => ({
    notify: vi.fn(async () => undefined),
}));
vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
    cleanupBridgeSessions: vi.fn(async () => ({
        requestedSessions: 0,
        foundSessions: 0,
        terminatedSessions: 0,
        errors: [],
    })),
}));
const teamCleanupMocks = vi.hoisted(() => ({
    teamReadManifest: vi.fn(async () => null),
    teamReadConfig: vi.fn(async () => null),
    teamCleanup: vi.fn(async () => undefined),
    shutdownTeamV2: vi.fn(async () => undefined),
    shutdownTeam: vi.fn(async () => undefined),
}));
vi.mock('../../../team/team-ops.js', async (_importOriginal) => {
    const actual = await vi.importActual('../../../team/team-ops.js');
    return {
        ...actual,
        teamReadManifest: teamCleanupMocks.teamReadManifest,
        teamReadConfig: teamCleanupMocks.teamReadConfig,
        teamCleanup: teamCleanupMocks.teamCleanup,
    };
});
vi.mock('../../../team/runtime-v2.js', async (_importOriginal) => {
    const actual = await vi.importActual('../../../team/runtime-v2.js');
    return {
        ...actual,
        shutdownTeamV2: teamCleanupMocks.shutdownTeamV2,
    };
});
vi.mock('../../../team/runtime.js', async (_importOriginal) => {
    const actual = await vi.importActual('../../../team/runtime.js');
    return {
        ...actual,
        shutdownTeam: teamCleanupMocks.shutdownTeam,
    };
});
vi.mock('../../../lib/worktree-paths.js', async () => {
    const actual = await vi.importActual('../../../lib/worktree-paths.js');
    return {
        ...actual,
        resolveToWorktreeRoot: vi.fn((dir) => dir ?? process.cwd()),
    };
});
import { cleanupSessionOwnedTeams } from '../index.js';
describe('processSessionEnd team cleanup (#1632)', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-team-cleanup-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
        teamCleanupMocks.teamReadManifest.mockReset();
        teamCleanupMocks.teamReadConfig.mockReset();
        teamCleanupMocks.teamCleanup.mockReset();
        teamCleanupMocks.shutdownTeamV2.mockReset();
        teamCleanupMocks.shutdownTeam.mockReset();
        teamCleanupMocks.teamReadManifest.mockResolvedValue(null);
        teamCleanupMocks.teamReadConfig.mockResolvedValue(null);
        teamCleanupMocks.teamCleanup.mockResolvedValue(undefined);
        teamCleanupMocks.shutdownTeamV2.mockResolvedValue(undefined);
        teamCleanupMocks.shutdownTeam.mockResolvedValue(undefined);
    });
    it('force-shuts down a session-owned runtime-v2 team from session team state', async () => {
        const sessionId = 'pid-1632-v2';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'delivery-team', current_phase: 'team-exec' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        await cleanupSessionOwnedTeams(tmpDir, sessionId);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('delivery-team', tmpDir, { force: true, timeoutMs: 0 });
        expect(teamCleanupMocks.shutdownTeam).not.toHaveBeenCalled();
    });
    it('force-shuts down a legacy runtime team referenced by the ending session', async () => {
        const sessionId = 'pid-1632-legacy';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'legacy-team', current_phase: 'team-exec' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            agentTypes: ['codex'],
            tmuxSession: 'legacy-team:0',
            leaderPaneId: '%0',
            tmuxOwnsWindow: false,
        });
        await cleanupSessionOwnedTeams(tmpDir, sessionId);
        expect(teamCleanupMocks.shutdownTeam).toHaveBeenCalledWith('legacy-team', 'legacy-team:0', tmpDir, 0, undefined, '%0', false);
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('uses initial team names when session-scoped mode state has already been deleted', async () => {
        const sessionId = 'pid-1632-captured';
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        await cleanupSessionOwnedTeams(tmpDir, sessionId, ['captured-team']);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('captured-team', tmpDir, { force: true, timeoutMs: 0 });
    });
    it('rejects unsafe initial team names before invoking cleanup operations', async () => {
        const sessionId = 'pid-1632-unsafe';
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        await cleanupSessionOwnedTeams(tmpDir, sessionId, ['../../evil', 'bad/name', '..', '', 'safe-team']);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledTimes(1);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('safe-team', tmpDir, { force: true, timeoutMs: 0 });
    });
    it('only cleans up manifests owned by the ending session', async () => {
        const sessionId = 'pid-1632-owner';
        const otherSessionId = 'pid-1632-other';
        const teamRoot = path.join(tmpDir, '.omc', 'state', 'team');
        fs.mkdirSync(path.join(teamRoot, 'owned-team'), { recursive: true });
        fs.mkdirSync(path.join(teamRoot, 'other-team'), { recursive: true });
        teamCleanupMocks.teamReadManifest.mockImplementation((async (teamName) => {
            if (teamName === 'owned-team') {
                return { leader: { session_id: sessionId } };
            }
            if (teamName === 'other-team') {
                return { leader: { session_id: otherSessionId } };
            }
            return null;
        }));
        teamCleanupMocks.teamReadConfig.mockImplementation((async (teamName) => ({
            workers: [{ name: `${teamName}-worker`, pane_id: '%1' }],
        })));
        await cleanupSessionOwnedTeams(tmpDir, sessionId);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledTimes(1);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('owned-team', tmpDir, { force: true, timeoutMs: 0 });
    });
});
//# sourceMappingURL=team-cleanup.test.js.map