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
    shutdownTeamV2: vi.fn(async () => ({ outcome: 'cleaned' })),
}));
vi.mock('../../../team/team-ops.js', async (_importOriginal) => {
    const actual = await vi.importActual('../../../team/team-ops.js');
    return {
        ...actual,
        teamReadManifest: teamCleanupMocks.teamReadManifest,
        teamReadConfig: teamCleanupMocks.teamReadConfig,
    };
});
vi.mock('../../../team/runtime-v2.js', async (_importOriginal) => {
    const actual = await vi.importActual('../../../team/runtime-v2.js');
    return {
        ...actual,
        shutdownTeamV2: teamCleanupMocks.shutdownTeamV2,
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
    const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
    const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
    let tmpDir;
    let previousHome;
    let previousUserProfile;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-team-cleanup-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = tmpDir;
        process.env.USERPROFILE = tmpDir;
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        vi.clearAllMocks();
        teamCleanupMocks.teamReadManifest.mockReset();
        teamCleanupMocks.teamReadConfig.mockReset();
        teamCleanupMocks.shutdownTeamV2.mockReset();
        teamCleanupMocks.teamReadManifest.mockResolvedValue(null);
        teamCleanupMocks.teamReadConfig.mockResolvedValue(null);
        teamCleanupMocks.shutdownTeamV2.mockResolvedValue({ outcome: 'cleaned' });
    });
    it('records missing team config as preserved instead of deleting ownership evidence', async () => {
        const sessionId = 'pid-1632-missing-config';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({
            active: true, session_id: sessionId, team_name: 'missing-config-team', current_phase: 'team-exec',
        }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue(null);
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['missing-config-team'], cleaned: [],
            failed: [{ teamName: 'missing-config-team', error: 'team-shutdown-preserved:config_missing_cleanup_evidence' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('force-shuts down a session-owned runtime-v2 team from session team state', async () => {
        const sessionId = 'pid-1632-v2';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'delivery-team', current_phase: 'team-exec' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader_session_id: sessionId,
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader: { session_id: sessionId },
        });
        await cleanupSessionOwnedTeams(tmpDir, sessionId);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('delivery-team', tmpDir, { instanceId: INSTANCE_A, force: true, timeoutMs: 0 });
    });
    it('records a preserved runtime-v2 shutdown as incomplete cleanup', async () => {
        const sessionId = 'pid-1632-v2-preserved';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'preserved-team' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader_session_id: sessionId,
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader: { session_id: sessionId },
        });
        teamCleanupMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['worker-1'],
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toMatchObject({
            cleaned: [],
            failed: [{ teamName: 'preserved-team', error: 'team-shutdown-preserved:provider_cleanup_unverified' }],
        });
    });
    it('preserves a current foreign replacement when an ending-session name hint is stale', async () => {
        const sessionId = 'pid-1632-session-a';
        const foreignSessionId = 'pid-1632-session-b';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({
            active: true, session_id: sessionId, team_name: 'shared-team', current_phase: 'team-exec',
        }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_B,
            leader_session_id: foreignSessionId,
            workers: [],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_B,
            leader: { session_id: foreignSessionId },
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['shared-team'],
            cleaned: [],
            failed: [{ teamName: 'shared-team', error: 'team-shutdown-preserved:session_owner_mismatch' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('preserves session-owned V2 state when its immutable instance identity is missing', async () => {
        const sessionId = 'pid-1632-missing-instance';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({
            active: true, session_id: sessionId, team_name: 'missing-instance-team', current_phase: 'team-exec',
        }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            leader_session_id: sessionId,
            workers: [],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader: { session_id: sessionId },
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['missing-instance-team'],
            cleaned: [],
            failed: [{ teamName: 'missing-instance-team', error: 'team-shutdown-preserved:instance_identity_missing' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('forwards the captured instance identity when the canonical name is replaced during shutdown', async () => {
        const sessionId = 'pid-1632-captured-instance';
        const teamName = 'replacement-team';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        const configPath = path.join(tmpDir, '.omc', 'state', 'team', teamName, 'config.json');
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({
            active: true, session_id: sessionId, team_name: teamName, current_phase: 'team-exec',
        }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader_session_id: sessionId,
            workers: [],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader: { session_id: sessionId },
        });
        teamCleanupMocks.shutdownTeamV2.mockImplementationOnce(async () => {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                instance_id: INSTANCE_B,
                workers: [],
            }), 'utf-8');
            const manifestPath = path.join(path.dirname(configPath), 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify({
                instance_id: INSTANCE_B,
                leader: { session_id: 'pid-1632-session-b' },
            }), 'utf-8');
            return { outcome: 'cleaned' };
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: [teamName],
            cleaned: [teamName],
            failed: [],
        });
        expect(teamCleanupMocks.teamReadConfig).toHaveBeenCalledTimes(1);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith(teamName, tmpDir, { instanceId: INSTANCE_A, force: true, timeoutMs: 0 });
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toMatchObject({
            instance_id: INSTANCE_B,
            workers: [],
        });
        expect(JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'manifest.json'), 'utf-8'))).toMatchObject({
            instance_id: INSTANCE_B,
            leader: { session_id: 'pid-1632-session-b' },
        });
    });
    it('preserves a legacy runtime team referenced by the ending session', async () => {
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
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['legacy-team'],
            cleaned: [],
            failed: [{ teamName: 'legacy-team', error: 'team-shutdown-preserved:config_cleanup_unsupported' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('preserves a legacy runtime team even when the old shutdown path would report success', async () => {
        const sessionId = 'pid-1632-legacy-failed';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({
            active: true, session_id: sessionId, team_name: 'legacy-failed-team', current_phase: 'team-exec',
        }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            agentTypes: ['codex'], tmuxSession: 'legacy-failed-team:0', leaderPaneId: '%0', tmuxOwnsWindow: false,
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['legacy-failed-team'], cleaned: [],
            failed: [{ teamName: 'legacy-failed-team', error: 'team-shutdown-preserved:config_cleanup_unsupported' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('preserves initial team names when no manifest ownership evidence remains', async () => {
        const sessionId = 'pid-1632-captured';
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId, ['captured-team'])).resolves.toEqual({
            attempted: ['captured-team'],
            cleaned: [],
            failed: [{ teamName: 'captured-team', error: 'team-shutdown-preserved:session_owner_missing' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('rejects unsafe initial team names before invoking cleanup operations', async () => {
        const sessionId = 'pid-1632-unsafe';
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId, ['../../evil', 'bad/name', '..', '', 'safe-team']))
            .resolves.toEqual({
            attempted: ['safe-team'],
            cleaned: [],
            failed: [{ teamName: 'safe-team', error: 'team-shutdown-preserved:session_owner_missing' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('only cleans up manifests owned by the ending session', async () => {
        const sessionId = 'pid-1632-owner';
        const otherSessionId = 'pid-1632-other';
        const teamRoot = path.join(tmpDir, '.omc', 'state', 'team');
        fs.mkdirSync(path.join(teamRoot, 'owned-team'), { recursive: true });
        fs.mkdirSync(path.join(teamRoot, 'other-team'), { recursive: true });
        teamCleanupMocks.teamReadManifest.mockImplementation((async (teamName) => {
            if (teamName === 'owned-team') {
                return { instance_id: INSTANCE_A, leader: { session_id: sessionId } };
            }
            if (teamName === 'other-team') {
                return { instance_id: INSTANCE_B, leader: { session_id: otherSessionId } };
            }
            return null;
        }));
        teamCleanupMocks.teamReadConfig.mockImplementation((async (teamName) => ({
            instance_id: teamName === 'owned-team' ? INSTANCE_A : INSTANCE_B,
            leader_session_id: teamName === 'owned-team' ? sessionId : otherSessionId,
            workers: [{ name: `${teamName}-worker`, pane_id: '%1' }],
        })));
        await cleanupSessionOwnedTeams(tmpDir, sessionId);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledTimes(1);
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('owned-team', tmpDir, { instanceId: INSTANCE_A, force: true, timeoutMs: 0 });
    });
    it('authorizes cleanup from config.leader_session_id even when the manifest still stores a tmux target', async () => {
        const sessionId = 'pid-1632-claude-owner';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'tmux-projected-team', current_phase: 'team-exec' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            leader_session_id: sessionId,
            tmux_session: 'tmux-projected-team:0',
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            tmux_session: 'tmux-projected-team:0',
            leader: { session_id: 'tmux-projected-team:0' },
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['tmux-projected-team'],
            cleaned: ['tmux-projected-team'],
            failed: [],
        });
        expect(teamCleanupMocks.shutdownTeamV2).toHaveBeenCalledWith('tmux-projected-team', tmpDir, { instanceId: INSTANCE_A, force: true, timeoutMs: 0 });
    });
    it('does not treat a tmux session name as Claude-session ownership', async () => {
        const sessionId = 'pid-1632-tmux-is-not-owner';
        const teamSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
        fs.mkdirSync(teamSessionDir, { recursive: true });
        fs.writeFileSync(path.join(teamSessionDir, 'team-state.json'), JSON.stringify({ active: true, session_id: sessionId, team_name: 'tmux-named-team', current_phase: 'team-exec' }), 'utf-8');
        teamCleanupMocks.teamReadConfig.mockResolvedValue({
            instance_id: INSTANCE_A,
            tmux_session: sessionId,
            workers: [{ name: 'worker-1', pane_id: '%1' }],
        });
        teamCleanupMocks.teamReadManifest.mockResolvedValue({
            instance_id: INSTANCE_A,
            tmux_session: sessionId,
            leader: { session_id: sessionId },
        });
        await expect(cleanupSessionOwnedTeams(tmpDir, sessionId)).resolves.toEqual({
            attempted: ['tmux-named-team'],
            cleaned: [],
            failed: [{ teamName: 'tmux-named-team', error: 'team-shutdown-preserved:session_owner_missing' }],
        });
        expect(teamCleanupMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=team-cleanup.test.js.map