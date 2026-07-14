import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function liveLockOwner() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() });
}

function abandonedLockOwner() {
  return JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() });
}

function stateBytes(cwd: string) {
  const statePath = join(cwd, '.omc', 'state', 'sessions', 'workflow-activation-fixture', 'autopilot-state.json');
  return existsSync(statePath) ? readFileSync(statePath) : null;
}

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-workflow-activation-'));
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

describe('workflow profile activation hook fixtures (#3487)', () => {
  it.each(HOOKS)('activates valid project-over-user workflow profiles through %s', (script) => {
    const { cwd, configHome } = createFixture();
    try {
      const output = runHook(script, '/autopilot --workflow release-flow ship the release', cwd, configHome);
      expect(output.hookSpecificOutput?.additionalContext).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
      expect(JSON.parse(stateBytes(cwd)!.toString())).toMatchObject({
        prompt: 'ship the release',
        workflow: { workflowName: 'release-flow', stages: ['ralplan', 'execution'] },
        pipelineTracking: { activationBoundary: { transcriptPath: join(cwd, 'claude-config', 'projects', 'workflow-activation-fixture.jsonl'), byteOffset: 0, fileIdentity: { inode: expect.any(Number), device: expect.any(Number), size: 0 } } },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
      const before = stateBytes(cwd);
      runHook(script, '/cancel', cwd, configHome);
      expect(stateBytes(cwd)).toEqual(before);
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

  it.each([
    ['/autopilot --workflow', 'Use /autopilot --workflow <name> <task>.'],
    ['/autopilot --workflow=release-flow ship it', 'Use --workflow <name> followed by a task.'],
    ['/autopilot --workflow release-flow --workflow release-flow ship it', 'Specify --workflow exactly once.'],
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
