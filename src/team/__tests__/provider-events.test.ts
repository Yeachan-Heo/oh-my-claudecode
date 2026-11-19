import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLaunchArgs } from '../model-contract.js';
import {
  parseLatestProviderEvent,
  providerEventSettingsPath,
  readLatestProviderEvent,
  withProviderEventSettingsArgs,
  writeProviderEventSettings,
} from '../provider-events.js';

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

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
      'null',
      '',
    ].join('\n');
    expect(parseLatestProviderEvent(content, 'a1')).toEqual({ event: 'SessionStart', at: 1000 });
  });

  it('returns none for empty content', () => {
    expect(parseLatestProviderEvent('', 'a1')).toEqual({ event: 'none' });
  });
});

describe('readLatestProviderEvent', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-events-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns none when the file does not exist', async () => {
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('returns none without an attempt id', async () => {
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'workers', 'worker-1', 'provider-events.jsonl'),
      line({ v: 1, event: 'Stop', at: 1, attempt: 'a1' }));
    expect(await readLatestProviderEvent(root, 'worker-1', undefined)).toEqual({ event: 'none' });
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

describe('provider event hook', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-event-hook-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
    const env = { OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' };
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
      expect(typeof record.at).toBe('number');
    }
    // An API error ends the turn with StopFailure and no Stop (E0 scenario 4).
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toMatchObject({ event: 'StopFailure' });
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
});
