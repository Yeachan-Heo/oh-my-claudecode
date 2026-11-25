import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLaunchArgs } from '../model-contract.js';
import {
  ensureProviderEventsLog,
  parseLatestProviderEvent,
  providerEventSettingsPath,
  readLatestProviderEvent,
  withProviderEventSettingsArgs,
  writeProviderEventSettings,
} from '../provider-events.js';

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

// The team root, its state/ and state/team/ parents and its workers/ lie below
// the storage anchor, where assertTeamStatePathSafe() refuses a symlink. Builds
// <base>/.omc/state/team/demo with `component` a symlink into `outside`, which
// holds workers/worker-1/provider-events.jsonl; returns the team root.
const TEAM_PATH = ['state', 'team', 'demo'] as const;
const WORKERS_PATH = [...TEAM_PATH, 'workers'] as const;
function linkTeamPathComponent(base: string, outside: string, component: (typeof WORKERS_PATH)[number], content: string): string {
  const at = WORKERS_PATH.indexOf(component);
  const realParent = join(base, '.omc', ...WORKERS_PATH.slice(0, at));
  const workerDir = join(outside, ...WORKERS_PATH.slice(at), 'worker-1');
  mkdirSync(realParent, { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'provider-events.jsonl'), content);
  symlinkSync(join(outside, component), join(realParent, component));
  return join(base, '.omc', ...TEAM_PATH);
}

// Fixtures live at <temp>/.omc/state/team/demo like production, so the
// ancestor check never meets a symlinked temp dir (TMPDIR=/tmp on macOS).
// The fixtures and ensureProviderEventsLog() resolve state for cwd `base` to
// <base>/.omc only without a centralized state dir.
const inheritedStateDir = process.env.OMC_STATE_DIR;
beforeEach(() => { delete process.env.OMC_STATE_DIR; });
afterEach(() => {
  if (inheritedStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = inheritedStateDir;
});

function makeTeamRoot(prefix: string): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  // A repository, so state for cwd `base` resolves to <base>/.omc.
  execFileSync('git', ['init', '-q', base]);
  const root = join(base, '.omc', ...TEAM_PATH);
  mkdirSync(root, { recursive: true });
  return { base, root };
}

describe('parseLatestProviderEvent', () => {
  it('returns the latest event of the current attempt only', () => {
    const content = [
      line({ v: 1, event: 'SessionStart', at: 1000, attempt: 'a1' }),
      line({ v: 1, event: 'UserPromptSubmit', at: 2000, attempt: 'a1' }),
      line({ v: 1, event: 'Stop', at: 9000, attempt: 'other' }),
    ].join('');
    expect(parseLatestProviderEvent(content, 'a1')).toEqual({ event: 'UserPromptSubmit', at: 2000 });
    expect(parseLatestProviderEvent(content, 'other')).toEqual({ event: 'Stop', at: 9000 });
  });

  it('reads StopFailure as the latest event', () => {
    const content = [
      line({ v: 1, event: 'UserPromptSubmit', at: 1000, attempt: 'a1' }),
      line({ v: 1, event: 'StopFailure', at: 1646, attempt: 'a1' }),
    ].join('');
    expect(parseLatestProviderEvent(content, 'a1')).toEqual({ event: 'StopFailure', at: 1646 });
  });

  it('returns none when only other attempts wrote lines', () => {
    expect(parseLatestProviderEvent(line({ v: 1, event: 'Stop', at: 1, attempt: 'old' }), 'new'))
      .toEqual({ event: 'none' });
  });

  it('skips broken lines, v other than 1, unknown events and bad times', () => {
    const content = [
      line({ v: 1, event: 'SessionStart', at: 1000, attempt: 'a1' }),
      '{"v":1,"event":"Stop","at":',
      'not json',
      line({ v: 2, event: 'Stop', at: 5000, attempt: 'a1' }),
      line({ event: 'Stop', at: 5000, attempt: 'a1' }),
      line({ v: 1, event: 'PreToolUse', at: 5000, attempt: 'a1' }),
      line({ v: 1, event: 'Stop', at: '5000', attempt: 'a1' }),
      '{"v":1,"event":"Stop","at":1e999,"attempt":"a1"}',
      'null',
      '',
    ].join('\n');
    expect(parseLatestProviderEvent(content, 'a1')).toEqual({ event: 'SessionStart', at: 1000 });
  });

  it('picks the latest time, not the last line, and the later line on a tie', () => {
    const outOfOrder = [
      line({ v: 1, event: 'UserPromptSubmit', at: 2000, attempt: 'a1' }),
      line({ v: 1, event: 'SessionStart', at: 1000, attempt: 'a1' }),
    ].join('');
    expect(parseLatestProviderEvent(outOfOrder, 'a1')).toEqual({ event: 'UserPromptSubmit', at: 2000 });
    const tie = [
      line({ v: 1, event: 'UserPromptSubmit', at: 2000, attempt: 'a1' }),
      line({ v: 1, event: 'Stop', at: 2000, attempt: 'a1' }),
    ].join('');
    expect(parseLatestProviderEvent(tie, 'a1')).toEqual({ event: 'Stop', at: 2000 });
  });

  it('returns none for empty content', () => {
    expect(parseLatestProviderEvent('', 'a1')).toEqual({ event: 'none' });
  });
});

// File access refuses symlinks only off Windows; on Windows the reader always returns none.
describe.skipIf(process.platform === 'win32')('readLatestProviderEvent', () => {
  let base = '';
  let root = '';
  beforeEach(() => { ({ base, root } = makeTeamRoot('provider-events-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('returns none when the file does not exist', async () => {
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('returns none without an attempt id', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    // The second line has no attempt, so only the guard keeps it from matching an undefined id.
    writeFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'),
      line({ v: 1, event: 'Stop', at: 1, attempt: 'a1' }) + line({ v: 1, event: 'Stop', at: 2 }));
    expect(await readLatestProviderEvent(root, 'worker-1', undefined)).toEqual({ event: 'none' });
  });

  it('returns none on Windows, where O_NOFOLLOW cannot refuse a symlinked leaf', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'),
      line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('returns none for a symlinked file or worker directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-events-outside-'));
    try {
      const target = join(outside, 'events.jsonl');
      writeFileSync(target, line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
      mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
      symlinkSync(target, join(root, 'workers', 'worker-1', 'provider-events.jsonl'));
      expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
      writeFileSync(join(outside, 'provider-events.jsonl'), line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
      symlinkSync(outside, join(root, 'workers', 'worker-2'));
      expect(await readLatestProviderEvent(root, 'worker-2', 'a1')).toEqual({ event: 'none' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(WORKERS_PATH)('returns none when the %s directory above the worker is a symlink', async component => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-events-outside-'));
    try {
      const teamRoot = linkTeamPathComponent(join(base, 'linked'), outside, component, line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
      expect(await readLatestProviderEvent(teamRoot, 'worker-1', 'a1')).toEqual({ event: 'none' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // lstat("<root>/") follows a symlinked root; a stored root may end in a slash.
  it('returns none when a team root given with a trailing slash is a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-events-outside-'));
    try {
      const teamRoot = linkTeamPathComponent(join(base, 'linked'), outside, 'demo', line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
      expect(await readLatestProviderEvent(`${teamRoot}/`, 'worker-1', 'a1')).toEqual({ event: 'none' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('returns none at once for a FIFO', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'workers', 'worker-1', 'provider-events.jsonl')]);
    const timedOut = Symbol('timed out');
    const result = await Promise.race([
      readLatestProviderEvent(root, 'worker-1', 'a1'),
      new Promise(resolve => setTimeout(() => resolve(timedOut), 2_000)),
    ]);
    expect(result).toEqual({ event: 'none' });
  });

  it('reads the worker file', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'),
      line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'Stop', at: 7 });
  });
});

describe('withProviderEventSettingsArgs', () => {
  const stateRoot = '/repo/.omc/state/team/demo';
  const settings = ['--settings', providerEventSettingsPath(stateRoot)];
  let savedKey: string | undefined;
  beforeEach(() => { savedKey = process.env.ANTHROPIC_API_KEY; });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  const extraFlagSets: string[][] = [[], ['--verbose'], ['--bare'], ['--bare', '--verbose']];
  for (const apiKey of [undefined, 'sk-test']) {
    for (const extraFlags of extraFlagSets) {
      it(`claude argv differs only by --settings (api key ${apiKey ? 'set' : 'unset'}, extraFlags ${JSON.stringify(extraFlags)})`, () => {
        if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = apiKey;
        const base = buildLaunchArgs('claude', { teamName: 'demo', workerName: 'worker-1', cwd: '/repo', model: 'sonnet', extraFlags });
        const head = withProviderEventSettingsArgs('claude', base, stateRoot);
        if (base.includes('--bare')) {
          expect(head).toEqual(base);
          expect(head).not.toContain('--settings');
        } else {
          expect(head).toEqual([...base, ...settings]);
        }
      });
    }
  }

  it('API key implies --bare and no --settings', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const head = withProviderEventSettingsArgs('claude', buildLaunchArgs('claude', { teamName: 'demo', workerName: 'w', cwd: '/repo' }), stateRoot);
    expect(head).toContain('--bare');
    expect(head).not.toContain('--settings');
  });

  it('leaves other providers unchanged', () => {
    for (const provider of ['codex', 'cursor', 'gemini'] as const) {
      const base = buildLaunchArgs(provider, { teamName: 'demo', workerName: 'w', cwd: '/repo' });
      expect(withProviderEventSettingsArgs(provider, base, stateRoot)).toEqual(base);
    }
  });
});

describe.skipIf(process.platform === 'win32')('provider event hook', () => {
  let base = '';
  let root = '';
  beforeEach(() => { ({ base, root } = makeTeamRoot('provider-event-hook-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  const hookCommand = async (event: string) => {
    const path = await writeProviderEventSettings(root);
    const settings = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    return settings.hooks[event]![0]!.hooks[0]!.command;
  };
  const run = (command: string, env: Record<string, string>) => spawnSync('sh', ['-c', command], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });

  it('writes one settings file per team with the four events and no attempt id', async () => {
    const path = await writeProviderEventSettings(root);
    expect(path).toBe(join(root, 'provider-event-hooks.json'));
    const text = readFileSync(path, 'utf8');
    const settings = JSON.parse(text) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']);
    expect(text).not.toMatch(/attempt/i);
    const command = await hookCommand('Stop');
    expect(command.startsWith(`'${process.execPath}' `)).toBe(true);
    expect(command).toMatch(/scripts\/team-provider-event-hook\.mjs' Stop$/);
    const script = command.match(/' '([^']+team-provider-event-hook\.mjs)'/)![1]!;
    expect(existsSync(script)).toBe(true);
  });

  it('appends one v1 line for the current attempt and prints nothing', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    await ensureProviderEventsLog(base, 'demo', 'worker-1');
    const env = { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' };
    const startedAt = Date.now();
    for (const event of ['SessionStart', 'UserPromptSubmit', 'StopFailure']) {
      const result = run(await hookCommand(event), env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    }
    const lines = readFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8').trim().split('\n')
      .map(text => JSON.parse(text) as Record<string, unknown>);
    expect(lines.map(record => record.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'StopFailure']);
    for (const record of lines) {
      expect(Object.keys(record)).toEqual(['v', 'event', 'at', 'attempt']);
      expect(record.v).toBe(1);
      expect(record.attempt).toBe('a1');
      expect(record.at).toBeGreaterThanOrEqual(startedAt);
      expect(record.at).toBeLessThanOrEqual(Date.now());
    }
    // An API error ends the turn with StopFailure and no Stop (E0 scenario 4).
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toMatchObject({ event: 'StopFailure' });
  });

  it('does not write through a symlinked file or worker directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-event-hook-outside-'));
    try {
      const command = await hookCommand('Stop');
      mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
      const target = join(outside, 'events.jsonl');
      writeFileSync(target, '');
      symlinkSync(target, join(root, 'workers', 'worker-1', 'provider-events.jsonl'));
      // worker-2 resolves into `outside`, where a log already waits to be appended to.
      writeFileSync(join(outside, 'provider-events.jsonl'), '');
      symlinkSync(outside, join(root, 'workers', 'worker-2'));
      // A dangling leaf link: following it with O_CREAT would create its target outside the team.
      mkdirSync(join(root, 'workers', 'worker-3'));
      symlinkSync(join(outside, 'created.jsonl'), join(root, 'workers', 'worker-3', 'provider-events.jsonl'));
      for (const worker of ['worker-1', 'worker-2', 'worker-3']) {
        const result = run(command, { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: `demo/${worker}`, OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
      expect(readFileSync(target, 'utf8')).toBe('');
      expect(readFileSync(join(outside, 'provider-events.jsonl'), 'utf8')).toBe('');
      expect(existsSync(join(outside, 'created.jsonl'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(WORKERS_PATH)('does not write when the %s directory above the worker is a symlink', async component => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-event-hook-outside-'));
    try {
      const command = await hookCommand('Stop');
      const teamRoot = linkTeamPathComponent(join(base, 'linked'), outside, component, '');
      const result = run(command, { OMC_TEAM_STATE_ROOT: teamRoot, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(readFileSync(join(outside, ...WORKERS_PATH.slice(WORKERS_PATH.indexOf(component)), 'worker-1', 'provider-events.jsonl'), 'utf8')).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not write when a team root given with a trailing slash is a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'provider-event-hook-outside-'));
    try {
      const command = await hookCommand('Stop');
      const teamRoot = linkTeamPathComponent(join(base, 'linked'), outside, 'demo', '');
      const result = run(command, { OMC_TEAM_STATE_ROOT: `${teamRoot}/`, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(readFileSync(join(outside, 'demo', 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8')).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('exits 0 at once when the path is a FIFO', async () => {
    const command = await hookCommand('Stop');
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    const fifo = join(root, 'workers', 'worker-1', 'provider-events.jsonl');
    execFileSync('mkfifo', [fifo]);
    const result = spawnSync('sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '', OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('writes nothing into a FIFO that has a reader', async () => {
    const command = await hookCommand('Stop');
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    const fifo = join(root, 'workers', 'worker-1', 'provider-events.jsonl');
    execFileSync('mkfifo', [fifo]);
    // The read-write descriptor is the reader, so the hook's non-blocking open succeeds.
    const reader = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      const result = run(command, { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' });
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
      let pending = '';
      try {
        const buffer = Buffer.alloc(4096);
        pending = buffer.subarray(0, readSync(reader, buffer)).toString('utf8');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('EAGAIN');
      }
      expect(pending).toBe('');
    } finally {
      closeSync(reader);
    }
  });

  it('exits 0 silently and creates nothing when it cannot write', async () => {
    const command = await hookCommand('Stop');
    const envs: Array<Record<string, string>> = [
      { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1' },
      { OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/..', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
    ];
    for (const env of envs) {
      const result = run(command, env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    }
    expect(existsSync(join(root, 'workers'))).toBe(false);
  });

  it('writes nothing when the event argument is omitted', () => {
    const hook = join(__dirname, '..', '..', '..', 'scripts', 'team-provider-event-hook.mjs');
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'), '');
    const result = spawnSync(process.execPath, [hook], {
      env: { PATH: process.env.PATH ?? '', OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      encoding: 'utf8',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(readFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8')).toBe('');
  });

  it('creates no log when the launch did not create one', () => {
    const hook = join(__dirname, '..', '..', '..', 'scripts', 'team-provider-event-hook.mjs');
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    const result = spawnSync(process.execPath, [hook, 'Stop'], {
      env: { PATH: process.env.PATH ?? '', OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      encoding: 'utf8',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(existsSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'))).toBe(false);
  });

  it('writes nothing for a bad event name, a missing attempt, state root or worker, or an unsafe worker name', () => {
    const hook = join(__dirname, '..', '..', '..', 'scripts', 'team-provider-event-hook.mjs');
    for (const worker of ['worker-1', 'w..1', '-w1', 'w 1']) {
      mkdirSync(join(root, 'workers', worker), { recursive: true });
      writeFileSync(join(root, 'workers', worker, 'provider-events.jsonl'), '');
    }
    writeFileSync(join(root, 'workers', 'provider-events.jsonl'), '');
    const good = { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' };
    const cases: Array<{ event: string; env: Record<string, string> }> = [
      { event: '', env: good },
      { event: 'Not-An-Event', env: good },
      { event: 'Stop', env: { ...good, OMC_WORKER_LAUNCH_ATTEMPT_ID: '' } },
      // Run from the team root, so a relative fallback would land on workers/worker-1.
      { event: 'Stop', env: { ...good, OMC_TEAM_STATE_ROOT: '' } },
      { event: 'Stop', env: { OMC_TEAM_STATE_ROOT: root, OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' } },
      // An empty worker name would put the file in workers/ itself.
      { event: 'Stop', env: { ...good, OMC_TEAM_WORKER: 'demo/' } },
      { event: 'Stop', env: { ...good, OMC_TEAM_WORKER: 'demo/w..1' } },
      // So would a worker named `.`, which starts with no letter or digit.
      { event: 'Stop', env: { ...good, OMC_TEAM_WORKER: 'demo/.' } },
      { event: 'Stop', env: { ...good, OMC_TEAM_WORKER: 'demo/-w1' } },
      { event: 'Stop', env: { ...good, OMC_TEAM_WORKER: 'demo/w 1' } },
    ];
    for (const { event, env } of cases) {
      const result = spawnSync(process.execPath, [hook, event], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      });
      expect({ event, env, status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ event, env, status: 0, stdout: '', stderr: '' });
      for (const worker of ['', 'worker-1', 'w..1', '-w1', 'w 1']) {
        expect({ event, env, written: readFileSync(join(root, 'workers', worker, 'provider-events.jsonl'), 'utf8') })
          .toEqual({ event, env, written: '' });
      }
    }
    // The same environment with a good event does write, so the cases above fail on their guard.
    expect(spawnSync(process.execPath, [hook, 'Stop'], { cwd: root, env: { PATH: process.env.PATH ?? '', ...good } }).status).toBe(0);
    expect(readFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8')).toMatch(/"event":"Stop"/);
  });
});

describe.skipIf(process.platform === 'win32')('ensureProviderEventsLog', () => {
  let base = '';
  let root = '';
  let outside = '';
  beforeEach(() => {
    ({ base, root } = makeTeamRoot('provider-events-log-'));
    outside = mkdtempSync(join(tmpdir(), 'provider-events-log-outside-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('creates an empty log that the reader treats as no event', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    await ensureProviderEventsLog(base, 'demo', 'worker-1');
    const path = join(root, 'workers', 'worker-1', 'provider-events.jsonl');
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('keeps the events of an earlier launch on a relaunch', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    const path = join(root, 'workers', 'worker-1', 'provider-events.jsonl');
    writeFileSync(path, line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
    await ensureProviderEventsLog(base, 'demo', 'worker-1');
    expect(readFileSync(path, 'utf8')).toBe(line({ v: 1, event: 'Stop', at: 7, attempt: 'a1' }));
  });

  it('creates nothing when the worker directory is missing', async () => {
    await expect(ensureProviderEventsLog(base, 'demo', 'worker-1')).rejects.toThrow();
    expect(existsSync(join(root, 'workers'))).toBe(false);
  });

  it('creates nothing outside the team through a symlinked worker directory or leaf', async () => {
    mkdirSync(join(root, 'workers'), { recursive: true });
    symlinkSync(outside, join(root, 'workers', 'worker-1'));
    await expect(ensureProviderEventsLog(base, 'demo', 'worker-1')).rejects.toThrow('team_instance_path_symlink');
    mkdirSync(join(root, 'workers', 'worker-2'));
    symlinkSync(join(outside, 'created.jsonl'), join(root, 'workers', 'worker-2', 'provider-events.jsonl'));
    await expect(ensureProviderEventsLog(base, 'demo', 'worker-2')).rejects.toThrow();
    expect(existsSync(join(outside, 'provider-events.jsonl'))).toBe(false);
    expect(existsSync(join(outside, 'created.jsonl'))).toBe(false);
  });

  it('refuses a FIFO at once', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'workers', 'worker-1', 'provider-events.jsonl')]);
    await expect(ensureProviderEventsLog(base, 'demo', 'worker-1')).rejects.toThrow();
  });
});
