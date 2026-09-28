import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtimeV2Mocks = vi.hoisted(() => ({
    isRuntimeV2Enabled: vi.fn(() => true),
    startTeamV2: vi.fn(),
    monitorTeamV2: vi.fn(),
    findActiveTeamsV2: vi.fn(async () => []),
}));
const agentUtilsMocks = vi.hoisted(() => ({
    loadAgentPrompt: vi.fn((role) => `prompt:${role}`),
}));
vi.mock('../../../team/runtime-v2.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isRuntimeV2Enabled: runtimeV2Mocks.isRuntimeV2Enabled,
        startTeamV2: runtimeV2Mocks.startTeamV2,
        monitorTeamV2: runtimeV2Mocks.monitorTeamV2,
        findActiveTeamsV2: runtimeV2Mocks.findActiveTeamsV2,
    };
});
vi.mock('../../../agents/utils.js', () => ({
    loadAgentPrompt: agentUtilsMocks.loadAgentPrompt,
}));
describe('teamCommand role-only shorthand', () => {
    const originalCwd = process.cwd();
    let logSpy;
    let errorSpy;
    beforeEach(() => {
        runtimeV2Mocks.isRuntimeV2Enabled.mockReturnValue(true);
        runtimeV2Mocks.findActiveTeamsV2.mockResolvedValue([]);
        runtimeV2Mocks.startTeamV2.mockResolvedValue({
            teamName: 'fix-the-bug',
            sessionName: 'team-session',
            config: { worker_count: 2 },
        });
        runtimeV2Mocks.monitorTeamV2.mockResolvedValue({
            tasks: { total: 2, pending: 0, in_progress: 2, completed: 0, failed: 0 },
        });
        agentUtilsMocks.loadAgentPrompt.mockImplementation((role) => `prompt:${role}`);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        process.chdir(originalCwd);
        logSpy.mockRestore();
        errorSpy.mockRestore();
        vi.clearAllMocks();
        process.exitCode = 0;
    });
    it('starts `N:claude:executor` without falling through to generic usage', async () => {
        const { teamCommand } = await import('../team.js');
        await teamCommand(['1:claude:executor', 'reply with exactly: PONG']);
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({
            workerCount: 1,
            agentTypes: ['claude'],
            workerRoles: ['executor'],
            roleName: 'executor',
            rolePrompt: 'prompt:executor',
            tasks: [
                {
                    subject: 'reply with exactly: PONG',
                    description: 'reply with exactly: PONG',
                    owner: 'worker-1',
                    role: 'executor',
                },
            ],
        }));
        expect(logSpy).toHaveBeenCalledWith('Team started: fix-the-bug');
        expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Usage: omc team');
    });
    it('surfaces startup failures without appending the generic team usage block', async () => {
        runtimeV2Mocks.startTeamV2.mockRejectedValueOnce(new Error('leader_worktree_dirty: commit or stash changes before launch'));
        const { teamCommand } = await import('../team.js');
        await teamCommand(['1:claude:executor', 'reply with exactly: PONG']);
        expect(errorSpy).toHaveBeenCalledWith('leader_worktree_dirty: commit or stash changes before launch');
        expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Usage: omc team');
        expect(process.exitCode).toBe(1);
    });
    it('routes `N:executor` through claude agent types plus executor worker roles', async () => {
        const { teamCommand } = await import('../team.js');
        await teamCommand(['2:executor', 'fix the bug']);
        expect(agentUtilsMocks.loadAgentPrompt).toHaveBeenCalledWith('executor');
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({
            workerCount: 2,
            agentTypes: ['claude', 'claude'],
            workerRoles: ['executor', 'executor'],
            roleName: 'executor',
            rolePrompt: 'prompt:executor',
            tasks: [
                { subject: 'Worker 1 (executor): fix the bug', description: 'fix the bug', owner: 'worker-1', role: 'executor' },
                { subject: 'Worker 2 (executor): fix the bug', description: 'fix the bug', owner: 'worker-2', role: 'executor' },
            ],
        }));
    });
    it('threads broad-task delegation evidence guards through teamCommand startup', async () => {
        const { teamCommand } = await import('../team.js');
        await teamCommand(['2:codex', 'investigate flaky runtime behavior']);
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({
            workerCount: 2,
            agentTypes: ['codex', 'codex'],
            tasks: [
                expect.objectContaining({
                    subject: 'Worker 1: investigate flaky runtime behavior',
                    description: 'investigate flaky runtime behavior',
                    owner: 'worker-1',
                    delegation: expect.objectContaining({
                        mode: 'auto',
                        required_parallel_probe: true,
                        skip_allowed_reason_required: true,
                    }),
                }),
                expect.objectContaining({
                    subject: 'Worker 2: investigate flaky runtime behavior',
                    description: 'investigate flaky runtime behavior',
                    owner: 'worker-2',
                    delegation: expect.objectContaining({
                        mode: 'auto',
                        required_parallel_probe: true,
                        skip_allowed_reason_required: true,
                    }),
                }),
            ],
        }));
    });
});
//# sourceMappingURL=team-role-shorthand.test.js.map