import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { teamCommand, parseTeamArgs, buildStartupTasks, assertTeamSpawnAllowed } from '../team.js';

/** Helper: capture console.log output during a callback */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

/** Helper: init minimal team state on disk */
async function initTeamState(teamName: string, wd: string): Promise<void> {
  const base = join(wd, '.omc', 'state', 'team', teamName);
  await mkdir(join(base, 'tasks'), { recursive: true });
  await mkdir(join(base, 'workers', 'worker-1'), { recursive: true });
  await mkdir(join(base, 'mailbox'), { recursive: true });
  await mkdir(join(base, 'events'), { recursive: true });
  await writeFile(join(base, 'config.json'), JSON.stringify({
    team_name: teamName,
    task: 'test',
    agent_type: 'executor',
    worker_count: 1,
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
    created_at: new Date().toISOString(),
  }));
}

describe('teamCommand help output', () => {
  it('prints team help for --help', async () => {
    const logs = await captureLog(() => teamCommand(['--help']));
    expect(logs[0]).toContain('omc team api <operation>');
  });

  it('prints team help for help alias', async () => {
    const logs = await captureLog(() => teamCommand(['help']));
    expect(logs[0]).toContain('omc team api <operation>');
  });

  it('prints api help for omc team api --help', async () => {
    const logs = await captureLog(() => teamCommand(['api', '--help']));
    expect(logs[0]).toContain('Supported operations');
    expect(logs[0]).toContain('send-message');
    expect(logs[0]).toContain('transition-task-status');
  });

  it('prints operation-specific help for omc team api <op> --help', async () => {
    const logs = await captureLog(() => teamCommand(['api', 'send-message', '--help']));
    expect(logs[0]).toContain('Usage: omc team api send-message');
    expect(logs[0]).toContain('from_worker');
    expect(logs[0]).toContain('to_worker');
  });

  it('prints operation-specific help for omc team api --help <op>', async () => {
    const logs = await captureLog(() => teamCommand(['api', '--help', 'claim-task']));
    expect(logs[0]).toContain('Usage: omc team api claim-task');
    expect(logs[0]).toContain('expected_version');
  });
});

describe('teamCommand api operations', () => {
  let wd: string;
  let previousCwd: string;

  afterEach(async () => {
    if (previousCwd) process.chdir(previousCwd);
    if (wd) await rm(wd, { recursive: true, force: true }).catch(() => {});
    process.exitCode = 0;
  });

  it('returns JSON error for unknown operation with --json', async () => {
    const logs = await captureLog(async () => {
      process.exitCode = 0;
      await teamCommand(['api', 'unknown-op', '--json']);
    });
    const envelope = JSON.parse(logs[0]);
    expect(envelope.schema_version).toBe('1.0');
    expect(envelope.ok).toBe(false);
    expect(envelope.operation).toBe('unknown');
    expect(envelope.error.code).toBe('invalid_input');
  });

  it('executes send-message with stable JSON envelope', async () => {
    wd = await mkdtemp(join(tmpdir(), 'omc-team-cli-'));
    previousCwd = process.cwd();
    process.chdir(wd);
    await initTeamState('cli-test', wd);

    const logs = await captureLog(async () => {
      await teamCommand([
        'api', 'send-message',
        '--input', JSON.stringify({
          team_name: 'cli-test',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ACK',
        }),
        '--json',
      ]);
    });

    const envelope = JSON.parse(logs[0]);
    expect(envelope.schema_version).toBe('1.0');
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('omc team api send-message');
    expect(envelope.data.message.body).toBe('ACK');
  });

  it('supports claim-safe lifecycle: create -> claim -> transition', async () => {
    wd = await mkdtemp(join(tmpdir(), 'omc-team-lifecycle-'));
    previousCwd = process.cwd();
    process.chdir(wd);
    await initTeamState('lifecycle', wd);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      // Create task
      await teamCommand([
        'api', 'create-task',
        '--input', JSON.stringify({
          team_name: 'lifecycle',
          subject: 'Lifecycle task',
          description: 'CLI interop test',
        }),
        '--json',
      ]);
      const created = JSON.parse(logs.at(-1)!);
      expect(created.ok).toBe(true);
      const taskId = created.data.task.id;
      expect(typeof taskId).toBe('string');

      // Claim task
      await teamCommand([
        'api', 'claim-task',
        '--input', JSON.stringify({
          team_name: 'lifecycle',
          task_id: taskId,
          worker: 'worker-1',
        }),
        '--json',
      ]);
      const claimed = JSON.parse(logs.at(-1)!);
      expect(claimed.ok).toBe(true);
      const claimToken = claimed.data.claimToken;
      expect(typeof claimToken).toBe('string');

      // Transition to completed
      await teamCommand([
        'api', 'transition-task-status',
        '--input', JSON.stringify({
          team_name: 'lifecycle',
          task_id: taskId,
          from: 'in_progress',
          to: 'completed',
          claim_token: claimToken,
        }),
        '--json',
      ]);
      const transitioned = JSON.parse(logs.at(-1)!);
      expect(transitioned.ok).toBe(true);
      expect(transitioned.data.task.status).toBe('completed');
    } finally {
      console.log = originalLog;
    }
  });

  it('blocks team start when running inside worker context', async () => {
    const previousWorker = process.env.OMC_TEAM_WORKER;
    try {
      process.env.OMC_TEAM_WORKER = 'demo-team/worker-1';
      const logs = await captureLog(() => teamCommand(['1:executor', 'do work']));
      expect(logs[0]).toContain('omc team [N:agent-type[:role]]');
      expect(process.exitCode).toBe(1);
    } finally {
      process.env.OMC_TEAM_WORKER = previousWorker;
      process.exitCode = 0;
    }
  });

  it('allows nested team spawn only when parent governance enables it', async () => {
    wd = await mkdtemp(join(tmpdir(), 'omc-team-governance-'));
    previousCwd = process.cwd();
    process.chdir(wd);
    const base = join(wd, '.omc', 'state', 'team', 'demo-team');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'manifest.json'), JSON.stringify({
      schema_version: 2,
      name: 'demo-team',
      task: 'test',
      leader: { session_id: 's1', worker_id: 'leader-fixed', role: 'leader' },
      policy: {
        display_mode: 'split_pane',
        worker_launch_mode: 'interactive',
        dispatch_mode: 'hook_preferred_with_fallback',
        dispatch_ack_timeout_ms: 15000,
      },
      governance: {
        delegation_only: true,
        plan_approval_required: false,
        nested_teams_allowed: true,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      permissions_snapshot: {
        approval_mode: 'default',
        sandbox_mode: 'workspace-write',
        network_access: false,
      },
      tmux_session: 'demo-session',
      worker_count: 1,
      workers: [],
      next_task_id: 2,
      created_at: new Date().toISOString(),
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));

    const previousWorker = process.env.OMC_TEAM_WORKER;
    try {
      process.env.OMC_TEAM_WORKER = 'demo-team/worker-1';
      await expect(assertTeamSpawnAllowed(wd, process.env)).resolves.toBeUndefined();
    } finally {
      process.env.OMC_TEAM_WORKER = previousWorker;
    }
  });
});

describe('parseTeamArgs comma-separated multi-type specs', () => {
  it('treats role-only shorthand as claude workers plus a shared role', () => {
    const parsed = parseTeamArgs(['2:executor', 'fix the bug']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['claude', 'claude']);
    expect(parsed.workerSpecs).toEqual([
      { agentType: 'claude', role: 'executor' },
      { agentType: 'claude', role: 'executor' },
    ]);
    expect(parsed.role).toBe('executor');
    expect(parsed.task).toBe('fix the bug');
  });

  it('parses 1:codex,1:gemini into heterogeneous agentTypes', () => {
    const parsed = parseTeamArgs(['1:codex,1:gemini', 'do the task']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini']);
    expect(parsed.workerSpecs).toEqual([{ agentType: 'codex' }, { agentType: 'gemini' }]);
    expect(parsed.task).toBe('do the task');
  });

  it('parses 2:claude,1:codex:architect with mixed counts and roles', () => {
    const parsed = parseTeamArgs(['2:claude,1:codex:architect', 'design system']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['claude', 'claude', 'codex']);
    expect(parsed.workerSpecs).toEqual([
      { agentType: 'claude' },
      { agentType: 'claude' },
      { agentType: 'codex', role: 'architect' },
    ]);
    expect(parsed.role).toBeUndefined(); // mixed roles -> no single role
    expect(parsed.task).toBe('design system');
  });

  it('sets role when all segments share the same role', () => {
    const parsed = parseTeamArgs(['1:codex:executor,2:gemini:executor', 'run tasks']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini', 'gemini']);
    expect(parsed.workerSpecs).toEqual([
      { agentType: 'codex', role: 'executor' },
      { agentType: 'gemini', role: 'executor' },
      { agentType: 'gemini', role: 'executor' },
    ]);
    expect(parsed.role).toBe('executor');
  });

  it('supports mixed explicit cli types and role-only shorthand in comma specs', () => {
    const parsed = parseTeamArgs(['1:executor,1:codex:architect', 'run tasks']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['claude', 'codex']);
    expect(parsed.workerSpecs).toEqual([
      { agentType: 'claude', role: 'executor' },
      { agentType: 'codex', role: 'architect' },
    ]);
    expect(parsed.role).toBeUndefined();
  });

  it('still parses single-type spec 3:codex into uniform agentTypes', () => {
    const parsed = parseTeamArgs(['3:codex', 'fix tests']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['codex', 'codex', 'codex']);
    expect(parsed.task).toBe('fix tests');
  });

  it('defaults to 3 claude workers when no spec is given', () => {
    const parsed = parseTeamArgs(['run all tests']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['claude', 'claude', 'claude']);
    expect(parsed.task).toBe('run all tests');
  });

  it('parses single spec with role correctly', () => {
    const parsed = parseTeamArgs(['2:codex:architect', 'design auth']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['codex', 'codex']);
    expect(parsed.workerSpecs).toEqual([
      { agentType: 'codex', role: 'architect' },
      { agentType: 'codex', role: 'architect' },
    ]);
    expect(parsed.role).toBe('architect');
  });

  it('supports --json and --new-window flags with comma-separated specs', () => {
    const parsed = parseTeamArgs(['1:codex,1:gemini', '--new-window', '--json', 'compare']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini']);
    expect(parsed.json).toBe(true);
    expect(parsed.newWindow).toBe(true);
    expect(parsed.task).toBe('compare');
  });

  it('throws on total count exceeding maximum', () => {
    expect(() => parseTeamArgs(['15:codex,10:gemini', 'big task'])).toThrow('exceeds maximum');
  });
});


describe('buildStartupTasks', () => {
  it('adds owner-aware fanout for explicit per-worker roles', () => {
    const parsed = parseTeamArgs(['1:codex:architect,1:gemini:writer', 'draft launch plan']);
    expect(buildStartupTasks(parsed)).toEqual([
      {
        subject: 'Worker 1 (architect): draft launch plan',
        description: 'draft launch plan',
        owner: 'worker-1',
      },
      {
        subject: 'Worker 2 (writer): draft launch plan',
        description: 'draft launch plan',
        owner: 'worker-2',
      },
    ]);
  });

  it('keeps simple fanout unchanged when no explicit roles are provided', () => {
    const parsed = parseTeamArgs(['2:codex', 'fix tests']);
    expect(buildStartupTasks(parsed)).toEqual([
      { subject: 'Worker 1: fix tests', description: 'fix tests' },
      { subject: 'Worker 2: fix tests', description: 'fix tests' },
    ]);
  });
});
