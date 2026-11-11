import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_GOVERNANCE, DEFAULT_TEAM_TRANSPORT_POLICY, normalizeTeamGovernance, normalizeTeamManifest, } from '../governance.js';
describe('team governance normalization', () => {
    it('lifts legacy governance flags out of policy', () => {
        const manifest = normalizeTeamManifest({
            schema_version: 2,
            name: 'demo',
            task: 'test',
            leader: { session_id: 's1', worker_id: 'leader-fixed', role: 'leader' },
            policy: {
                ...DEFAULT_TEAM_TRANSPORT_POLICY,
                nested_teams_allowed: true,
                delegation_only: true,
            },
            permissions_snapshot: {
                approval_mode: 'default',
                sandbox_mode: 'workspace-write',
                network_access: false,
            },
            tmux_session: 'demo',
            worker_count: 1,
            workers: [],
            next_task_id: 2,
            created_at: new Date().toISOString(),
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        expect(manifest.policy).toEqual(DEFAULT_TEAM_TRANSPORT_POLICY);
        expect(manifest.governance.nested_teams_allowed).toBe(true);
        expect(manifest.governance.delegation_only).toBe(true);
    });
    it('fills missing governance with defaults', () => {
        expect(normalizeTeamGovernance(undefined, undefined)).toEqual(DEFAULT_TEAM_GOVERNANCE);
    });
});
//# sourceMappingURL=governance.test.js.map