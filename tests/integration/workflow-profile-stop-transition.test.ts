import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdapterById } from '../../src/hooks/autopilot/adapters/index.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../src/hooks/autopilot/pipeline-types.js';


const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pluginHook = join(root, 'scripts', 'persistent-mode.mjs');
const created = [];
const symlinkIt = process.platform === 'win32' ? it.skip : it;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const workflowTask = 'ship the release';
function expectedStagePrompt(stage) {
  return getAdapterById(stage).getPrompt({
    idea: workflowTask,
    directory: '.',
    config: DEFAULT_PIPELINE_CONFIG,
  });
}

function liveLockOwner() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() });
}

function abandonedLockOwner() {
  return JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() });
}


function fixture(kind) {
  const dir = mkdtempSync(join(tmpdir(), `workflow-profile-${kind}-`));
  created.push(dir);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  const sessionId = 'workflow-session';
  const claudeConfigDir = join(home, 'custom-claude-config');
  const transcript = join(claudeConfigDir, 'projects', `${sessionId}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(transcript, '');
  const statePath = join(project, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
  mkdirSync(dirname(statePath), { recursive: true });

  let hook = pluginHook;
  if (kind === 'installed-template') {
    const hooks = join(dir, 'installed-hooks');
    cpSync(join(root, 'templates', 'hooks'), hooks, { recursive: true });
    hook = join(hooks, 'persistent-mode.mjs');
  }
  return { dir, home, claudeConfigDir, project, sessionId, transcript, statePath, hook };
}

function transcriptIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  const content = readFileSync(path);
  return { device: Number(stat.dev), inode: Number(stat.ino), size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), contentSha256: createHash('sha256').update(content).digest('hex') };
}

function workflowState(f, stages = ['ralplan', 'execution']) {
  const now = new Date().toISOString();
  return {
    active: true,
    mode: 'autopilot',
    prompt: workflowTask,
    phase: stages[0],
    directory: f.project,
    project_path: f.project,
    session_id: f.sessionId,
    workflowRunId: '11111111-1111-4111-8111-111111111111',
    started_at: now,
    updated_at: now,
    last_checked_at: now,
    workflow: (() => {
      const descriptor = { descriptorVersion: 1, workflowName: 'release-flow', profileVersion: 1, stages };
      return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') };
    })(),
    pipelineTracking: {
      stages: stages.map((id, index) => ({ id, status: index === 0 ? 'active' : 'pending', iterations: 0, ...(index === 0 ? { startedAt: now } : {}) })),
      currentStageIndex: 0,
      trackingRevision: 0,
      activationBoundary: { transcriptPath: f.transcript, transcriptRoot: join(f.claudeConfigDir, 'projects'), transcriptBasename: `${f.sessionId}.jsonl`, sessionId: f.sessionId, byteOffset: 0, fileIdentity: transcriptIdentity(f.transcript) },
      completionObservations: [],
    },
  };
}

function writeState(f, state) {
  writeFileSync(f.statePath, JSON.stringify(state, null, 2));
}

function readState(f) {
  return JSON.parse(readFileSync(f.statePath, 'utf8'));
}

function expectStateExceptLiveness(actual, expected) {
  const strip = (state) => {
    const copy = structuredClone(state);
    delete copy.last_checked_at;
    delete copy.updated_at;
    return copy;
  };
  expect(strip(actual)).toEqual(strip(expected));
  expect(Date.parse(actual.last_checked_at)).toBeGreaterThanOrEqual(Date.parse(expected.last_checked_at));
  expect(Date.parse(actual.updated_at)).toBeGreaterThanOrEqual(Date.parse(expected.updated_at));
}

function appendRecord(f, record) {
  const role = record?.message?.role;
  const type = record?.type ?? (role === 'assistant' || role === 'user' ? role : undefined);
  const message = role === 'assistant' && typeof record.message.content === 'string'
    ? { ...record.message, content: [{ type: 'text', text: record.message.content }] }
    : record.message;
  writeFileSync(f.transcript, `${JSON.stringify({ sessionId: f.sessionId, ...(type ? { type } : {}), ...record, ...(message ? { message } : {}) })}\n`, { flag: 'a' });
}

function appendRawRecord(f, record) {
  writeFileSync(f.transcript, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

function invoke(f, input = {}, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [f.hook], {
    cwd: f.project,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: f.sessionId, cwd: f.project, transcript_path: f.transcript, ...input }),
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: f.claudeConfigDir, OMC_PERSISTENT_MODE_TIMEOUT_MS: '3000', ...extraEnv },
  });
  return JSON.parse(stdout.trim());
}

function invokeAsync(f, input = {}, extraEnv = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [f.hook], {
      cwd: f.project,
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: f.claudeConfigDir, OMC_PERSISTENT_MODE_TIMEOUT_MS: '3000', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`persistent-mode exited ${code}: ${stderr}`));
      else resolveResult(JSON.parse(stdout.trim()));
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: f.sessionId, cwd: f.project, transcript_path: f.transcript, ...input }));
  });
}


function completion(stage) {
  return `Signal: PIPELINE_${stage.toUpperCase()}_COMPLETE`;
}

const workflowIntegrityFailure = { continue: false, decision: 'block', reason: '[AUTOPILOT WORKFLOW] workflow_descriptor_integrity_failed. Run /cancel and re-invoke the workflow.' };

afterEach(() => {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
});

describe.each(['plugin', 'installed-template'])('workflow profile stop transition (%s)', (kind) => {
  it.each([
    ['ralplan,execution', ['ralplan', 'execution']],
    ['ralplan,execution,ralph', ['ralplan', 'execution', 'ralph']],
    ['ralplan,execution,qa', ['ralplan', 'execution', 'qa']],
    ['ralplan,execution,ralph,qa', ['ralplan', 'execution', 'ralph', 'qa']],
  ])('dispatches every selected stage exactly once for %s', (_name, stages) => {
    const f = fixture(kind);
    writeState(f, workflowState(f, stages));
    const initial = readState(f);
    expect(invoke(f).reason).toBe(expectedStagePrompt(stages[0]));
    expect(readState(f)).toMatchObject({ ...initial, last_checked_at: expect.any(String), updated_at: expect.any(String) });

    for (let index = 0; index < stages.length; index += 1) {
      appendRecord(f, { message: { role: 'assistant', content: completion(stages[index]) } });
      const result = invoke(f);
      const state = readState(f);
      expect(state.pipelineTracking.trackingRevision).toBe(index + 1);
      if (index + 1 < stages.length) {
        expect(result.reason).toBe(expectedStagePrompt(stages[index + 1]));
        expect(invoke(f).reason).toBe(expectedStagePrompt(stages[index + 1]));
        expect(readState(f).pipelineTracking).toMatchObject({ currentStageIndex: index + 1, trackingRevision: index + 1 });
      } else {
        expect(result.reason).toBe('[AUTOPILOT WORKFLOW] All selected stages are complete.');
        expect(state.active).toBe(false);
        expect(state.phase).toBe('complete');
      }
    }
  });
  it('advances on a post-activation assistant signal, records redacted observation metadata, and emits the next prompt', () => {
    const f = fixture(kind);
    appendRecord(f, { message: { role: 'assistant', content: 'PIPELINE_RALPLAN_COMPLETE before activation' } });
    const initial = workflowState(f);
    initial.pipelineTracking.activationBoundary.byteOffset = readFileSync(f.transcript).byteLength;
    initial.pipelineTracking.activationBoundary.fileIdentity = transcriptIdentity(f.transcript);
    writeState(f, initial);
    appendRecord(f, { message: { role: 'assistant', content: 'unrelated secret-token-never-in-output' } });
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });

    const result = invoke(f);
    const state = readState(f);
    expect(result.reason).toBe(expectedStagePrompt('execution'));
    expect(JSON.stringify(result)).not.toContain('secret-token-never-in-output');
    expect(JSON.stringify(result)).not.toContain(f.transcript);
    expect(state.phase).toBe('execution');
    expect(state.pipelineTracking).toMatchObject({ currentStageIndex: 1, trackingRevision: 1 });
    expect(state.pipelineTracking.completionObservations).toEqual([expect.objectContaining({
      stageId: 'ralplan', sessionId: f.sessionId, signalId: 'PIPELINE_RALPLAN_COMPLETE', byteOffset: initial.pipelineTracking.activationBoundary.byteOffset + Buffer.byteLength(JSON.stringify({ sessionId: f.sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated secret-token-never-in-output' }] } })) + 1,
      lineNumber: 1, recordContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/), stableFile: expect.objectContaining({ device: expect.any(Number), inode: expect.any(Number), size: expect.any(Number) }), activationBoundary: expect.objectContaining({ sessionId: f.sessionId, transcriptBasename: `${f.sessionId}.jsonl` }), observedAt: expect.any(String),
    })]);
  });

  it('refreshes the boundary for each next stage so earlier signals cannot be replayed', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });

    expect(invoke(f).reason).toBe(expectedStagePrompt('execution'));
    const advanced = readState(f);
    expect(advanced.pipelineTracking.activationBoundary.byteOffset).toBe(readFileSync(f.transcript).byteLength);
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('execution') });
    expect(readState(f).pipelineTracking).toMatchObject({ currentStageIndex: 1, trackingRevision: 1 });

    appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });
    expect(invoke(f).reason).toContain('All selected stages are complete');
  });

  it('marks the final selected stage complete and remains idempotent on duplicate replay', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    expect(invoke(f).reason).toBe(expectedStagePrompt('execution'));
    appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });

    expect(invoke(f).reason).toContain('All selected stages are complete');
    const completed = readState(f);
    expect(completed).toMatchObject({ active: false, phase: 'complete' });
    expect(completed.pipelineTracking.trackingRevision).toBe(2);
    expect(completed.pipelineTracking.activationBoundary.byteOffset).toBe(readFileSync(f.transcript).byteLength);
    expect(invoke(f)).toEqual({ continue: true, suppressOutput: true });
    expect(readState(f)).toEqual(completed);
  });

  it('allows concurrent duplicate stops to commit only one revision', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const results = await Promise.all([invokeAsync(f), invokeAsync(f)]);
    const state = readState(f);
    expect(state.pipelineTracking.trackingRevision).toBe(1);
    expect(state.pipelineTracking.currentStageIndex).toBe(1);
    expect(state.pipelineTracking.completionObservations).toHaveLength(1);
    expect(results.map(result => result.reason)).toEqual([
      expectedStagePrompt('execution'),
      expectedStagePrompt('execution'),
    ]);
  });

  it('recovers an abandoned lock before Stop advancement', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    writeFileSync(`${f.statePath}.mutation.lock`, abandonedLockOwner());

    expect(invoke(f).reason).toBe(expectedStagePrompt('execution'));
    expect(readState(f).pipelineTracking.trackingRevision).toBe(1);
  });

  it('ignores a same-session cancel signal targeting a replaced workflow run', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    const signalPath = join(dirname(f.statePath), 'cancel-signal-state.json');
    writeFileSync(signalPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      source: 'state_clear',
      requested_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      target_workflow_run_id: '22222222-2222-4222-8222-222222222222',
    }));

    expect(invoke(f).reason).toBe(expectedStagePrompt('ralplan'));
    expect(readState(f).workflowRunId).toBe(state.workflowRunId);
  });

  it('honors an exact same-run cancel signal for a named workflow', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    const signalPath = join(dirname(f.statePath), 'cancel-signal-state.json');
    writeFileSync(signalPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      source: 'state_clear',
      requested_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      target_workflow_run_id: state.workflowRunId,
      target_state_sha256: createHash('sha256').update(JSON.stringify(readState(f))).digest('hex'),
    }));

    expect(invoke(f)).toEqual({ continue: true, suppressOutput: true });
    expect(readState(f)).toEqual(state);
  });

  it('ignores expired and forged same-run cancel signals for named workflows', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    const signalPath = join(dirname(f.statePath), 'cancel-signal-state.json');
    const expired = {
      active: true,
      mode: 'autopilot',
      requested_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() - 30_000).toISOString(),
      target_workflow_run_id: state.workflowRunId,
      source: 'state_clear',
    };
    writeFileSync(signalPath, JSON.stringify(expired));

    expect(invoke(f).reason).toBe(expectedStagePrompt('ralplan'));
    expect(existsSync(signalPath)).toBe(false);

    const forged = {
      ...expired,
      requested_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      target_state_sha256: '0'.repeat(64),
    };
    writeFileSync(signalPath, JSON.stringify(forged));
    expect(invoke(f).reason).toBe(expectedStagePrompt('ralplan'));
  });

  it('requires an exact state digest for active legacy cancel signals', () => {
    const f = fixture(kind);
    const now = new Date().toISOString();
    const legacy = { active: true, phase: 'planning', session_id: f.sessionId, project_path: f.project, started_at: now, updated_at: now, last_checked_at: now };
    const signalPath = join(dirname(f.statePath), 'cancel-signal-state.json');
    const signal = (target_state_sha256?: string) => ({ active: true, mode: 'autopilot', source: 'state_clear', requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString(), ...(target_state_sha256 ? { target_state_sha256 } : {}) });

    writeState(f, legacy);
    writeFileSync(signalPath, JSON.stringify(signal()));
    expect(invoke(f).reason).toContain('[AUTOPILOT - Phase: planning]');

    writeState(f, legacy);
    writeFileSync(signalPath, JSON.stringify(signal('0'.repeat(64))));
    expect(invoke(f).reason).toContain('[AUTOPILOT - Phase: planning]');

    writeState(f, legacy);
    writeFileSync(signalPath, JSON.stringify(signal(createHash('sha256').update(JSON.stringify(readState(f))).digest('hex'))));
    expect(invoke(f)).toEqual({ continue: true, suppressOutput: true });
  });

  it('fails closed when a named workflow is missing tracking state', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    delete state.pipelineTracking;
    delete state.phase;
    state.prompt = '/autopilot';
    writeState(f, state);

    expect(invoke(f)).toEqual(workflowIntegrityFailure);
  });

  it('fails closed when a commit-loser reread has corrupt named tracking', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));
    const corrupt = workflowState(f);
    delete corrupt.pipelineTracking;
    writeState(f, corrupt);
    const corruptBytes = readFileSync(f.statePath);
    unlinkSync(lockPath);

    expect(await pending).toEqual(workflowIntegrityFailure);
    expect(readFileSync(f.statePath)).toEqual(corruptBytes);
  });

  it('refreshes named workflow liveness when an active stage redispatches after two hours', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    const stale = new Date(Date.now() - (2 * 60 * 60 * 1000) - 1_000).toISOString();
    state.last_checked_at = stale;
    state.updated_at = stale;
    state.started_at = stale;
    writeState(f, state);

    expect(invoke(f).reason).toBe(expectedStagePrompt('ralplan'));
    const refreshed = readState(f);
    expect(new Date(refreshed.last_checked_at).getTime()).toBeGreaterThan(new Date(stale).getTime());
    expect(new Date(refreshed.updated_at).getTime()).toBeGreaterThan(new Date(stale).getTime());
    expect(refreshed.pipelineTracking).toMatchObject({ currentStageIndex: 0, trackingRevision: 0 });
  });

  it('does not mutate or redispatch named workflow Stop after runtime support is lost', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    const before = readFileSync(f.statePath);
    expect(invoke(f, {}, { NODE_ENV: 'test', OMC_WORKFLOW_TEST_FLOCK_AVAILABLE: '0' })).toMatchObject({ continue: true, suppressOutput: true });
    expect(readFileSync(f.statePath)).toEqual(before);
  });

  it('honors cancellation beside an already-loaded global fallback without recreating it', async () => {
    const f = fixture(kind);
    rmSync(f.statePath, { force: true });
    const globalPath = join(f.home, '.omc', 'state', 'autopilot-state.json');
    mkdirSync(dirname(globalPath), { recursive: true });
    const globalState = { active: true, mode: 'autopilot', phase: 'execution', prompt: workflowTask, project_path: f.project, session_id: f.sessionId, workflowRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', execution: { files_created: [], files_modified: [], current_task: 'ship' } };
    const snapshot = JSON.stringify(globalState);
    writeFileSync(globalPath, snapshot);
    const signalPath = join(dirname(globalPath), 'cancel-signal-state.json');
    writeFileSync(`${signalPath}.mutation.lock`, liveLockOwner());

    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 150));
    const now = Date.now();
    writeFileSync(signalPath, JSON.stringify({ active: true, requested_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString(), mode: 'autopilot', source: 'state_clear', target_workflow_run_id: globalState.workflowRunId, target_state_sha256: createHash('sha256').update(snapshot).digest('hex') }));
    unlinkSync(globalPath);
    unlinkSync(`${signalPath}.mutation.lock`);

    expect(await pending).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(globalPath)).toBe(false);
  });

  it('preserves a concurrent named workflow transition rather than returning a stale stage prompt', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));
    const replacement = workflowState(f);
    replacement.phase = 'execution';
    replacement.pipelineTracking.currentStageIndex = 1;
    replacement.pipelineTracking.trackingRevision = 1;
    replacement.pipelineTracking.stages = [
      { id: 'ralplan', status: 'complete', iterations: 0, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'execution', status: 'active', iterations: 0, startedAt: new Date().toISOString() },
    ];
    writeState(f, replacement);
    const replacementBytes = readFileSync(f.statePath);
    unlinkSync(lockPath);

    const result = await pending;
    if (result.continue === true) {
      expect(result).toEqual({ continue: true, suppressOutput: true });
      expect(readFileSync(f.statePath)).toEqual(replacementBytes);
    } else {
      expect(result).toMatchObject(workflowIntegrityFailure);
      expectStateExceptLiveness(readState(f), JSON.parse(replacementBytes.toString('utf8')));
    }
  });

  it.each([
    ['pre-activation', () => undefined],
    ['user signal', (f) => appendRecord(f, { message: { role: 'user', content: completion('ralplan') } })],
    ['tool signal', (f) => appendRecord(f, { role: 'tool', content: completion('ralplan') })],
    ['echoed assistant signal', (f) => appendRecord(f, { isMeta: true, message: { role: 'assistant', content: completion('ralplan') } })],
    ['replayed assistant signal', (f) => appendRecord(f, { isReplay: true, message: { role: 'assistant', content: completion('ralplan') } })],
    ['wrong stage', (f) => appendRecord(f, { message: { role: 'assistant', content: completion('execution') } })],
    ['stdout echo', (f) => appendRecord(f, { message: { role: 'assistant', content: `<local-command-stdout>${completion('ralplan')}</local-command-stdout>` } })],
    ['non-exact signal', (f) => appendRecord(f, { message: { role: 'assistant', content: `${completion('ralplan')} trailing text` } })],
    ['wrong record session', (f) => appendRecord(f, { sessionId: 'other-session', message: { role: 'assistant', content: completion('ralplan') } })],
    ['malformed transcript', (f) => writeFileSync(f.transcript, '{not-json}\n')],
    ['leading blank record', (f) => { writeFileSync(f.transcript, '\n'); appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } }); }],
    ['embedded blank record', (f) => { appendRecord(f, { message: { role: 'assistant', content: 'unrelated' } }); writeFileSync(f.transcript, '\n', { flag: 'a' }); appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } }); }],
    ['repeated terminal newline', (f) => { appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } }); writeFileSync(f.transcript, '\n', { flag: 'a' }); }],
  ])('rejects %s without advancing profile state', (_name, append) => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    append(f);
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') });
    expect(readState(f)).toMatchObject({ ...state, last_checked_at: expect.any(String), updated_at: expect.any(String) });
  });

  it('rejects a matching signal outside the canonical assistant envelope', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    appendRawRecord(f, { sessionId: f.sessionId, type: 'system', message: { role: 'assistant', content: [{ type: 'text', text: completion('ralplan') }] } });
    appendRawRecord(f, { session_id: f.sessionId, type: 'assistant', message: { role: 'assistant', content: completion('ralplan') } });
    appendRawRecord(f, { sessionId: f.sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }, { type: 'text', text: completion('ralplan') }] } });
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') });
    expect(readState(f).pipelineTracking).toMatchObject({ currentStageIndex: 0, trackingRevision: 0 });
  });

  symlinkIt('rejects wrong-session, descriptor mismatch, escaped paths, and symlink transcripts without mutation', () => {
    const f = fixture(kind);
    const state = workflowState(f);
    writeState(f, state);
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const cases = [
      [{ session_id: 'other-session' }, { continue: true, suppressOutput: true }],
      [{ transcript_path: join(f.dir, 'escaped.jsonl') }, { continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') }],
    ] as const;
    writeFileSync(join(f.dir, 'escaped.jsonl'), JSON.stringify({ message: { role: 'assistant', content: completion('ralplan') } }));
    for (const [input, expected] of cases) {
      expect(invoke(f, input)).toMatchObject(expected);
      expectStateExceptLiveness(readState(f), state);
    }

    const target = join(f.claudeConfigDir, 'projects', 'nested', `${f.sessionId}.jsonl`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ sessionId: f.sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: completion('ralplan') }] } }));
    rmSync(f.transcript);
    symlinkSync(target, f.transcript);
    expect(lstatSync(f.transcript).isSymbolicLink()).toBe(true);
    expect(invoke(f)).toMatchObject(workflowIntegrityFailure);
    expectStateExceptLiveness(readState(f), state);

    rmSync(f.transcript);
    writeFileSync(f.transcript, '');
    state.workflow.profileHash = 'b'.repeat(64);
    writeState(f, state);
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expect.stringContaining('workflow_descriptor_integrity_failed') });
    expect(readState(f)).toEqual(state);
  });

  symlinkIt('rejects ancestor symlink transcript escapes without mutation', () => {
    const f = fixture(kind);
    const realProject = join(f.claudeConfigDir, 'projects', 'real-project');
    const linkedProject = join(f.claudeConfigDir, 'projects', 'linked-project');
    const escapedTranscript = join(linkedProject, `${f.sessionId}.jsonl`);
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realProject, linkedProject, 'dir');
    writeFileSync(join(realProject, `${f.sessionId}.jsonl`), `${JSON.stringify({ sessionId: f.sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: completion('ralplan') }] } })}\n`);
    const state = workflowState(f);
    state.pipelineTracking.activationBoundary.transcriptPath = escapedTranscript;
    writeState(f, state);
    const bytesBefore = readFileSync(f.statePath);

    expect(invoke(f, { transcript_path: escapedTranscript })).toMatchObject(workflowIntegrityFailure);
    expectStateExceptLiveness(readState(f), JSON.parse(bytesBefore.toString('utf8')));
  });

  it.each([
    ['extra descriptor key', workflow => ({ ...workflow, extra: true })],
    ['recomputed invalid sequence', workflow => {
      const descriptor = { descriptorVersion: 1, workflowName: workflow.workflowName, profileVersion: 1, stages: ['ralplan', 'qa'] };
      return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') };
    }],
    ['comma-bearing composite stage', workflow => {
      const descriptor = { descriptorVersion: 1, workflowName: workflow.workflowName, profileVersion: 1, stages: ['ralplan', 'execution,qa'] };
      return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') };
    }],
    ['nested stage array', workflow => {
      const descriptor = { descriptorVersion: 1, workflowName: workflow.workflowName, profileVersion: 1, stages: [['ralplan', 'execution']] };
      return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') };
    }],
    ['reserved workflow name', workflow => {
      const descriptor = { descriptorVersion: 1, workflowName: 'autopilot', profileVersion: 1, stages: workflow.stages };
      return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') };
    }],
  ])('rejects %s even when its hash is valid', (_name, mutate) => {
    const f = fixture(kind);
    const state = workflowState(f);
    state.workflow = mutate(state.workflow);
    writeState(f, state);
    const bytesBefore = readFileSync(f.statePath);

    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expect.stringContaining('workflow_descriptor_integrity_failed') });
    expect(readFileSync(f.statePath)).toEqual(bytesBefore);
  });

  it('fails closed when the descriptor changes while waiting for the Stop commit lock', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));
    const concurrentlyMutated = readState(f);
    concurrentlyMutated.workflow.extra = true;
    writeState(f, concurrentlyMutated);
    const bytesBeforeUnlock = readFileSync(f.statePath);
    unlinkSync(lockPath);

    const result = await pending;
    expect(result).toMatchObject({ continue: false, decision: 'block', reason: expect.stringContaining('workflow_descriptor_integrity_failed') });
    expect(readFileSync(f.statePath)).toEqual(bytesBeforeUnlock);
    expect(readState(f).pipelineTracking.trackingRevision).toBe(0);
  });

  it('rejects replacement of the authenticated activation prefix', () => {
    const f = fixture(kind);
    appendRecord(f, { message: { role: 'assistant', content: 'activation prefix' } });
    writeState(f, workflowState(f));
    const original = readFileSync(f.transcript, 'utf8');
    writeFileSync(f.transcript, original.replace('activation prefix', 'replaced prefix!'));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const before = readFileSync(f.statePath);

    expect(invoke(f)).toMatchObject(workflowIntegrityFailure);
    expectStateExceptLiveness(readState(f), JSON.parse(before.toString('utf8')));
  });

  it('rejects malformed tracking and nested completion history without mutation', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    expect(invoke(f).reason).toBe(expectedStagePrompt('execution'));
    const validState = readState(f);
    const cases = [
      state => { state.pipelineTracking.stages[1].id = 'qa'; },
      state => { state.pipelineTracking.trackingRevision = -1; },
      state => { state.pipelineTracking.completionObservations[0].signalId = 'FORGED'; state.pipelineTracking.completionObservations[0].stableFile = {}; state.pipelineTracking.completionObservations[0].activationBoundary = {}; },
      state => { state.pipelineTracking.activationBoundary = state.pipelineTracking.completionObservations[0].activationBoundary; },
      state => { state.prompt = ''; },
    ];
    for (const mutate of cases) {
      const corrupted = JSON.parse(JSON.stringify(validState));
      mutate(corrupted);
      writeState(f, corrupted);
      const before = readFileSync(f.statePath);
      appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });
      expect(invoke(f)).toMatchObject({ continue: false, decision: 'block' });
      expectStateExceptLiveness(readState(f), JSON.parse(before.toString('utf8')));
      writeState(f, validState);
    }
  });

  it('rejects an ABA reactivation while a Stop candidate waits on the lock', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));
    const replacement = workflowState(f);
    replacement.workflowRunId = '22222222-2222-4222-8222-222222222222';
    replacement.pipelineTracking.activationBoundary.byteOffset = readFileSync(f.transcript).byteLength;
    replacement.pipelineTracking.activationBoundary.fileIdentity = transcriptIdentity(f.transcript);
    writeState(f, replacement);
    const replacementBytes = readFileSync(f.statePath);
    unlinkSync(lockPath);

    expect(await pending).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') });
    expectStateExceptLiveness(readState(f), JSON.parse(replacementBytes.toString('utf8')));
  });

  it('rejects same-size in-place transcript mutation before commit', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const original = readFileSync(f.transcript, 'utf8');
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));
    writeFileSync(f.transcript, original.replace('PIPELINE_RALPLAN_COMPLETE', 'PIPELINE_RALPLAN_COMPLETF'));
    expect(readFileSync(f.transcript).byteLength).toBe(Buffer.byteLength(original));
    unlinkSync(lockPath);

    expect(await pending).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') });
    expect(readState(f).pipelineTracking.trackingRevision).toBe(0);
  });

  it('rejects mutation between verified-fd read and post-read identity capture', () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const original = readFileSync(f.transcript);
    const replacement = Buffer.from(original.toString('utf8').replace('PIPELINE_RALPLAN_COMPLETE', 'PIPELINE_RALPLAN_COMPLETF'));
    expect(replacement.byteLength).toBe(original.byteLength);
    const before = readFileSync(f.statePath);

    const result = invoke(f, {}, {
      NODE_ENV: 'test',
      OMC_WORKFLOW_TEST_MUTATE_AFTER_READ_BASE64: replacement.toString('base64'),
    });
    expect(result).toMatchObject({ continue: false, decision: 'block' });
    expect([expectedStagePrompt('ralplan'), workflowIntegrityFailure.reason]).toContain(result.reason);
    expectStateExceptLiveness(readState(f), JSON.parse(before.toString('utf8')));
  });

  it('rejects transcript parent replacement before commit', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 75));

    const projects = dirname(f.transcript);
    renameSync(projects, `${projects}-original`);
    mkdirSync(projects, { recursive: true });
    writeFileSync(f.transcript, readFileSync(join(`${projects}-original`, `${f.sessionId}.jsonl`)));
    const before = readFileSync(f.statePath);
    unlinkSync(lockPath);

    expect(await pending).toMatchObject(workflowIntegrityFailure);
    expectStateExceptLiveness(readState(f), JSON.parse(before.toString('utf8')));
  });

  it('rejects a stale transcript snapshot under the Stop lock and refreshes on retry', async () => {
    const f = fixture(kind);
    writeState(f, workflowState(f));
    appendRecord(f, { message: { role: 'assistant', content: completion('ralplan') } });
    const lockPath = `${f.statePath}.mutation.lock`;
    writeFileSync(lockPath, liveLockOwner());
    const pending = invokeAsync(f);
    await new Promise(resolve => setTimeout(resolve, 1000));
    appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });
    unlinkSync(lockPath);

    expect(await pending).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('ralplan') });
    expect(readState(f).pipelineTracking.trackingRevision).toBe(0);
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('execution') });
    const committed = readState(f);
    expect(committed.pipelineTracking.activationBoundary.byteOffset).toBe(readFileSync(f.transcript).byteLength);
    expect(invoke(f)).toMatchObject({ continue: false, decision: 'block', reason: expectedStagePrompt('execution') });
    expect(readState(f).pipelineTracking).toMatchObject({ currentStageIndex: 1, trackingRevision: 1 });

    appendRecord(f, { message: { role: 'assistant', content: completion('execution') } });
    expect(invoke(f).reason).toContain('All selected stages are complete');
  });

  it('leaves legacy autopilot states on their existing continuation path', () => {
    const f = fixture(kind);
    const now = new Date().toISOString();
    const legacy = { active: true, phase: 'planning', session_id: f.sessionId, project_path: f.project, started_at: now, updated_at: now, last_checked_at: now };
    writeState(f, legacy);
    const result = invoke(f);
    expect(result.reason).toContain('[AUTOPILOT - Phase: planning]');
    expect(readState(f)).toMatchObject({ ...legacy, last_checked_at: expect.any(String), reinforcement_count: 1 });
  });
});

describe('workflow profile shipped hook parity', () => {
  it('uses identical runtime helper payloads for plugin and installed-template execution', () => {
    const pluginHelper = readFileSync(join(root, 'scripts', 'lib', 'workflow-profile-runtime.mjs'), 'utf8');
    const templateHelper = readFileSync(join(root, 'templates', 'hooks', 'lib', 'workflow-profile-runtime.mjs'), 'utf8');
    for (const contractTerm of ['selectWorkflowProfile', 'createWorkflowState', 'advanceWorkflowOnStop', 'profileHash', 'pipelineTracking', 'completionObservations', 'O_NOFOLLOW', '/proc/self/fd']) {
      expect(pluginHelper).toContain(contractTerm);
      expect(templateHelper).toContain(contractTerm);
    }
  });
});
