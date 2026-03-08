import { describe, expect, it } from 'vitest';
import { buildLegacyTeamDeprecationHint, resolveTeamApiCliCommand, } from '../api-interop.js';
describe('team api command dialect resolution', () => {
    it('defaults to omc team api', () => {
        expect(resolveTeamApiCliCommand({})).toBe('omc team api');
    });
    it('uses omx team api when running in OMX worker context', () => {
        expect(resolveTeamApiCliCommand({
            OMX_TEAM_WORKER: 'demo-team/worker-1',
        })).toBe('omx team api');
        expect(resolveTeamApiCliCommand({
            OMX_TEAM_STATE_ROOT: '/tmp/project/.omx/state',
        })).toBe('omx team api');
    });
    it('prefers omc team api when both contexts are present', () => {
        expect(resolveTeamApiCliCommand({
            OMC_TEAM_WORKER: 'demo-team/worker-1',
            OMX_TEAM_WORKER: 'demo-team/worker-2',
        })).toBe('omc team api');
    });
    it('builds legacy deprecation hint with omx command in OMX context', () => {
        const hint = buildLegacyTeamDeprecationHint('team_claim_task', { team_name: 'demo', task_id: '1', worker: 'worker-1' }, { OMX_TEAM_WORKER: 'demo/worker-1' });
        expect(hint).toContain('Use CLI interop: omx team api claim-task');
    });
});
//# sourceMappingURL=api-interop.command-dialect.test.js.map