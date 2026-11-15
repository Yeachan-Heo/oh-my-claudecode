import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { executeTeamApiOperation } from '../api-interop.js';

const TEAM = 'escalation-team';
const WORKER = 'worker-1';

let cwd: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousOmcStateDir: string | undefined;
let nextTaskId = 1;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'omc-team-escalation-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousOmcStateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  nextTaskId = 1;
  await setupTeam();
});

async function setupTeam(): Promise<void> {
  const dir = join(getOmcRoot(cwd), 'state', 'team', TEAM);
  await mkdir(join(dir, 'tasks'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    name: TEAM,
    task: 'escalation',
    agent_type: 'executor',
    worker_count: 1,
    max_workers: 20,
    workers: [{ name: WORKER, index: 1, role: 'executor', assigned_tasks: [] }],
    created_at: '2026-03-06T00:00:00.000Z',
    next_task_id: 2,
  }, null, 2));
}

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
  await rm(cwd, { recursive: true, force: true });
});

async function createPendingTask(): Promise<string> {
  const id = String(nextTaskId++);
  const dir = join(getOmcRoot(cwd), 'state', 'team', TEAM, 'tasks');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `task-${id}.json`), JSON.stringify({
    id,
    subject: 'Escalation check',
    description: 'Exercise the terminal escalation marker',
    status: 'pending',
    owner: WORKER,
    created_at: new Date().toISOString(),
    version: 1,
  }, null, 2));
  return id;
}

async function claim(taskId: string): Promise<{ claimToken: string }> {
  const result = await executeTeamApiOperation('claim-task', {
    team_name: TEAM,
    task_id: taskId,
    worker: WORKER,
  }, cwd);
  if (!result.ok) throw new Error(`claim-task failed: ${JSON.stringify(result)}`);
  const data = result.data as { ok: boolean; claimToken?: string };
  expect(data.ok).toBe(true);
  return { claimToken: data.claimToken! };
}

async function transition(
  taskId: string,
  claimToken: string,
  to: 'completed' | 'failed',
  terminal: { result?: string; error?: string },
): Promise<{ ok: boolean; error?: string }> {
  const result = await executeTeamApiOperation('transition-task-status', {
    team_name: TEAM,
    task_id: taskId,
    from: 'in_progress',
    to,
    claim_token: claimToken,
    ...terminal,
  }, cwd);
  if (!result.ok) throw new Error(`transition-task-status failed: ${JSON.stringify(result)}`);
  return result.data as { ok: boolean; error?: string };
}

async function readTask(taskId: string): Promise<Record<string, unknown>> {
  const result = await executeTeamApiOperation('read-task', { team_name: TEAM, task_id: taskId }, cwd);
  if (!result.ok) throw new Error(`read-task failed: ${JSON.stringify(result)}`);
  return (result.data as { task: Record<string, unknown> }).task;
}

describe('ESCALATE marker on terminal results', () => {
  const POSITIVE = [
    { name: 'plain lane', result: 'ESCALATE: architecture', lane: 'architecture' },
    { name: 'padded marker and lane', result: '   ESCALATE:   security-review  ', lane: 'security-review' },
    {
      name: 'multi-line, marker on the first line',
      result: 'ESCALATE: missing-data\nDetails: the plan does not choose a library\nResult: stopped before the first edit',
      lane: 'missing-data',
    },
    { name: 'blank lines before the marker', result: '\n \nESCALATE: third-lane\nlater progress', lane: 'third-lane' },
    { name: 'colon inside the lane', result: 'ESCALATE: data: no server address in the plan', lane: 'data: no server address in the plan' },
  ];
  const NEGATIVE = [
    { name: 'marker on the second line', result: 'Starting with a review of the files.\nESCALATE: second-line' },
    { name: 'no marker', result: 'Done. Verification: tests passed.' },
    { name: 'marker without a lane', result: 'ESCALATE:' },
    { name: 'marker with a blank lane', result: 'ESCALATE:   ' },
  ];

  for (const sample of POSITIVE) {
    it(`completed records the escalation: ${sample.name}`, async () => {
      const taskId = await createPendingTask();
      const { claimToken } = await claim(taskId);
      const outcome = await transition(taskId, claimToken, 'completed', { result: sample.result });
      expect(outcome.ok).toBe(true);

      const task = await readTask(taskId);
      expect(task.status).toBe('completed');
      const escalation = task.escalation as { lane: string; source: string; recorded_at: string };
      expect(escalation.lane).toBe(sample.lane);
      expect(escalation.source).toBe('terminal_result');
      expect(Number.isFinite(Date.parse(escalation.recorded_at))).toBe(true);
    });
  }

  for (const sample of NEGATIVE) {
    it(`completed without an escalation leaves the field absent: ${sample.name}`, async () => {
      const taskId = await createPendingTask();
      const { claimToken } = await claim(taskId);
      const outcome = await transition(taskId, claimToken, 'completed', { result: sample.result });
      expect(outcome.ok).toBe(true);

      const task = await readTask(taskId);
      expect(task.status).toBe('completed');
      expect(task.escalation).toBeUndefined();
    });
  }

  it('failed records the escalation from the error text', async () => {
    const taskId = await createPendingTask();
    const { claimToken } = await claim(taskId);
    const outcome = await transition(taskId, claimToken, 'failed', {
      error: '\nESCALATE: missing-source\nThe plan names no data source',
    });
    expect(outcome.ok).toBe(true);

    const task = await readTask(taskId);
    expect(task.status).toBe('failed');
    const escalation = task.escalation as { lane: string; source: string };
    expect(escalation.lane).toBe('missing-source');
    expect(escalation.source).toBe('terminal_result');
  });

  it('failed without a marker in the error text leaves the field absent', async () => {
    const taskId = await createPendingTask();
    const { claimToken } = await claim(taskId);
    const outcome = await transition(taskId, claimToken, 'failed', { error: 'Tests failed: 2 failures' });
    expect(outcome.ok).toBe(true);

    const task = await readTask(taskId);
    expect(task.status).toBe('failed');
    expect(task.escalation).toBeUndefined();
  });
});
