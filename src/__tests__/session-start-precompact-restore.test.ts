/**
 * Tests for issue #3730: SessionStart restores the PreCompact checkpoint
 * when the session resumes from compaction (source === 'compact').
 *
 * Exercises the real scripts/session-start.mjs entrypoint the same way
 * Claude Code does (stdin JSON payload), against a built dist tree.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, readFileSync, linkSync, utimesSync } from 'node:fs';
import * as nodeFs from 'fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const TEMPLATE_SCRIPT_PATH = join(__dirname, '..', '..', 'templates', 'hooks', 'session-start.mjs');
const NODE = process.execPath;
const SECURE_MARKER_SUPPORTED = process.platform === 'linux';

function makeProject(root: string): string {
  const project = join(root, 'project');
  // session-start validateCwd requires a real workspace anchor (.git / .omc-workspace)
  mkdirSync(join(project, '.git'), { recursive: true });
  return project;
}

function writeCheckpoint(project: string, createdAt: string, extra: Record<string, unknown> = {}): string {
  const dir = join(project, '.omc', 'state', 'checkpoints');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `checkpoint-${createdAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      created_at: createdAt,
      session_id: 'session-3730',
      trigger: 'auto',
      active_modes: {},
      todo_summary: { pending: 2, in_progress: 1, completed: 4 },
      wisdom_exported: false,
      ...extra,
    }),
    'utf-8',
  );
  return file;
}

interface RunResult {
  stdout: string;
}

function runHook(
  payload: Record<string, unknown>,
  project: string,
  home: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const stdout = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...extraEnv,
      // No plugin root: the restore import is skipped when unset, which is
      // covered separately; with it unset this returns the baseline output.
    },
    timeout: 15000,
  });
  return { stdout };
}

function writeAncestorRedirectPreload(tempDir: string): string {
  const preloadPath = join(tempDir, 'precompact-ancestor-redirect-preload.mjs');
  writeFileSync(
    preloadPath,
    `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const checkpointPath = process.env.OMC_REDIRECT_CHECKPOINT;
const statePath = process.env.OMC_REDIRECT_STATE;
const stateBackupPath = process.env.OMC_REDIRECT_STATE_BACKUP;
const externalState = process.env.OMC_REDIRECT_EXTERNAL_STATE;
const signalPath = process.env.OMC_REDIRECT_SIGNAL;
const originalOpenSync = fs.openSync;
let redirected = false;

fs.openSync = function(path, flags, mode) {
  if (!redirected && String(path) === checkpointPath) {
    redirected = true;
    fs.renameSync(statePath, stateBackupPath);
    fs.symlinkSync(externalState, statePath, 'dir');
    try {
      return originalOpenSync.call(fs, path, flags, mode);
    } finally {
      fs.unlinkSync(statePath);
      fs.renameSync(stateBackupPath, statePath);
      fs.writeFileSync(signalPath, 'redirected');
    }
  }
  return originalOpenSync.call(fs, path, flags, mode);
};
syncBuiltinESMExports();
`,
    'utf-8',
  );
  return preloadPath;
}

function runHookWithPlugin(
  payload: Record<string, unknown>,
  project: string,
  home: string,
): RunResult {
  const stdout = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: join(__dirname, '..', '..'),
    },
    timeout: 15000,
  });
  return { stdout };
}

function runTemplateHook(
  payload: Record<string, unknown>,
  project: string,
  home: string,
): RunResult {
  const stdout = execFileSync(NODE, [TEMPLATE_SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
    timeout: 15000,
  });
  return { stdout };
}

function parseContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext || '';
}

describe('session-start.mjs PreCompact checkpoint restore (issue #3730)', () => {
  let tempDir: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-precompact-session-start-'));
    home = join(tempDir, 'home');
    mkdirSync(home, { recursive: true });
    project = makeProject(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores the newest checkpoint when source=compact', () => {
    writeCheckpoint(project, new Date(Date.now() - 60_000).toISOString());
    writeCheckpoint(
      project,
      new Date().toISOString(),
      {
        plan_refs: {
          boulder: {
            active_plan: '/repo/.omc/plans/epic.md',
            plan_name: 'epic',
            progress: { total: 3, completed: 2, isComplete: false },
          },
        },
      },
    );

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const context = parseContext(stdout);
    if (SECURE_MARKER_SUPPORTED) {
      expect(context).toContain('PRECOMPACT CHECKPOINT RESTORED');
      expect(context).toContain('epic');
      expect(context).toContain('2/3 steps done');
    } else {
      expect(context).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    }
  });

  it('does not restore on plain startup (no source)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const context = parseContext(stdout);
    expect(context).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore on source=startup', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore on source=resume', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore a second time for the same session (replay guard)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const first = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );
    if (SECURE_MARKER_SUPPORTED) {
      expect(parseContext(first.stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
    } else {
      expect(parseContext(first.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    }

    const second = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );
    expect(parseContext(second.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('advances the installed SessionStart marker from checkpoint A to newer B', () => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const t1 = new Date(Date.now() - 2_000).toISOString();
    const checkpointA = writeCheckpoint(project, t1, { session_id: 'marker-advance-installed' });
    const first = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-installed', cwd: project },
      project,
      home,
    );
    expect(parseContext(first.stdout)).toContain(t1);

    const markerPath = join(
      project,
      '.omc',
      'state',
      'checkpoints-restored',
      'marker-advance-installed',
      'restored.json',
    );
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointA);

    const t2 = new Date().toISOString();
    const checkpointB = writeCheckpoint(project, t2, { session_id: 'marker-advance-installed' });
    const second = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-installed', cwd: project },
      project,
      home,
    );
    expect(parseContext(second.stdout)).toContain(t2);
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointB);

    const replay = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-installed', cwd: project },
      project,
      home,
    );
    expect(parseContext(replay.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not commit a restore marker when oversized Priority Context evicts the sentinel', () => {
    if (!SECURE_MARKER_SUPPORTED) return;
    writeCheckpoint(project, new Date().toISOString(), { session_id: 'budgeted-restore-installed' });
    const notepad = join(project, '.omc', 'notepad.md');
    writeFileSync(notepad, `## Priority Context\n${'P'.repeat(7000)}\n`, 'utf-8');

    const first = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'budgeted-restore-installed', cwd: project },
      project,
      home,
    );
    expect(parseContext(first.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(
      existsSync(join(project, '.omc', 'state', 'checkpoints-restored', 'budgeted-restore-installed', 'restored.json')),
    ).toBe(false);

    rmSync(notepad, { force: true });
    const retry = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'budgeted-restore-installed', cwd: project },
      project,
      home,
    );
    expect(parseContext(retry.stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(
      existsSync(join(project, '.omc', 'state', 'checkpoints-restored', 'budgeted-restore-installed', 'restored.json')),
    ).toBe(true);
  });

  it('does not consume a checkpoint when the aggregate budget truncates the restore closing sentinel', () => {
    if (!SECURE_MARKER_SUPPORTED) return;
    writeCheckpoint(project, new Date().toISOString(), { session_id: 'partial-sentinel-installed' });
    const notepad = join(project, '.omc', 'notepad.md');
    writeFileSync(notepad, `## Priority Context\n${'P'.repeat(5450)}\n`, 'utf-8');

    const sessionId = 'partial-sentinel-installed';
    const first = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: sessionId, cwd: project },
      project,
      home,
    );
    const context = parseContext(first.stdout);
    expect(context).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(context).not.toContain('</session-restore>');
    expect(
      existsSync(join(project, '.omc', 'state', 'checkpoints-restored', sessionId, 'restored.json')),
    ).toBe(false);

    rmSync(notepad, { force: true });
    const retry = runHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: sessionId, cwd: project },
      project,
      home,
    );
    expect(parseContext(retry.stdout)).toContain('</session-restore>');
  });

  it('template SessionStart also delivers A then newer B and suppresses B replay', () => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const t1 = new Date(Date.now() - 2_000).toISOString();
    const checkpointA = writeCheckpoint(project, t1, { session_id: 'marker-advance-template' });
    const first = runTemplateHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-template', cwd: project },
      project,
      home,
    );
    expect(parseContext(first.stdout)).toContain(t1);

    const markerPath = join(
      project,
      '.omc',
      'state',
      'checkpoints-restored',
      'marker-advance-template',
      'restored.json',
    );
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointA);

    const t2 = new Date().toISOString();
    const checkpointB = writeCheckpoint(project, t2, { session_id: 'marker-advance-template' });
    const second = runTemplateHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-template', cwd: project },
      project,
      home,
    );
    expect(parseContext(second.stdout)).toContain(t2);
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointB);

    const replay = runTemplateHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'marker-advance-template', cwd: project },
      project,
      home,
    );
    expect(parseContext(replay.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('template SessionStart defers marker commit when Priority Context evicts restore', () => {
    if (!SECURE_MARKER_SUPPORTED) return;
    writeCheckpoint(project, new Date().toISOString(), { session_id: 'budgeted-restore-template' });
    const notepad = join(project, '.omc', 'notepad.md');
    writeFileSync(notepad, `## Priority Context\n${'P'.repeat(7000)}\n`, 'utf-8');

    const first = runTemplateHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'budgeted-restore-template', cwd: project },
      project,
      home,
    );
    expect(parseContext(first.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(
      existsSync(join(project, '.omc', 'state', 'checkpoints-restored', 'budgeted-restore-template', 'restored.json')),
    ).toBe(false);

    rmSync(notepad, { force: true });
    const retry = runTemplateHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'budgeted-restore-template', cwd: project },
      project,
      home,
    );
    expect(parseContext(retry.stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(
      existsSync(join(project, '.omc', 'state', 'checkpoints-restored', 'budgeted-restore-template', 'restored.json')),
    ).toBe(true);
  });

  it.each([
    ['installed', SCRIPT_PATH, true],
    ['template', TEMPLATE_SCRIPT_PATH, false],
  ])('waits out a live lock and reselects in the actual %s SessionStart entrypoint', async (_label, scriptPath, needsPluginRoot) => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const sessionId = `entrypoint-live-lock-${_label}`;
    writeCheckpoint(project, new Date().toISOString(), { session_id: sessionId });
    const markerParent = join(project, '.omc', 'state', 'checkpoints-restored', sessionId);
    mkdirSync(markerParent, { recursive: true });
    const lockPath = join(markerParent, '.restored.json.lock');
    writeFileSync(lockPath, 'live');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...(needsPluginRoot ? { CLAUDE_PLUGIN_ROOT: join(__dirname, '..', '..') } : {}),
    };
    const child = spawn(NODE, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const startedAt = Date.now();
    child.stdin.end(JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: sessionId,
      cwd: project,
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    unlinkSync(lockPath);
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve)), stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(parseContext(stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
  }, 15_000);

  it.each([
    ['installed', join(__dirname, '..', '..', 'scripts', 'lib', 'precompact-restore.mjs'), true],
    ['template', join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs'), true],
    ['dist', join(__dirname, '..', '..', 'dist', 'hooks', 'pre-compact', 'restore.js'), false],
  ])('keeps marker advancement monotonic across delayed %s helper processes', async (_label, helperPath, usesOmcRoot) => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const createdAt = new Date().toISOString();
    const checkpointDir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const payload = JSON.stringify({
      created_at: createdAt,
      session_id: `marker-process-${_label}`,
      trigger: 'auto',
      active_modes: {},
      todo_summary: { pending: 1, in_progress: 0, completed: 0 },
      wisdom_exported: false,
    });
    const checkpointA = join(checkpointDir, 'checkpoint-é.json');
    writeFileSync(checkpointA, payload);
    const sameTime = new Date(Date.now() - 2_000);
    utimesSync(checkpointA, sameTime, sameTime);
    const signal = join(tempDir, `marker-lock-signal-${_label}`);
    const release = join(tempDir, `marker-lock-release-${_label}`);
    const preload = join(tempDir, `marker-lock-preload-${_label}.mjs`);
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalOpenSync = fs.openSync;
let blocked = false;
fs.openSync = function(path, flags, mode) {
  if (!blocked && String(path).endsWith('.restored.json.lock')) {
    blocked = true;
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'ready');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.MARKER_RELEASE)) Atomics.wait(cell, 0, 0, 10);
  }
  return originalOpenSync.call(fs, path, flags, mode);
};
syncBuiltinESMExports();
`);
    const code = `import { restorePreCompactCheckpoint } from ${JSON.stringify(pathToFileURL(helperPath).href)};
const result = restorePreCompactCheckpoint(process.env.OMC_ROOT, process.env.MARKER_SESSION);
process.stdout.write(JSON.stringify(result));`;
    const delayed = spawn(NODE, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code], {
      env: {
        ...process.env,
        OMC_ROOT: usesOmcRoot ? join(project, '.omc') : project,
        MARKER_SESSION: `marker-process-${_label}`,
        MARKER_SIGNAL: signal,
        MARKER_RELEASE: release,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let delayedStdout = '';
    let delayedStderr = '';
    delayed.stdout.setEncoding('utf8');
    delayed.stderr.setEncoding('utf8');
    delayed.stdout.on('data', (chunk) => { delayedStdout += chunk; });
    delayed.stderr.on('data', (chunk) => { delayedStderr += chunk; });
    for (let attempt = 0; attempt < 500 && !existsSync(signal); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(signal)).toBe(true);

    const checkpointB = join(checkpointDir, 'checkpoint-é.json');
    writeFileSync(checkpointB, payload);
    utimesSync(checkpointB, sameTime, sameTime);
    const winner = execFileSync(NODE, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMC_ROOT: usesOmcRoot ? join(project, '.omc') : project,
        MARKER_SESSION: `marker-process-${_label}`,
      },
    });
    expect(JSON.parse(winner)?.text).toContain('checkpoint-é.json');
    writeFileSync(release, 'release');
    const delayedStatus = await new Promise<number | null>((resolve) => delayed.on('close', resolve));
    expect(delayedStatus, delayedStderr).toBe(0);
    expect(JSON.parse(delayedStdout)).toBeNull();

    const markerPath = join(project, '.omc', 'state', 'checkpoints-restored', `marker-process-${_label}`, 'restored.json');
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).checkpoint).toBe(checkpointB);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).checkpoint).not.toBe(checkpointA);
  }, 15_000);

  it.each([
    ['installed', join(__dirname, '..', '..', 'scripts', 'lib', 'precompact-restore.mjs'), true],
    ['template', join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs'), true],
    ['dist', join(__dirname, '..', '..', 'dist', 'hooks', 'pre-compact', 'restore.js'), false],
  ])('delivers only one restore for concurrent duplicate %s claims', async (_label, helperPath, usesOmcRoot) => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const checkpoint = writeCheckpoint(project, new Date().toISOString(), { session_id: `duplicate-${_label}` });
    const signal = join(tempDir, `duplicate-signal-${_label}`);
    const release = join(tempDir, `duplicate-release-${_label}`);
    const preload = join(tempDir, `duplicate-preload-${_label}.mjs`);
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalOpenSync = fs.openSync;
let blocked = false;
fs.openSync = function(path, flags, mode) {
  if (!blocked && String(path).endsWith('.restored.json.lock')) {
    blocked = true;
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'ready');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.MARKER_RELEASE)) Atomics.wait(cell, 0, 0, 10);
  }
  return originalOpenSync.call(fs, path, flags, mode);
};
syncBuiltinESMExports();
`);
    const code = `import { restorePreCompactCheckpoint } from ${JSON.stringify(pathToFileURL(helperPath).href)};
process.stdout.write(JSON.stringify(restorePreCompactCheckpoint(process.env.OMC_ROOT, process.env.MARKER_SESSION)));`;
    const inputRoot = usesOmcRoot ? join(project, '.omc') : project;
    const delayed = spawn(NODE, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code], {
      env: { ...process.env, OMC_ROOT: inputRoot, MARKER_SESSION: `duplicate-${_label}`, MARKER_SIGNAL: signal, MARKER_RELEASE: release },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let delayedStdout = '';
    delayed.stdout.setEncoding('utf8');
    delayed.stdout.on('data', (chunk) => { delayedStdout += chunk; });
    for (let attempt = 0; attempt < 500 && !existsSync(signal); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(signal)).toBe(true);
    const winner = JSON.parse(execFileSync(NODE, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, OMC_ROOT: inputRoot, MARKER_SESSION: `duplicate-${_label}` },
    }));
    expect(winner?.marker_status).toBe('written');
    expect(winner?.text).toContain(basename(checkpoint));
    writeFileSync(release, 'release');
    expect(await new Promise<number | null>((resolve) => delayed.on('close', resolve))).toBe(0);
    expect(JSON.parse(delayedStdout)).toBeNull();
  }, 15_000);

  it.each([
    ['installed', join(__dirname, '..', '..', 'scripts', 'lib', 'precompact-restore.mjs'), true],
    ['template', join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs'), true],
    ['dist', join(__dirname, '..', '..', 'dist', 'hooks', 'pre-compact', 'restore.js'), false],
  ])('reselects a newer checkpoint while a live %s marker lock is held', async (_label, helperPath, usesOmcRoot) => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const sessionId = `live-lock-${_label}`;
    const checkpointDir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const write = (name: string, createdAt: string) => {
      const path = join(checkpointDir, name);
      writeFileSync(path, JSON.stringify({
        created_at: createdAt,
        session_id: sessionId,
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
      }));
      return path;
    };
    const older = write('checkpoint-live-a.json', new Date(Date.now() - 2_000).toISOString());
    const signal = join(tempDir, `live-lock-signal-${_label}`);
    const release = join(tempDir, `live-lock-release-${_label}`);
    const preload = join(tempDir, `live-lock-preload-${_label}.mjs`);
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalLinkSync = fs.linkSync;
let blocked = false;
fs.linkSync = function(source, destination) {
  if (!blocked && String(destination).endsWith('/restored.json')) {
    blocked = true;
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'ready');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.MARKER_RELEASE)) Atomics.wait(cell, 0, 0, 10);
  }
  return originalLinkSync.call(fs, source, destination);
};
syncBuiltinESMExports();
`);
    const code = `import { restorePreCompactCheckpoint } from ${JSON.stringify(pathToFileURL(helperPath).href)};
process.stdout.write(JSON.stringify(restorePreCompactCheckpoint(process.env.OMC_ROOT, process.env.MARKER_SESSION)));`;
    const inputRoot = usesOmcRoot ? join(project, '.omc') : project;
    const spawnClaim = (args: string[], env: NodeJS.ProcessEnv) => {
      const child = spawn(NODE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      return { child, output: () => ({ stdout, stderr }) };
    };
    const env = { ...process.env, OMC_ROOT: inputRoot, MARKER_SESSION: sessionId };
    const first = spawnClaim(
      ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code],
      { ...env, MARKER_SIGNAL: signal, MARKER_RELEASE: release },
    );
    for (let attempt = 0; attempt < 500 && !existsSync(signal); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(signal)).toBe(true);
    const newer = write('checkpoint-live-b.json', new Date().toISOString());
    const second = spawnClaim(['--input-type=module', '-e', code], env);
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(release, 'release');
    expect(await new Promise<number | null>((resolve) => first.child.on('close', resolve)), first.output().stderr).toBe(0);
    expect(await new Promise<number | null>((resolve) => second.child.on('close', resolve)), second.output().stderr).toBe(0);
    expect(JSON.parse(first.output().stdout)?.text).toContain(basename(older));
    expect(JSON.parse(second.output().stdout)?.text).toContain(basename(newer));
    const markerPath = join(project, '.omc', 'state', 'checkpoints-restored', sessionId, 'restored.json');
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).checkpoint).toBe(newer);
  }, 15_000);

  it.each([
    ['installed', join(__dirname, '..', '..', 'scripts', 'lib', 'precompact-restore.mjs'), true],
    ['template', join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs'), true],
    ['dist', join(__dirname, '..', '..', 'dist', 'hooks', 'pre-compact', 'restore.js'), false],
  ])('uses mtime to advance equal-created-at checkpoints in the %s helper', (_label, helperPath, usesOmcRoot) => {
    if (!SECURE_MARKER_SUPPORTED) return;
    const checkpointDir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify({
      created_at: createdAt,
      session_id: `equal-time-${_label}`,
      trigger: 'auto',
      active_modes: {},
      todo_summary: { pending: 1, in_progress: 0, completed: 0 },
      wisdom_exported: false,
    });
    const checkpointA = join(checkpointDir, 'checkpoint-equal-a.json');
    const checkpointB = join(checkpointDir, 'checkpoint-equal-b.json');
    writeFileSync(checkpointA, payload);
    const older = new Date(Date.now() - 2_000);
    utimesSync(checkpointA, older, older);
    const code = `import { restorePreCompactCheckpoint } from ${JSON.stringify(pathToFileURL(helperPath).href)};
process.stdout.write(JSON.stringify(restorePreCompactCheckpoint(process.env.OMC_ROOT, process.env.MARKER_SESSION)));`;
    const inputRoot = usesOmcRoot ? join(project, '.omc') : project;
    const run = () => JSON.parse(execFileSync(NODE, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, OMC_ROOT: inputRoot, MARKER_SESSION: `equal-time-${_label}` },
    }));
    expect(run()?.text).toContain('checkpoint-equal-a.json');
    writeFileSync(checkpointB, payload);
    const newer = new Date();
    utimesSync(checkpointB, newer, newer);
    expect(run()?.text).toContain('checkpoint-equal-b.json');
    expect(run()).toBeNull();
  });

  it('fails open (no restore) on a malformed checkpoint', () => {
    const dir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint-broken.json'), '{not json', 'utf-8');

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('fails open (no restore) when no checkpoints exist', () => {
    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('writes the replay marker under the session-scoped restore directory', () => {
    const file = writeCheckpoint(project, new Date().toISOString());

    runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const markerPath = join(project, '.omc', 'state', 'checkpoints-restored', 'session-3730', 'restored.json');
    expect(existsSync(markerPath)).toBe(SECURE_MARKER_SUPPORTED);
    if (SECURE_MARKER_SUPPORTED) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(marker.checkpoint).toBe(file);
    }
  });

  it('does not restore for a session when the checkpoint belongs to another project', () => {
    // Checkpoint exists only in an unrelated directory.
    const otherProject = makeProject(join(tempDir, 'other'));
    writeCheckpoint(otherProject, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('restores without CLAUDE_PLUGIN_ROOT set (self-contained helper, no dist dependency)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    // The restore helper is inline (scripts/lib), so restore works in a
    // clean checkout with no build step and no plugin root when secure marker
    // publication is available.
    if (SECURE_MARKER_SUPPORTED) {
      expect(parseContext(stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
    } else {
      expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    }
  });
  it('does not restore and does not write a marker for a traversal session ID (P1 security)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: '../../../../../../tmp/escaped-3730-hook-trav',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    // No marker escapes the omc root
    expect(existsSync('/tmp/escaped-3730-hook-trav/restored.json')).toBe(false);
  });

  it('does not restore for separator-containing session IDs', () => {
    writeCheckpoint(project, new Date().toISOString());

    for (const bad of ['a/b', 'a\\b', 'a b', 'a..b']) {
      const { stdout } = runHook(
        {
          hook_event_name: 'SessionStart',
          source: 'compact',
          session_id: bad,
          cwd: project,
        },
        project,
        home,
      );
      expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    }
  });

  it('installed SessionStart helper rejects an in-directory symlink to external JSON', () => {
    const checkpointDir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const marker = 'EXTERNAL_INSTALLED_SYMLINK_CHECKPOINT_MARKER';
    const externalPath = join(tempDir, 'external-installed-checkpoint.json');
    writeFileSync(
      externalPath,
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );
    symlinkSync(externalPath, join(checkpointDir, 'checkpoint-external.json'));

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'installed-symlink-session',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(parseContext(stdout)).not.toContain(marker);
    expect(
      existsSync(
        join(
          project,
          '.omc',
          'state',
          'checkpoints-restored',
          'installed-symlink-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
  });

  it('installed SessionStart helper rejects a symlinked .omc/state ancestor', () => {
    const omcRoot = join(project, '.omc');
    const statePath = join(omcRoot, 'state');
    rmSync(statePath, { recursive: true, force: true });
    mkdirSync(omcRoot, { recursive: true });

    const marker = 'EXTERNAL_INSTALLED_STATE_SYMLINK_CHECKPOINT_MARKER';
    const externalState = join(tempDir, 'external-installed-state');
    const externalCheckpointDir = join(externalState, 'checkpoints');
    mkdirSync(externalCheckpointDir, { recursive: true });
    writeFileSync(
      join(externalCheckpointDir, 'checkpoint-external.json'),
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );
    symlinkSync(externalState, statePath, 'dir');

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'installed-state-symlink-session',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(parseContext(stdout)).not.toContain(marker);
    expect(
      existsSync(
        join(
          externalState,
          'checkpoints-restored',
          'installed-state-symlink-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
  });

  it('installed SessionStart rejects an ancestor redirect between verification and open', () => {
    const checkpointPath = writeCheckpoint(project, new Date().toISOString());
    const checkpointName = checkpointPath.slice(checkpointPath.lastIndexOf('/') + 1);
    const statePath = join(project, '.omc', 'state');
    const stateBackupPath = `${statePath}.verified-backup`;
    const externalState = join(tempDir, 'external-installed-redirect-state');
    const externalCheckpointDir = join(externalState, 'checkpoints');
    const signalPath = join(tempDir, 'installed-redirect-signal');
    const marker = 'EXTERNAL_INSTALLED_ANCESTOR_REDIRECT_CHECKPOINT_MARKER';
    mkdirSync(externalCheckpointDir, { recursive: true });
    writeFileSync(
      join(externalCheckpointDir, checkpointName),
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );
    const preloadPath = writeAncestorRedirectPreload(tempDir);

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'installed-ancestor-redirect-session',
        cwd: project,
      },
      project,
      home,
      {
        NODE_OPTIONS: `--import=${preloadPath}`,
        OMC_REDIRECT_CHECKPOINT: checkpointPath,
        OMC_REDIRECT_STATE: statePath,
        OMC_REDIRECT_STATE_BACKUP: stateBackupPath,
        OMC_REDIRECT_EXTERNAL_STATE: externalState,
        OMC_REDIRECT_SIGNAL: signalPath,
      },
    );

    expect(existsSync(signalPath)).toBe(true);
    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(parseContext(stdout)).not.toContain(marker);
    expect(
      existsSync(
        join(
          project,
          '.omc',
          'state',
          'checkpoints-restored',
          'installed-ancestor-redirect-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          externalState,
          'checkpoints-restored',
          'installed-ancestor-redirect-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
  });
});

// Template/installed parity: both self-contained helper copies must reject
// the same traversal and TOCTOU payloads.
describe('precompact-restore helper parity (issue #3730 security)', () => {
  const TEMPLATE_HELPER = join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs');
  const INSTALLED_HELPER = join(__dirname, '..', '..', 'scripts', 'lib', 'precompact-restore.mjs');

  let tempDir: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-precompact-template-parity-'));
    project = join(tempDir, 'project');
    mkdirSync(join(project, '.omc', 'state', 'checkpoints'), { recursive: true });
    writeFileSync(
      join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json'),
      JSON.stringify({ created_at: new Date().toISOString(), session_id: 'valid-session-3730', trigger: 'auto', active_modes: {}, todo_summary: { pending: 1, in_progress: 0, completed: 0 }, wisdom_exported: false }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects traversal session IDs in the template helper (parity with scripts/)', async () => {
    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href) as { restorePreCompactCheckpoint: (root: string, sid: string) => { text: string } | null };
    const omcRoot = join(project, '.omc');
    const result = mod.restorePreCompactCheckpoint(omcRoot, '../../../../../../tmp/escaped-3730-template-trav');
    expect(result).toBeNull();
    expect(existsSync('/tmp/escaped-3730-template-trav/restored.json')).toBe(false);
  });

  it('rejects an in-directory symlink to external JSON without restoring or marking it', async () => {
    const checkpointDir = join(project, '.omc', 'state', 'checkpoints');
    rmSync(join(checkpointDir, 'checkpoint-now.json'));
    const marker = 'EXTERNAL_TEMPLATE_SYMLINK_CHECKPOINT_MARKER';
    const externalPath = join(tempDir, 'external-checkpoint.json');
    writeFileSync(
      externalPath,
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );
    const linkedPath = join(checkpointDir, 'checkpoint-external.json');
    symlinkSync(externalPath, linkedPath);

    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href) as {
      restorePreCompactCheckpoint: (root: string, sid: string) => { text: string } | null;
    };
    const omcRoot = join(project, '.omc');
    const result = mod.restorePreCompactCheckpoint(omcRoot, 'template-symlink-session');
    expect(result).toBeNull();
    expect(result?.text ?? '').not.toContain(marker);
    expect(
      existsSync(
        join(
          omcRoot,
          'state',
          'checkpoints-restored',
          'template-symlink-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
  });

  it('rejects externally hard-linked checkpoint in both helper copies', async () => {
    const checkpointPath = join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json');
    const externalPath = join(tempDir, 'external-hard-linked-checkpoint.json');
    rmSync(checkpointPath, { force: true });
    writeFileSync(
      externalPath,
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: 'EXTERNAL_PARITY_HARD_LINK_MARKER' } },
      }),
      'utf-8',
    );
    linkSync(externalPath, checkpointPath);

    for (const [helper, suffix] of [
      [TEMPLATE_HELPER, 'template-hard-link'],
      [INSTALLED_HELPER, 'installed-hard-link'],
    ] as const) {
      const mod = await import(`${pathToFileURL(helper).href}?${suffix}`);
      const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix);
      expect(result).toBeNull();
      expect(result?.text ?? '').not.toContain('EXTERNAL_PARITY_HARD_LINK_MARKER');
    }
  });

  it('does not write replay markers outside .omc through a symlinked marker parent', async () => {
    const markerRoot = join(project, '.omc', 'state', 'checkpoints-restored');
    const externalMarkerRoot = join(tempDir, 'external-parity-marker-root');
    mkdirSync(externalMarkerRoot, { recursive: true });
    rmSync(markerRoot, { recursive: true, force: true });
    symlinkSync(externalMarkerRoot, markerRoot, 'dir');

    for (const [helper, suffix] of [
      [TEMPLATE_HELPER, 'template-marker-parent-symlink'],
      [INSTALLED_HELPER, 'installed-marker-parent-symlink'],
    ] as const) {
      const mod = await import(`${pathToFileURL(helper).href}?${suffix}`);
      const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix);
      expect(result).toBeNull();
      const repeated = mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix);
      expect(repeated).toBeNull();
      expect(existsSync(join(externalMarkerRoot, suffix, 'restored.json'))).toBe(false);
    }
  });

  it('does not read or overwrite an external file through a symlinked marker file', async () => {
    const markerRoot = join(project, '.omc', 'state', 'checkpoints-restored');
    const externalMarkerDir = join(tempDir, 'external-parity-marker-file');
    mkdirSync(externalMarkerDir, { recursive: true });

    for (const [helper, suffix] of [
      [TEMPLATE_HELPER, 'template-marker-file-symlink'],
      [INSTALLED_HELPER, 'installed-marker-file-symlink'],
    ] as const) {
      writeFileSync(
        join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json'),
        JSON.stringify({ created_at: new Date().toISOString(), session_id: suffix, trigger: 'auto', active_modes: {}, todo_summary: { pending: 1, in_progress: 0, completed: 0 }, wisdom_exported: false }),
      );
      const markerParent = join(markerRoot, suffix);
      mkdirSync(markerParent, { recursive: true });
      const externalMarker = join(externalMarkerDir, `${suffix}.json`);
      writeFileSync(
        externalMarker,
        JSON.stringify({ checkpoint: join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json') }),
        'utf-8',
      );
      symlinkSync(externalMarker, join(markerParent, 'restored.json'));

      const before = readFileSync(externalMarker, 'utf-8');
      const mod = await import(`${pathToFileURL(helper).href}?${suffix}`);
      const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix);
      expect(result).toBeNull();
      expect(readFileSync(externalMarker, 'utf-8')).toBe(before);
    }
  });

  it('fails closed when a marker parent is replaced after descriptor validation', async () => {
    const markerRoot = join(project, '.omc', 'state', 'checkpoints-restored');
    mkdirSync(markerRoot, { recursive: true });

    for (const [helper, suffix] of [
      [TEMPLATE_HELPER, 'template-marker-parent-race'],
      [INSTALLED_HELPER, 'installed-marker-parent-race'],
    ] as const) {
      writeFileSync(
        join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json'),
        JSON.stringify({ created_at: new Date().toISOString(), session_id: suffix, trigger: 'auto', active_modes: {}, todo_summary: { pending: 1, in_progress: 0, completed: 0 }, wisdom_exported: false }),
      );
      const markerParent = join(markerRoot, suffix);
      const markerParentBackup = `${markerParent}.backup`;
      const externalMarkerParent = join(tempDir, `${suffix}-external`);
      mkdirSync(markerParent, { recursive: true });
      mkdirSync(externalMarkerParent, { recursive: true });
      let swapped = false;
      const originalOpenSync = nodeFs.openSync;
      const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation((path, flags, mode) => {
        if (!swapped && String(path) === markerParent) {
          const fd = originalOpenSync(path, flags, mode);
          swapped = true;
          renameSync(markerParent, markerParentBackup);
          symlinkSync(externalMarkerParent, markerParent, 'dir');
          return fd;
        }
        return originalOpenSync(path, flags, mode);
      });
      try {
        const mod = await import(`${pathToFileURL(helper).href}?${suffix}`);
        const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix);
        expect(result).toBeNull();
        expect(mod.restorePreCompactCheckpoint(join(project, '.omc'), suffix)).toBeNull();
        expect(swapped).toBe(true);
        expect(existsSync(join(externalMarkerParent, 'restored.json'))).toBe(false);
      } finally {
        openSpy.mockRestore();
        if (existsSync(markerParent)) unlinkSync(markerParent);
        if (existsSync(markerParentBackup)) renameSync(markerParentBackup, markerParent);
      }
    }
  });

  it('rejects a symlinked .omc/state ancestor in the template helper', async () => {
    const omcRoot = join(project, '.omc');
    const statePath = join(omcRoot, 'state');
    rmSync(statePath, { recursive: true, force: true });

    const marker = 'EXTERNAL_TEMPLATE_STATE_SYMLINK_CHECKPOINT_MARKER';
    const externalState = join(tempDir, 'external-template-state');
    const externalCheckpointDir = join(externalState, 'checkpoints');
    mkdirSync(externalCheckpointDir, { recursive: true });
    writeFileSync(
      join(externalCheckpointDir, 'checkpoint-external.json'),
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );
    symlinkSync(externalState, statePath, 'dir');

    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href);
    const result = mod.restorePreCompactCheckpoint(omcRoot, 'template-state-symlink-session');
    expect(result).toBeNull();
    expect(result?.text ?? '').not.toContain(marker);
    expect(
      existsSync(
        join(
          externalState,
          'checkpoints-restored',
          'template-state-symlink-session',
          'restored.json',
        ),
      ),
    ).toBe(false);
  });

  it('rejects a template ancestor redirect between verification and open', async () => {
    const checkpointPath = join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json');
    const checkpointName = checkpointPath.slice(checkpointPath.lastIndexOf('/') + 1);
    const omcRoot = join(project, '.omc');
    const statePath = join(omcRoot, 'state');
    const stateBackupPath = `${statePath}.verified-backup`;
    const externalState = join(tempDir, 'external-template-redirect-state');
    const externalCheckpointDir = join(externalState, 'checkpoints');
    const marker = 'EXTERNAL_TEMPLATE_ANCESTOR_REDIRECT_CHECKPOINT_MARKER';
    mkdirSync(externalCheckpointDir, { recursive: true });
    writeFileSync(
      join(externalCheckpointDir, checkpointName),
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );

    let redirected = false;
    const originalOpenSync = nodeFs.openSync;
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation((path, flags, mode) => {
      if (!redirected && String(path) === checkpointPath) {
        redirected = true;
        renameSync(statePath, stateBackupPath);
        symlinkSync(externalState, statePath, 'dir');
        try {
          return originalOpenSync(path, flags, mode);
        } finally {
          unlinkSync(statePath);
          renameSync(stateBackupPath, statePath);
        }
      }
      return originalOpenSync(path, flags, mode);
    });
    try {
      const mod = await import(`${pathToFileURL(TEMPLATE_HELPER).href}?template-ancestor-redirect`);
      const result = mod.restorePreCompactCheckpoint(omcRoot, 'template-ancestor-redirect-session');
      expect(redirected).toBe(true);
      expect(result).toBeNull();
      expect(result?.text ?? '').not.toContain(marker);
      expect(
        existsSync(
          join(
            omcRoot,
            'state',
            'checkpoints-restored',
            'template-ancestor-redirect-session',
            'restored.json',
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(
            externalState,
            'checkpoints-restored',
            'template-ancestor-redirect-session',
            'restored.json',
          ),
        ),
      ).toBe(false);
    } finally {
      openSpy.mockRestore();
      if (existsSync(stateBackupPath)) {
        if (existsSync(statePath)) unlinkSync(statePath);
        renameSync(stateBackupPath, statePath);
      }
    }
  });

  it('keeps the template helper bound to the opened file when its pathname is swapped during read', async () => {
    const checkpointPath = join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json');
    const backupPath = `${checkpointPath}.original`;
    const externalPath = join(tempDir, 'external-template-mutated-checkpoint.json');
    const marker = 'EXTERNAL_TEMPLATE_MUTATION_CHECKPOINT_MARKER';
    writeFileSync(
      externalPath,
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );

    let swapped = false;
    const originalReadSync = nodeFs.readSync;
    const readSpy = vi.spyOn(nodeFs, 'readSync').mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (!swapped) {
        swapped = true;
        renameSync(checkpointPath, backupPath);
        symlinkSync(externalPath, checkpointPath);
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as never);
    try {
      const mod = await import(`${pathToFileURL(TEMPLATE_HELPER).href}?template-mutation`);
      const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), 'template-mutation-session');
      expect(swapped).toBe(true);
      expect(result).toBeNull();
      expect(result?.text ?? '').not.toContain(marker);
    } finally {
      readSpy.mockRestore();
      rmSync(checkpointPath, { force: true });
      renameSync(backupPath, checkpointPath);
    }
  });

  it('keeps the installed helper bound to the opened file when its pathname is swapped during read', async () => {
    const checkpointPath = join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json');
    const backupPath = `${checkpointPath}.original`;
    const externalPath = join(tempDir, 'external-installed-mutated-checkpoint.json');
    const marker = 'EXTERNAL_INSTALLED_MUTATION_CHECKPOINT_MARKER';
    writeFileSync(
      externalPath,
      JSON.stringify({
        created_at: new Date().toISOString(),
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 1, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        plan_refs: { prd: { title: marker } },
      }),
      'utf-8',
    );

    let swapped = false;
    const originalReadSync = nodeFs.readSync;
    const readSpy = vi.spyOn(nodeFs, 'readSync').mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (!swapped) {
        swapped = true;
        renameSync(checkpointPath, backupPath);
        symlinkSync(externalPath, checkpointPath);
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as never);
    try {
      const mod = await import(`${pathToFileURL(INSTALLED_HELPER).href}?installed-mutation`);
      const result = mod.restorePreCompactCheckpoint(join(project, '.omc'), 'installed-mutation-session');
      expect(swapped).toBe(true);
      expect(result).toBeNull();
      expect(result?.text ?? '').not.toContain(marker);
    } finally {
      readSpy.mockRestore();
      rmSync(checkpointPath, { force: true });
      renameSync(backupPath, checkpointPath);
    }
  });

  it('restores a valid session ID in the template helper (parity with scripts/)', async () => {
    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href) as {
      restorePreCompactCheckpoint: (
        root: string,
        sid: string,
      ) => { text: string; marker_status: string } | null;
    };
    const omcRoot = join(project, '.omc');
    const result = mod.restorePreCompactCheckpoint(omcRoot, 'valid-session-3730');
    if (process.platform === 'linux') {
      expect(result).not.toBeNull();
      expect(result!.text).toContain('PRECOMPACT CHECKPOINT RESTORED');
      expect(result!.marker_status).toBe('written');
    } else {
      expect(result).toBeNull();
    }
  });

  it.each([
    ['installed', INSTALLED_HELPER, true],
    ['template', TEMPLATE_HELPER, true],
    ['dist', join(__dirname, '..', '..', 'dist', 'hooks', 'pre-compact', 'restore.js'), false],
  ])('does not restore a %s checkpoint into a different session', async (_label, helper, usesOmcRoot) => {
    const mod = await import(`${pathToFileURL(helper).href}?cross-session`) as {
      restorePreCompactCheckpoint: (root: string, sid: string) => { text: string } | null;
    };
    const root = usesOmcRoot ? join(project, '.omc') : project;
    expect(mod.restorePreCompactCheckpoint(root, 'different-session')).toBeNull();
  });
});
