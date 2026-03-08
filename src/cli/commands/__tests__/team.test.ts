import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { teamCommand, parseTeamArgs } from '../team.js';

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
});

describe('parseTeamArgs comma-separated multi-type specs', () => {
  it('parses 1:codex,1:gemini into heterogeneous agentTypes', () => {
    const parsed = parseTeamArgs(['1:codex,1:gemini', 'do the task']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini']);
    expect(parsed.task).toBe('do the task');
  });

  it('parses 2:claude,1:codex:architect with mixed counts and roles', () => {
    const parsed = parseTeamArgs(['2:claude,1:codex:architect', 'design system']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['claude', 'claude', 'codex']);
    expect(parsed.role).toBeUndefined(); // mixed roles -> no single role
    expect(parsed.task).toBe('design system');
  });

  it('sets role when all segments share the same role', () => {
    const parsed = parseTeamArgs(['1:codex:executor,2:gemini:executor', 'run tasks']);
    expect(parsed.workerCount).toBe(3);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini', 'gemini']);
    expect(parsed.role).toBe('executor');
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
    expect(parsed.role).toBe('architect');
  });

  it('supports --json flag with comma-separated specs', () => {
    const parsed = parseTeamArgs(['1:codex,1:gemini', '--json', 'compare']);
    expect(parsed.workerCount).toBe(2);
    expect(parsed.agentTypes).toEqual(['codex', 'gemini']);
    expect(parsed.json).toBe(true);
    expect(parsed.task).toBe('compare');
  });

  it('throws on total count exceeding maximum', () => {
    expect(() => parseTeamArgs(['15:codex,10:gemini', 'big task'])).toThrow('exceeds maximum');
  });
});
