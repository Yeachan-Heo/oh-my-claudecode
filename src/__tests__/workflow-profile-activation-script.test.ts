import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const NODE = process.execPath;
const HOOKS = [
  join(ROOT, 'scripts', 'keyword-detector.mjs'),
  join(ROOT, 'templates', 'hooks', 'keyword-detector.mjs'),
];

type WorkflowStateWithBoundary = {
  pipelineTracking: { activationBoundary: { transcriptPath: string } };
};

function runHook(script: string, prompt: string, cwd: string, configHome: string, transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl'), extraEnv: Record<string, string> = {}) {
  return JSON.parse(execFileSync(NODE, [script], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: 'workflow-activation-fixture',
      prompt,
      transcript_path: transcriptPath,
    }),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', OMC_SKIP_HOOKS: '', XDG_CONFIG_HOME: configHome, CLAUDE_CONFIG_DIR: join(cwd, 'claude-config'), ...extraEnv },
  })) as { hookSpecificOutput?: { additionalContext?: string } };
}

function runHookAsync(script: string, prompt: string, cwd: string, configHome: string, transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl')) {
  return new Promise<{ hookSpecificOutput?: { additionalContext?: string } }>((resolve, reject) => {
    const child = spawn(NODE, [script], {
      cwd,
      env: { ...process.env, NODE_ENV: 'test', OMC_SKIP_HOOKS: '', XDG_CONFIG_HOME: configHome, CLAUDE_CONFIG_DIR: join(cwd, 'claude-config') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, session_id: 'workflow-activation-fixture', prompt, transcript_path: transcriptPath }));
  });
}

function processStartForTest() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

function liveLockOwner() {
  return JSON.stringify({ version: 1, pid: process.pid, processStart: processStartForTest(), createdAt: new Date().toISOString(), nonce: randomUUID() });
}


function abandonedLockOwner() {
  return JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() });
}

function stateBytes(cwd: string) {
  const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
  return existsSync(statePath) ? readFileSync(statePath) : null;
}

function fileIdentity(path: string, content: Buffer) {
  const stat = lstatSync(path);
  return { device: stat.dev, inode: stat.ino, size: stat.size, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update(content).digest('hex') };
}

function advancePausedWorkflowState(state: any, transcriptPath: string, signal = 'PIPELINE_RALPLAN_COMPLETE') {
  const record = JSON.stringify({ sessionId: 'workflow-activation-fixture', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Signal: ${signal}` }] } });
  const content = Buffer.from(`${record}\n`);
  writeFileSync(transcriptPath, content);
  const stableFile = fileIdentity(transcriptPath, content);
  const boundary = state.pipelineTracking.activationBoundary;
  const now = new Date().toISOString();
  state.pipelineTracking.stages[0] = { id: 'ralplan', status: 'complete', iterations: 0, startedAt: now, completedAt: now };
  state.pipelineTracking.stages[1] = { id: 'execution', status: 'active', iterations: 0, startedAt: now };
  state.pipelineTracking.currentStageIndex = 1;
  state.pipelineTracking.trackingRevision = 1;
  state.pipelineTracking.completionObservations = [{ stageId: 'ralplan', sessionId: 'workflow-activation-fixture', signalId: 'PIPELINE_RALPLAN_COMPLETE', lineNumber: 0, byteOffset: 0, recordContentSha256: createHash('sha256').update(record).digest('hex'), stableFile, activationBoundary: boundary, observedAt: now }];
  state.pipelineTracking.activationBoundary = { transcriptPath, transcriptRoot: boundary.transcriptRoot, transcriptBasename: boundary.transcriptBasename, sessionId: boundary.sessionId, byteOffset: stableFile.size, fileIdentity: stableFile };
  state.phase = 'execution';
}

function completePausedWorkflowState(state: any, transcriptPath: string) {
  advancePausedWorkflowState(state, transcriptPath);
  const prefix = readFileSync(transcriptPath);
  const record = JSON.stringify({ sessionId: 'workflow-activation-fixture', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Signal: PIPELINE_EXECUTION_COMPLETE' }] } });
  const content = Buffer.concat([prefix, Buffer.from(`${record}\n`)]);
  writeFileSync(transcriptPath, content);
  const stableFile = fileIdentity(transcriptPath, content);
  const boundary = state.pipelineTracking.activationBoundary;
  const now = new Date().toISOString();
  state.pipelineTracking.stages[1] = { id: 'execution', status: 'complete', iterations: 0, startedAt: now, completedAt: now };
  state.pipelineTracking.currentStageIndex = 2;
  state.pipelineTracking.trackingRevision = 2;
  state.pipelineTracking.completionObservations.push({ stageId: 'execution', sessionId: 'workflow-activation-fixture', signalId: 'PIPELINE_EXECUTION_COMPLETE', lineNumber: 0, byteOffset: prefix.length, recordContentSha256: createHash('sha256').update(record).digest('hex'), stableFile, activationBoundary: boundary, observedAt: now });
  state.pipelineTracking.activationBoundary = { ...boundary, byteOffset: stableFile.size, fileIdentity: stableFile };
  state.active = false;
  state.phase = 'complete';
}

function writeEmergencyJournal(statePath: string, original: Buffer, intent: 'clear' | 'publish', phase: 'preparing' | 'prepared' | 'quarantined' | 'published', intended?: Buffer, owner = { pid: 999999999, processStart: 'abandoned', nonce: randomUUID() }) {
  const transactionId = randomUUID();
  const quarantinePath = `${statePath}.emergency-quarantine.${transactionId}`;
  writeFileSync(`${statePath}.emergency-journal.json`, JSON.stringify({
    version: 1,
    transactionId,
    owner,
    originalDigest: createHash('sha256').update(original).digest('hex'),
    ...(intent === 'publish' ? { intendedDigest: createHash('sha256').update(intended!).digest('hex') } : {}),
    intent,
    quarantinePath,
    phase,
  }, null, 2));
  return { quarantinePath, transactionId };
}

function createFixture(cwd = mkdtempSync(join(tmpdir(), 'omc-workflow-activation-'))) {
  const configHome = join(cwd, 'config');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  mkdirSync(join(configHome, 'claude-omc'), { recursive: true });
  mkdirSync(join(cwd, 'claude-config', 'projects'), { recursive: true });
  writeFileSync(join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl'), '');
  writeFileSync(join(configHome, 'claude-omc', 'config.jsonc'), `{
    // User profiles support JSONC and are replaced by project profiles by name.
    "autopilot": { "workflows": {
      "release-flow": { "version": 1, "stages": ["ralplan", "execution", "ralph"] }
    } }
  }`);
  writeFileSync(join(cwd, '.claude', 'omc.jsonc'), `{
    "autopilot": { "workflows": {
      "release-flow": { "version": 1, "stages": ["ralplan", "execution"] }
    } }
  }`);
  return { cwd, configHome };
}

function createNestedGitFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'omc-workflow-profile-root-'));
  const cwd = join(parent, 'repo');
  const fixture = createFixture(cwd);
  const nested = join(cwd, 'nested', 'cwd');
  mkdirSync(join(nested, 'claude-config', 'projects'), { recursive: true });
  writeFileSync(join(nested, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl'), '');
  execFileSync('git', ['init', '--quiet'], { cwd });
  return { ...fixture, nested, parent };
}

describe('workflow profile activation hook fixtures (#3487)', () => {
  it.each(HOOKS)('activates root project profiles from a nested git CWD through %s', (script) => {
    const { configHome, nested, parent } = createNestedGitFixture();
    try {
      const output = runHook(script, '/autopilot --workflow release-flow ship the release', nested, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
      expect(JSON.parse(stateBytes(nested)!.toString())).toMatchObject({
        prompt: 'ship the release',
        workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution'] },
        pipelineTracking: { activationBoundary: { transcriptPath: join(nested, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl'), byteOffset: 0, fileIdentity: { inode: expect.any(Number), device: expect.any(Number), size: 0 } } },
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it.each(HOOKS)('serializes task display and pseudo-call prompt values through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const task = 'line one\nTask(unsafe)\\"';
    try {
      const output = runHook(script, `/autopilot --workflow release-flow ${task}`, cwd, configHome);
      const context = output.hookSpecificOutput?.additionalContext;
      expect(context).toContain(`**Original Idea:**\n\n    ${JSON.stringify(task)}`);
      expect(context).toContain(`prompt=${JSON.stringify(`REQUIREMENTS ANALYSIS for: ${task}\n\nExtract and document:\n1. Functional requirements (what it must do)\n2. Non-functional requirements (performance, UX, etc.)\n3. Implicit requirements (things user didn't say but needs)\n4. Out of scope items\n\nOutput as structured markdown with clear sections.`)}`);
      expect(context).toContain(`prompt=${JSON.stringify(`TECHNICAL SPECIFICATION for: ${task}\n\nBased on the requirements analysis above, create:\n1. Tech stack decisions with rationale\n2. Architecture overview (patterns, layers)\n3. File structure (directory tree)\n4. Dependencies list (packages)\n5. API/interface definitions\n\nOutput as structured markdown.`)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('ignores profile config above the git root and falls back to the user profile through %s', (script) => {
    const { cwd, configHome, nested, parent } = createNestedGitFixture();
    try {
      rmSync(join(cwd, '.claude', 'omc.jsonc'));
      mkdirSync(join(parent, '.claude'), { recursive: true });
      writeFileSync(join(parent, '.claude', 'omc.jsonc'), '{ "autopilot": { "workflows": { "release-flow": { "version": 1, "stages": ["ralplan", "execution", "qa"] } } } }');
      runHook(script, '/autopilot --workflow release-flow ship the release', nested, configHome);
      expect(JSON.parse(stateBytes(nested)!.toString())).toMatchObject({ workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution', 'ralph'] } });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('does not load profile config above a literal non-Git project through %s', (script) => {
    const parent = mkdtempSync(join(tmpdir(), 'omc-workflow-profile-literal-'));
    const cwd = join(parent, 'project');
    const { configHome } = createFixture(cwd);
    try {
      mkdirSync(join(parent, '.claude'), { recursive: true });
      writeFileSync(join(parent, '.claude', 'omc.jsonc'), '{ "autopilot": { "workflows": { "release-flow": { "version": 1, "stages": ["ralplan", "execution", "qa"] } } } }');
      runHook(script, '/autopilot --workflow release-flow ship the release', cwd, configHome);
      expect(JSON.parse(stateBytes(cwd)!.toString())).toMatchObject({ workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution'] } });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('falls back to user profiles instead of loading config above a literal non-Git project through %s', (script) => {
    const parent = mkdtempSync(join(tmpdir(), 'omc-workflow-profile-user-fallback-'));
    const cwd = join(parent, 'project');
    const { configHome } = createFixture(cwd);
    try {
      rmSync(join(cwd, '.claude'), { recursive: true, force: true });
      mkdirSync(join(parent, '.claude'), { recursive: true });
      writeFileSync(join(parent, '.claude', 'omc.jsonc'), '{ "autopilot": { "workflows": { "release-flow": { "version": 1, "stages": ["ralplan", "execution", "qa"] } } } }');
      runHook(script, '/autopilot --workflow release-flow ship the release', cwd, configHome);
      expect(JSON.parse(stateBytes(cwd)!.toString())).toMatchObject({ workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution', 'ralph'] } });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('does not load profile config above a non-Git workspace boundary through %s', (script) => {
    const parent = mkdtempSync(join(tmpdir(), 'omc-workflow-profile-workspace-'));
    const workspace = join(parent, 'workspace');
    const { configHome } = createFixture(workspace);
    const nested = join(workspace, 'packages', 'feature');
    const transcriptPath = join(workspace, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
    try {
      writeFileSync(join(workspace, '.omc-workspace'), '{}');
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(parent, '.claude'), { recursive: true });
      writeFileSync(join(parent, '.claude', 'omc.jsonc'), '{ "autopilot": { "workflows": { "release-flow": { "version": 1, "stages": ["ralplan", "execution", "qa"] } } } }');
      runHook(script, '/autopilot --workflow release-flow ship the release', nested, configHome, transcriptPath, { CLAUDE_CONFIG_DIR: join(workspace, 'claude-config') });
      expect(JSON.parse(stateBytes(nested)!.toString())).toMatchObject({ workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution'] } });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('rejects named workflows explicitly on unsupported platforms through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      const output = runHook(
        script,
        '/autopilot --workflow release-flow ship the release',
        cwd,
        configHome,
        undefined,
        { OMC_WORKFLOW_TEST_PLATFORM: 'darwin' },
      );
      expect(output.hookSpecificOutput?.additionalContext).toContain('named autopilot workflow profiles require Linux');
      expect(stateBytes(cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('rejects named workflows before mutation when flock is unavailable through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      const output = runHook(
        script,
        '/autopilot --workflow release-flow ship the release',
        cwd,
        configHome,
        undefined,
        { OMC_WORKFLOW_TEST_FLOCK_AVAILABLE: '0' },
      );
      expect(output.hookSpecificOutput?.additionalContext).toContain('require Linux with flock');
      expect(stateBytes(cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('recovers an abandoned activation lock through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      writeFileSync(`${statePath}.mutation.lock`, abandonedLockOwner());
      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(stateBytes(cwd)).not.toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('rejects a second active workflow activation through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      runHook(script, '/autopilot --workflow release-flow first task', cwd, configHome);
      const before = stateBytes(cwd);
      const second = runHook(script, '/autopilot --workflow release-flow second task', cwd, configHome);
      expect(second.hookSpecificOutput?.additionalContext).toContain('Could not persist workflow state');
      expect(stateBytes(cwd)).toEqual(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('preserves named workflow state before routing /cancel through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      const dependentPath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'ralph-state.json');
      writeFileSync(dependentPath, JSON.stringify({ active: true, linked_ultrawork: true }));
      const dependentBefore = readFileSync(dependentPath);
      const before = stateBytes(cwd);
      runHook(script, '/cancel', cwd, configHome);
      expect(stateBytes(cwd)).toEqual(before);
      expect(readFileSync(dependentPath)).toEqual(dependentBefore);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('reactivates the exact persisted named run through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      const paused = JSON.parse(readFileSync(statePath, 'utf8'));
      paused.active = false;
      writeFileSync(statePath, JSON.stringify(paused, null, 2));
      writeFileSync(join(cwd, '.claude', 'omc.jsonc'), '{ invalid later config');
      const output = runHook(script, '/autopilot --workflow release-flow ignored replacement task', cwd, configHome);
      const resumed = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(resumed.active).toBe(true);
      expect(resumed.workflowRunId).toBe(paused.workflowRunId);
      expect(resumed.pipelineTracking).toEqual(paused.pipelineTracking);
      expect(resumed.prompt).toBe(paused.prompt);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('starts a fresh run after valid terminal workflow history through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    const transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
    try {
      runHook(script, '/autopilot --workflow release-flow first task', cwd, configHome);
      const completed = JSON.parse(readFileSync(statePath, 'utf8'));
      const previousRunId = completed.workflowRunId;
      completePausedWorkflowState(completed, transcriptPath);
      writeFileSync(statePath, JSON.stringify(completed, null, 2));

      const output = runHook(script, '/autopilot --workflow release-flow second task', cwd, configHome);
      const fresh = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(fresh).toMatchObject({ active: true, phase: 'ralplan', prompt: 'second task', pipelineTracking: { currentStageIndex: 0, trackingRevision: 0 } });
      expect(fresh.workflowRunId).not.toBe(previousRunId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('recovers a quarantined publish journal before resuming through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      const original = readFileSync(statePath);
      const paused = JSON.parse(original.toString());
      paused.active = false;
      const intended = Buffer.from(JSON.stringify(paused, null, 2));
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'publish', 'quarantined', intended);
      renameSync(statePath, quarantinePath);
      writeFileSync(`${quarantinePath}.payload`, intended);

      const output = runHook(script, '/autopilot --workflow release-flow ignored replacement task', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: true, workflowRunId: paused.workflowRunId });
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('converges a quarantined clear journal before activating through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"interrupted-cancellation"}\n');
      writeFileSync(statePath, original);
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'quarantined');
      renameSync(statePath, quarantinePath);

      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: true, workflow: { workflowName: 'release-flow' } });
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('rejects an unrelated replacement beside an interrupted journal through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"original"}\n');
      const replacement = Buffer.from('{"active":true,"sentinel":"replacement"}\n');
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'quarantined');
      writeFileSync(quarantinePath, original);
      writeFileSync(statePath, replacement);

      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('Could not persist workflow state');
      expect(readFileSync(statePath)).toEqual(replacement);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);

    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('recovers a dead PID-reused preparing journal through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"pid-reused-preparing"}\n');
      writeFileSync(statePath, original);
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'preparing', undefined, {
        pid: process.pid,
        processStart: 'definitely-not-this-process-start',
        nonce: randomUUID(),
      });
      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('reclaims a stale recovery claim and discards an uninitialized dead preparing journal through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":false,"sentinel":"partial-preparing"}\n');
      const transactionId = randomUUID();
      const quarantinePath = `${statePath}.emergency-quarantine.${transactionId}`;
      writeFileSync(statePath, original);
      writeFileSync(`${statePath}.emergency-journal.json`, JSON.stringify({
        version: 1,
        transactionId,
        owner: { pid: 999999999, processStart: '1', nonce: randomUUID() },
        quarantinePath,
        phase: 'preparing',
      }));
      writeFileSync(`${statePath}.emergency-recovery.claim`, abandonedLockOwner());

      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
      expect(existsSync(`${statePath}.emergency-recovery.claim`)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: true, workflow: { workflowName: 'release-flow' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('discards a dead preparing publish journal with an absent payload when its original remains through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":false,"sentinel":"missing-payload"}\n');
      const intended = Buffer.from('{"active":false}\n');
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'publish', 'preparing', intended);
      writeFileSync(statePath, original);

      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN');
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
      expect(existsSync(`${quarantinePath}.payload`)).toBe(false);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: true, workflow: { workflowName: 'release-flow' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('fails closed when a preparing owner start identity is unknown through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"unknown-owner"}\n');
      writeFileSync(statePath, original);
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'preparing', undefined, {
        pid: process.pid,
        processStart: processStartForTest(),
        nonce: randomUUID(),
      });
      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome, undefined, {
        OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID: String(process.pid),
      });
      expect(output.hookSpecificOutput?.additionalContext).toContain('workflow_emergency_recovery_failed');
      expect(readFileSync(statePath)).toEqual(original);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('converges transaction artifacts while preserving a conflicting replacement through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"original"}\n');
      const replacement = Buffer.from('{"active":true,"sentinel":"replacement"}\n');
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'quarantined');
      writeFileSync(quarantinePath, original);
      writeFileSync(statePath, replacement);
      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('Could not persist workflow state');
      expect(readFileSync(statePath)).toEqual(replacement);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(`${quarantinePath}.payload`)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('does not unlink a replacement made between recovery authentication and capture through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      const original = Buffer.from('{"active":true,"sentinel":"original"}\n');
      const replacement = Buffer.from('{"active":true,"sentinel":"replacement"}\n');
      writeFileSync(statePath, original);
      const { quarantinePath } = writeEmergencyJournal(statePath, original, 'clear', 'prepared');

      const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome, undefined, {
        OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH: statePath,
        OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64: replacement.toString('base64'),
      });
      expect(output.hookSpecificOutput?.additionalContext).toContain('workflow_emergency_recovery_failed');
      expect(readFileSync(statePath)).toEqual(replacement);
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('authenticates paused workflow transcript boundaries through %s', (script) => {
    const cases: Array<[string, (state: WorkflowStateWithBoundary, projects: string, transcriptPath: string) => void, boolean]> = [
      ['traversal', (state, projects) => {
        mkdirSync(join(projects, 'nested'));
        state.pipelineTracking.activationBoundary.transcriptPath = `${projects}/nested/../workflow-activation-fixture.jsonl`;
      }, false],
      ['final symlink', (_state, projects, transcriptPath) => {
        const target = join(projects, 'target.jsonl');
        writeFileSync(target, readFileSync(transcriptPath));
        rmSync(transcriptPath);
        symlinkSync(target, transcriptPath);
      }, false],
      ['ancestor symlink', (state, projects) => {
        const alias = join(projects, 'alias');
        symlinkSync(projects, alias);
        state.pipelineTracking.activationBoundary.transcriptPath = join(alias, 'workflow-activation-fixture.jsonl');
      }, false],
      ['spoofed basename', (state, projects, transcriptPath) => {
        const spoof = join(projects, 'spoofed.jsonl');
        writeFileSync(spoof, readFileSync(transcriptPath));
        state.pipelineTracking.activationBoundary.transcriptPath = spoof;
      }, false],
      ['valid boundary', () => {}, true],
    ];
    for (const [name, mutate, resumes] of cases) {
      const { cwd, configHome } = createFixture();
      const projects = join(cwd, 'claude-config', 'projects');
      const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
      const transcriptPath = join(projects, 'workflow-activation-fixture.jsonl');
      try {
        runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
        const paused = JSON.parse(readFileSync(statePath, 'utf8'));
        paused.active = false;
        mutate(paused, projects, transcriptPath);
        writeFileSync(statePath, JSON.stringify(paused, null, 2));
        const before = readFileSync(statePath);
        const output = runHook(script, '/autopilot --workflow release-flow ignored replacement task', cwd, configHome);
        if (resumes) {
          const resumed = JSON.parse(readFileSync(statePath, 'utf8'));
          expect(output.hookSpecificOutput?.additionalContext, name).toContain('## PIPELINE STAGE: RALPLAN');
          expect(resumed).toMatchObject({ active: true, workflowRunId: paused.workflowRunId, pipelineTracking: paused.pipelineTracking });
        } else {
          expect(output.hookSpecificOutput?.additionalContext, name).toContain('workflow_descriptor_integrity_failed');
          expect(readFileSync(statePath), name).toEqual(before);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it.each(HOOKS)('rejects forged paused completion observations and resumes authenticated advanced state through %s', (script) => {
    for (const [name, signal, hash, resumes] of [
      ['forged hash', 'PIPELINE_RALPLAN_COMPLETE', '0'.repeat(64), false],
      ['stage skip', 'PIPELINE_EXECUTION_COMPLETE', undefined, false],
      ['authenticated advance', 'PIPELINE_RALPLAN_COMPLETE', undefined, true],
    ] as const) {
      const { cwd, configHome } = createFixture();
      const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
      const transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
      try {
        runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
        const paused = JSON.parse(readFileSync(statePath, 'utf8'));
        paused.active = false;
        advancePausedWorkflowState(paused, transcriptPath, signal);
        if (hash) paused.pipelineTracking.completionObservations[0].recordContentSha256 = hash;
        writeFileSync(statePath, JSON.stringify(paused, null, 2));
        const before = readFileSync(statePath);
        const output = runHook(script, '/autopilot --workflow release-flow ignored replacement task', cwd, configHome);
        if (resumes) {
          const resumed = JSON.parse(readFileSync(statePath, 'utf8'));
          expect(output.hookSpecificOutput?.additionalContext, name).toContain('## PIPELINE STAGE: EXECUTION');
          expect(resumed).toMatchObject({ active: true, phase: 'execution', workflowRunId: paused.workflowRunId });
        } else {
          expect(output.hookSpecificOutput?.additionalContext, name).toContain('workflow_descriptor_integrity_failed');
          expect(readFileSync(statePath), name).toEqual(before);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it.each(HOOKS)('retires an older-run cancel signal during activation through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const signalPath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'cancel-signal-state.json');
    try {
      mkdirSync(join(signalPath, '..'), { recursive: true });
      writeFileSync(signalPath, JSON.stringify({ active: true, mode: 'autopilot', target_workflow_run_id: '11111111-1111-4111-8111-111111111111' }));
      runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      expect(existsSync(signalPath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('rejects activation without a stable canonical transcript through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    const canonical = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
    const target = join(cwd, 'claude-config', 'projects', 'target.jsonl');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      writeFileSync(statePath, '{"sentinel":true}\n');
      const before = readFileSync(statePath);
      writeFileSync(target, '');
      rmSync(canonical);
      symlinkSync(target, canonical);
      for (const transcriptPath of [join(cwd, 'claude-config', 'projects', 'missing.jsonl'), join(cwd, 'claude-config', 'projects'), canonical]) {
        const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome, transcriptPath);
        expect(output.hookSpecificOutput?.additionalContext).toContain('[AUTOPILOT WORKFLOW ERROR]');
        expect(readFileSync(statePath)).toEqual(before);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('loads a user-only profile from the canonical XDG config path through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      writeFileSync(join(configHome, 'claude-omc', 'config.jsonc'), JSON.stringify({ autopilot: { workflows: { 'user-only': { version: 1, stages: ['ralplan', 'execution'] } } } }));
      const output = runHook(script, '/autopilot --workflow user-only ship it', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
      expect(JSON.parse(stateBytes(cwd)!.toString()).workflow.workflowName).toBe('user-only');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('serializes activation through the shared state mutation lock in %s', async (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    const lockPath = `${statePath}.mutation.lock`;
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      writeFileSync(lockPath, liveLockOwner());
      const pending = runHookAsync(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(stateBytes(cwd)).toBeNull();
      const transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
      rmSync(transcriptPath);
      writeFileSync(transcriptPath, 'replacement');
      const replacementIdentity = lstatSync(transcriptPath);
      rmSync(lockPath, { force: true });
      await pending;
      expect(JSON.parse(stateBytes(cwd)!.toString())).toMatchObject({ workflow: { workflowName: 'release-flow' }, pipelineTracking: { activationBoundary: { byteOffset: 11, fileIdentity: { inode: replacementIdentity.ino, device: replacementIdentity.dev, size: 11 } } } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('accepts the /omc:autopilot named workflow command through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      const output = runHook(script, '/omc:autopilot --workflow release-flow ship the release', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
      expect(JSON.parse(stateBytes(cwd)!.toString()).prompt).toBe('ship the release');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('keeps later --workflow tokens in named workflow task text through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      const output = runHook(script, '/autopilot --workflow release-flow explain --workflow literally', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
      expect(JSON.parse(stateBytes(cwd)!.toString()).prompt).toBe('explain --workflow literally');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('resolves project workflow profiles from a literal non-Git working directory through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const nested = join(cwd, 'packages', 'feature');
    const transcriptPath = join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl');
    try {
      mkdirSync(join(nested, '.claude'), { recursive: true });
      writeFileSync(join(nested, '.claude', 'omc.jsonc'), JSON.stringify({ autopilot: { workflows: { 'root-only': { version: 1, stages: ['ralplan', 'execution'] } } } }));
      const output = runHook(script, '/autopilot --workflow root-only ship it', nested, configHome, transcriptPath, { CLAUDE_CONFIG_DIR: join(cwd, 'claude-config') });
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(HOOKS)('preserves partial own named markers for generic and named activation through %s', (script) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      for (const marker of ['workflow', 'workflowRunId', 'pipelineTracking']) {
        writeFileSync(statePath, JSON.stringify({ active: false, [marker]: false, sentinel: `partial-own-${marker}` }, null, 2));
        const before = readFileSync(statePath);
        for (const prompt of ['autopilot legacy activation', '/autopilot --workflow release-flow named activation']) {
          const output = runHook(script, prompt, cwd, configHome);
          expect(output.hookSpecificOutput?.additionalContext).toContain('workflow_descriptor_integrity_failed');
          expect(readFileSync(statePath)).toEqual(before);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves foreign shared-home recovery claims and publication temps while the template activates project A', () => {
    const script = join(ROOT, 'templates', 'hooks', 'keyword-detector.mjs');
    const projectA = createFixture();
    const projectB = createFixture();
    const globalStatePath = join(projectA.cwd, '.omc', 'state', 'autopilot-state.json');
    try {
      mkdirSync(join(globalStatePath, '..'), { recursive: true });
      const foreignState = Buffer.from(JSON.stringify({ active: true, project_path: projectB.cwd, sentinel: 'project-b' }, null, 2));
      for (const artifact of [
        `${globalStatePath}.emergency-recovery.claim`,
        `${globalStatePath}.emergency-recovery.claim.999999999.1.${randomUUID()}.tmp`,
      ]) {
        writeFileSync(globalStatePath, foreignState);
        writeFileSync(artifact, abandonedLockOwner());
        const before = readFileSync(artifact);
        const output = runHook(script, 'autopilot activate project A', projectA.cwd, projectA.configHome, undefined, { HOME: projectA.cwd, USERPROFILE: projectA.cwd });
        expect(output.hookSpecificOutput?.additionalContext).toContain('autopilot');
        expect(readFileSync(globalStatePath)).toEqual(foreignState);
        expect(readFileSync(artifact)).toEqual(before);
        rmSync(artifact, { force: true });
      }
    } finally {
      rmSync(projectA.cwd, { recursive: true, force: true });
      rmSync(projectB.cwd, { recursive: true, force: true });
    }
  });
  it.each([
    ['/autopilot --workflow', 'Use /autopilot --workflow <name> <task>.'],
    ['/autopilot --workflow=release-flow ship it', 'Use --workflow <name> followed by a task.'],
    ['/autopilot --workflow release-flow', 'Provide a task after the workflow name.'],
    ['/autopilot --workflow Release_Flow ship it', 'Workflow name must match'],
    ['/autopilot --workflow unknown-flow ship it', 'workflow profile "unknown-flow" was not found'],
  ])('rejects %s without writing state', (prompt, error) => {
    const { cwd, configHome } = createFixture();
    const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture');
    mkdirSync(statePath, { recursive: true });
    writeFileSync(join(statePath, 'autopilot-state.json'), '{"sentinel":true}\n');
    const before = stateBytes(cwd);
    try {
      for (const script of HOOKS) {
        const output = runHook(script, prompt, cwd, configHome);
        expect(output.hookSpecificOutput?.additionalContext).toContain(`[AUTOPILOT WORKFLOW ERROR] ${error}`);
        expect(stateBytes(cwd)).toEqual(before);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['comma-bearing stage', ['ralplan', 'execution,qa']],
    ['nested stage array', [['ralplan', 'execution']]],
  ])('rejects a %s in plugin and template profile validation', (_name, stages) => {
    const { cwd, configHome } = createFixture();
    try {
      writeFileSync(join(cwd, '.claude', 'omc.jsonc'), JSON.stringify({ autopilot: { workflows: { 'release-flow': { version: 1, stages } } } }));
      for (const script of HOOKS) {
        const output = runHook(script, '/autopilot --workflow release-flow ship it', cwd, configHome);
        expect(output.hookSpecificOutput?.additionalContext).toContain('[AUTOPILOT WORKFLOW ERROR]');
        expect(output.hookSpecificOutput?.additionalContext).toContain('stages must be one of');
        expect(stateBytes(cwd)).toBeNull();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
