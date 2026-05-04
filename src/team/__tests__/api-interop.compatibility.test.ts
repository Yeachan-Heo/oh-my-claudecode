import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTeamApiOperation, LEGACY_TEAM_MCP_TOOLS, resolveTeamApiOperation } from '../api-interop.js';

describe('team api compatibility (task + mailbox legacy formats)', () => {

  it('keeps OMX SSOT legacy orphan-cleanup alias available', () => {
    expect(LEGACY_TEAM_MCP_TOOLS).toContain('team_orphan_cleanup');
    expect(resolveTeamApiOperation('team_orphan_cleanup')).toBe('orphan-cleanup');
  });

  let cwd: string;
  const teamName = 'compat-team';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-compat-'));
    const base = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(join(base, 'tasks'), { recursive: true });
    await mkdir(join(base, 'mailbox'), { recursive: true });
    await mkdir(join(base, 'events'), { recursive: true });
    await writeFile(join(base, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'compat',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      tmux_session: 'test:0',
      next_task_id: 2,
    }, null, 2));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });


  it('resolves long display team names through OMX SSOT identity lookup before validation', async () => {
    const internalName = 'long-display-aaaaaaaa';
    const displayName = 'this-is-a-long-display-name-that-exceeds-thirty-chars';
    const base = join(cwd, '.omc', 'state', 'team', internalName);
    await mkdir(join(base, 'tasks'), { recursive: true });
    await writeFile(join(base, 'manifest.json'), JSON.stringify({
      name: internalName,
      display_name: displayName,
      requested_name: displayName,
      identity_source: 'env-session',
      leader: { session_id: 'session-long' },
      workers: [],
      tmux_session: 'test:0',
      leader_pane_id: '%1',
    }, null, 2));

    const previousSessionId = process.env.OMC_SESSION_ID;
    process.env.OMC_SESSION_ID = 'session-long';
    try {
      const result = await executeTeamApiOperation('list-tasks', { team_name: displayName }, cwd);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.count).toBe(0);
    } finally {
      if (previousSessionId === undefined) delete process.env.OMC_SESSION_ID;
      else process.env.OMC_SESSION_ID = previousSessionId;
    }
  });

  it('reads legacy tasks/1.json and writes canonical task-1.json on claim', async () => {
    const legacyTaskPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', '1.json');
    await writeFile(legacyTaskPath, JSON.stringify({
      id: '1',
      subject: 'Compat task',
      description: 'legacy filename format',
      status: 'pending',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
      version: 1,
    }, null, 2));

    const readResult = await executeTeamApiOperation('read-task', {
      team_name: teamName,
      task_id: '1',
    }, cwd);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;
    const readData = readResult.data as { task?: { id?: string } };
    expect(readData.task?.id).toBe('1');

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);

    const canonicalPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', 'task-1.json');
    expect(existsSync(canonicalPath)).toBe(true);
  });

  it('reads legacy mailbox JSONL and migrates to canonical JSON on mark-notified', async () => {
    const legacyMailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.jsonl');
    await writeFile(legacyMailboxPath, `${JSON.stringify({
      id: 'msg-1',
      from: 'leader-fixed',
      to: 'worker-1',
      body: 'hello',
      createdAt: new Date().toISOString(),
    })}\n`, 'utf-8');

    const listResult = await executeTeamApiOperation('mailbox-list', {
      team_name: teamName,
      worker: 'worker-1',
    }, cwd);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const listData = listResult.data as { count?: number; messages?: Array<{ message_id?: string }> };
    expect(listData.count).toBe(1);
    expect(listData.messages?.[0]?.message_id).toBe('msg-1');

    const markResult = await executeTeamApiOperation('mailbox-mark-notified', {
      team_name: teamName,
      worker: 'worker-1',
      message_id: 'msg-1',
    }, cwd);
    expect(markResult.ok).toBe(true);

    const canonicalMailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.json');
    expect(existsSync(canonicalMailboxPath)).toBe(true);
    const canonicalRaw = await readFile(canonicalMailboxPath, 'utf-8');
    const canonical = JSON.parse(canonicalRaw) as { messages: Array<{ message_id: string; notified_at?: string }> };
    expect(canonical.messages[0]?.message_id).toBe('msg-1');
    expect(typeof canonical.messages[0]?.notified_at).toBe('string');
  });

  it('threads delegation plans through the real team api create-task flow and enforces completion evidence', async () => {
    const created = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Investigate flaky runtime behavior',
      description: 'Investigate flaky runtime behavior across the team runtime',
      owner: 'worker-1',
      delegation: {
        mode: 'auto',
        required_parallel_probe: true,
        skip_allowed_reason_required: true,
      },
    }, cwd);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdData = created.data as { task?: { id?: string; delegation?: { mode?: string; required_parallel_probe?: boolean } } };
    expect(createdData.task?.id).toBe('2');
    expect(createdData.task?.delegation).toMatchObject({
      mode: 'auto',
      required_parallel_probe: true,
    });

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '2',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    const claimData = claimResult.data as { ok?: boolean; claimToken?: string };
    expect(claimData.ok).toBe(true);

    const missing = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '2',
      from: 'in_progress',
      to: 'completed',
      claim_token: claimData.claimToken,
      result: 'Summary: done\nVerification: targeted test',
    }, cwd);

    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    const missingData = missing.data as { ok?: boolean; error?: string };
    expect(missingData.ok).toBe(false);
    expect(missingData.error).toBe('missing_delegation_compliance_evidence');
  });

  it('rejects broad delegated task completion without spawn evidence or skip reason', async () => {
    const taskPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', 'task-1.json');
    await writeFile(taskPath, JSON.stringify({
      id: '1',
      subject: 'Investigate flaky runtime behavior',
      description: 'Search runtime and debug flaky assignment behavior',
      status: 'pending',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
      version: 1,
      delegation: {
        mode: 'auto',
        required_parallel_probe: true,
        skip_allowed_reason_required: true,
      },
    }, null, 2));

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    const claimData = claimResult.data as { ok?: boolean; claimToken?: string };
    expect(claimData.ok).toBe(true);

    const missing = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '1',
      from: 'in_progress',
      to: 'completed',
      claim_token: claimData.claimToken,
      result: 'Verification:\nPASS - focused regression',
    }, cwd);

    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    const missingData = missing.data as { ok?: boolean; error?: string };
    expect(missingData.ok).toBe(false);
    expect(missingData.error).toBe('missing_delegation_compliance_evidence');

    const reread = await executeTeamApiOperation('read-task', {
      team_name: teamName,
      task_id: '1',
    }, cwd);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const rereadData = reread.data as { task?: { status?: string } };
    expect(rereadData.task?.status).toBe('in_progress');
  });

  it('records delegation compliance when broad delegated completion includes spawn evidence', async () => {
    const taskPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', 'task-1.json');
    await writeFile(taskPath, JSON.stringify({
      id: '1',
      subject: 'Investigate flaky runtime behavior',
      description: 'Search runtime and debug flaky assignment behavior',
      status: 'pending',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
      version: 1,
      delegation: {
        mode: 'auto',
        required_parallel_probe: true,
        skip_allowed_reason_required: true,
      },
    }, null, 2));

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    const claimData = claimResult.data as { ok?: boolean; claimToken?: string };
    expect(claimData.ok).toBe(true);

    const completed = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '1',
      from: 'in_progress',
      to: 'completed',
      claim_token: claimData.claimToken,
      result: [
        'Verification:',
        'PASS - focused regression',
        'Subagent spawn evidence: spawned 2 native subagents for runtime map and test probe',
      ].join('\n'),
    }, cwd);

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const completedData = completed.data as {
      ok?: boolean;
      task?: {
        result?: string;
        delegation_compliance?: { status?: string; source?: string; detail?: string };
      };
    };
    expect(completedData.ok).toBe(true);
    expect(completedData.task?.result).toContain('Subagent spawn evidence:');
    expect(completedData.task?.delegation_compliance?.status).toBe('spawned');
    expect(completedData.task?.delegation_compliance?.source).toBe('terminal_result');
    expect(completedData.task?.delegation_compliance?.detail).toContain('spawned 2 native subagents');
  });

  it('accepts documented skip reason when broad delegated task allows skipping', async () => {
    const taskPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', 'task-1.json');
    await writeFile(taskPath, JSON.stringify({
      id: '1',
      subject: 'Review focused regression',
      description: 'Audit one already-isolated failing test',
      status: 'pending',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
      version: 1,
      delegation: {
        mode: 'auto',
        required_parallel_probe: true,
        skip_allowed_reason_required: true,
      },
    }, null, 2));

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    const claimData = claimResult.data as { ok?: boolean; claimToken?: string };
    expect(claimData.ok).toBe(true);

    const completed = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '1',
      from: 'in_progress',
      to: 'completed',
      claim_token: claimData.claimToken,
      result: [
        'Verification:',
        'PASS - focused regression',
        'Subagent skip reason: task scope collapsed to one isolated assertion; spawning would duplicate serial verification',
      ].join('\n'),
    }, cwd);

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const completedData = completed.data as { ok?: boolean; task?: { delegation_compliance?: { status?: string } } };
    expect(completedData.ok).toBe(true);
    expect(completedData.task?.delegation_compliance?.status).toBe('skipped');
  });
});
