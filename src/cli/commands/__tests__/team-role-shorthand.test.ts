import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runtimeV2Mocks = vi.hoisted(() => ({
  isRuntimeV2Enabled: vi.fn(() => true),
  startTeamV2: vi.fn(),
  monitorTeamV2: vi.fn(),
  findActiveTeamsV2: vi.fn(async () => []),
}));

const agentUtilsMocks = vi.hoisted(() => ({
  loadAgentPrompt: vi.fn((role: string) => `prompt:${role}`),
}));

vi.mock('../../../team/runtime-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../team/runtime-v2.js')>();
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
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string | undefined;

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
    agentUtilsMocks.loadAgentPrompt.mockImplementation((role: string) => `prompt:${role}`);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    logSpy.mockRestore();
    vi.clearAllMocks();
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
        { subject: 'Worker 1: fix the bug', description: 'fix the bug', owner: 'worker-1' },
        { subject: 'Worker 2: fix the bug', description: 'fix the bug', owner: 'worker-2' },
      ],
    }));
  });

  it('caps active workers from existing team.ops.maxAgents without dropping atomic backlog', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-team-max-agents-command-'));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'omc.jsonc'), JSON.stringify({
      team: { ops: { maxAgents: 2 } },
    }));
    process.chdir(tempDir);

    const { teamCommand } = await import('../team.js');

    await teamCommand(['4:codex', 'review the system']);

    expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({
      workerCount: 2,
      agentTypes: ['codex', 'codex'],
      tasks: [
        { subject: 'Worker 1: review the system', description: 'review the system', owner: 'worker-1' },
        { subject: 'Worker 2: review the system', description: 'review the system', owner: 'worker-2' },
        { subject: 'Worker 3: review the system', description: 'review the system', owner: 'worker-1' },
        { subject: 'Worker 4: review the system', description: 'review the system', owner: 'worker-2' },
      ],
    }));
  });

  it('caps active workers from existing team.ops.maxAgents without dropping decomposed subtasks', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-team-max-agents-decomposed-'));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'omc.jsonc'), JSON.stringify({
      team: { ops: { maxAgents: 2 } },
    }));
    process.chdir(tempDir);

    const { teamCommand } = await import('../team.js');

    await teamCommand(['4:codex', 'fix auth and fix billing and fix search and fix docs']);

    expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({
      workerCount: 2,
      agentTypes: ['codex', 'codex'],
      tasks: [
        { subject: 'fix auth', description: 'fix auth', owner: 'worker-1' },
        { subject: 'fix billing', description: 'fix billing', owner: 'worker-2' },
        { subject: 'fix search', description: 'fix search', owner: 'worker-1' },
        { subject: 'fix docs', description: 'fix docs', owner: 'worker-2' },
      ],
    }));
  });
});
