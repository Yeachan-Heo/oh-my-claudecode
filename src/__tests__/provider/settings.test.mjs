/* global process */
// Settings writer, key-helper command, shims, copy cleanup, worker arguments and the
// compaction switch.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, writeProfile, PLACEHOLDER_KEY } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const settings = require('../../../scripts/provider/lib/settings.cjs');
const { loadProfile } = require('../../../scripts/provider/lib/profile.cjs');

const DAY_MS = 86400_000;

describe.skipIf(process.platform === 'win32')('provider settings', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeTmp('provider-settings-');
  });
  afterAll(() => {
    tmp.cleanup();
  });

  it('(4b) apiKeyHelper run by sh: a key path with an apostrophe, spaces and command substitution injects nothing; stdout is the key', () => {
    const dir = join(tmp.dir, 'k4b');
    mkdirSync(dir, { recursive: true });
    const weirdKey = join(dir, "k'e y $(touch INJECT) ;x");
    writeFileSync(weirdKey, `${PLACEHOLDER_KEY}\n`, { mode: 0o600 });
    const { env } = writeProfile(join(dir, 'profile'), { apiKey: { file: weirdKey } });
    const { profile } = loadProfile(env);
    const command = settings.keyHelperCommand(profile, env);
    const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH, HOME: tmp.home } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(PLACEHOLDER_KEY);
    expect(existsSync(join(dir, 'INJECT'))).toBe(false);
  });

  it('(4b2) the command quotes the helper path and the profile name', () => {
    const command = settings.keyHelperCommand({ name: 'a b', file: undefined }, {}, '/fixture dir/provider-key-helper.cjs');
    expect(command).toBe(`'${process.execPath}' '/fixture dir/provider-key-helper.cjs' --profile 'a b'`);
  });

  it('(4g) copies older than two days are removed at sweep; other files stay', () => {
    const dir = join(tmp.dir, 'copies-4g');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'stale-provider.json');
    const other = join(dir, 'other.json');
    writeFileSync(stale, '{}');
    writeFileSync(other, '{}');
    const old = new Date(Date.now() - 3 * DAY_MS);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    settings.sweepCopies(dir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('(9e) a shim is a script: after its target is removed it exits 3 without calling anything', () => {
    const dir = join(tmp.dir, 'shim-9e');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'worker-target');
    writeFileSync(target, '#!/bin/sh\necho called\n', { mode: 0o755 });
    const { profile } = loadProfile(writeProfile(join(dir, 'profile')).env);
    const shims = settings.installShims(profile, { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER_SHIM_DIR: join(dir, 'shims') }, { target });
    expect(existsSync(join(shims, 'claude'))).toBe(true);
    rmSync(target);
    const run = spawnSync(join(shims, 'claude'), ['-p', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(run.status).toBe(3);
    expect(run.stderr).toMatch(/missing/);
    expect(run.stdout).toBe('');
  });

  it('(9f-shims) only claude and the profile shim names are written by default; extra shims point at their own target', () => {
    const dir = join(tmp.dir, 'shim-9f');
    mkdirSync(dir, { recursive: true });
    const worker = join(dir, 'worker-target');
    const advisor = join(dir, 'advisor-target');
    writeFileSync(worker, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(advisor, '#!/bin/sh\n', { mode: 0o755 });
    const { profile: plain } = loadProfile(writeProfile(join(dir, 'plain')).env);
    const plainDir = settings.installShims(plain, { HOME: tmp.home, OMC_PROVIDER_SHIM_DIR: join(dir, 'plain-shims') }, { target: worker });
    expect(readdirSync(plainDir).sort()).toEqual(['claude']);

    const { profile: named } = loadProfile(writeProfile(join(dir, 'named'), { shimNames: ['claude-wrap'] }).env);
    const namedDir = settings.installShims(named, { HOME: tmp.home, OMC_PROVIDER_SHIM_DIR: join(dir, 'named-shims') }, { target: worker, extra: { 'provider-advisor': advisor } });
    expect(readdirSync(namedDir).sort()).toEqual(['claude', 'claude-wrap', 'provider-advisor']);
    expect(readFileSync(join(namedDir, 'provider-advisor'), 'utf8')).toContain(advisor);
    expect(readFileSync(join(namedDir, 'provider-advisor'), 'utf8')).not.toContain(worker);

    rmSync(advisor);
    const run = spawnSync(join(namedDir, 'provider-advisor'), ['x'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(run.status).toBe(3);
    expect(run.stderr).toMatch(/missing/);
  });

  it('(9f-sweep) sweep removes stale provider and worker copies and keeps unrelated files', () => {
    const copiesDir = join(tmp.dir, 'copies-9f');
    mkdirSync(copiesDir, { recursive: true });
    const longAgo = new Date(Date.now() - 3 * DAY_MS);
    for (const name of ['provider-a-1.json', 'worker-a-1.json', 'lane-1-provider.json', 'other.json']) {
      writeFileSync(join(copiesDir, name), '{}\n');
      utimesSync(join(copiesDir, name), longAgo, longAgo);
    }
    writeFileSync(join(copiesDir, 'provider-new-1.json'), '{}\n');
    settings.sweepCopies(copiesDir);
    expect(readdirSync(copiesDir).sort()).toEqual(['other.json', 'provider-new-1.json']);
  });

  it('(fail-closed) the guard command denies when the guard file is missing or exits with an error; exit 0 passes through', () => {
    const dir = join(tmp.dir, 'guard');
    mkdirSync(dir, { recursive: true });
    const missing = spawnSync('/bin/sh', ['-c', settings.guardCommand(join(dir, 'missing'))], { encoding: 'utf8', input: '{}' });
    expect(missing.stdout).toContain('"permissionDecision":"deny"');
    const failing = join(dir, 'failing');
    writeFileSync(failing, 'process.exit(1)\n');
    const crash = spawnSync('/bin/sh', ['-c', settings.guardCommand(failing)], { encoding: 'utf8', input: '{}' });
    expect(crash.stdout).toContain('"permissionDecision":"deny"');
    const passing = join(dir, 'passing');
    writeFileSync(passing, 'process.exit(0)\n');
    const ok = spawnSync('/bin/sh', ['-c', settings.guardCommand(passing)], { encoding: 'utf8', input: '{}' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('');
  });

  it('addProvider writes the env block, the key helper, the guard hook and the executor permissions', () => {
    const dir = join(tmp.dir, 'add-provider');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'worker-target');
    writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    const { profile } = loadProfile(writeProfile(join(dir, 'profile'), { shimNames: [] }).env);
    const env = { PATH: '/fixture/bin', HOME: tmp.home, OMC_PROVIDER_SHIM_DIR: join(dir, 'shims') };
    const out = settings.addProvider({ existing: true }, {
      profile,
      env,
      file: join(dir, 'copy.json'),
      target,
      guardPath: join(dir, 'guard'),
      executor: true,
    });
    expect(out.existing).toBe(true);
    expect(out.env.OMC_PROVIDER).toBe('acme');
    expect(out.env.OMC_PROVIDER_SETTINGS_FILE).toBe(join(dir, 'copy.json'));
    expect(out.env.OMC_PROVIDER_MODEL_PREFIXES).toBe('acme-');
    expect(out.env.PATH.startsWith(join(dir, 'shims') + ':')).toBe(true);
    expect(out.env.ANTHROPIC_BASE_URL).toBe(profile.baseUrl);
    expect(out.apiKeyHelper).toContain('--profile');
    expect(out.permissions.allow).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob']);
    expect(out.hooks.PreToolUse.at(-1).matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob');
    expect(out.hooks.PreToolUse.at(-1).hooks[0].timeout).toBe(10);
    const withKey = settings.addProvider({ apiKeyHelper: 'old' }, { profile, env, file: 'x', target, guardPath: 'g', key: 'fixture-token' });
    expect(withKey.env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-token');
    expect('apiKeyHelper' in withKey).toBe(false);
  });

  it('(13) jevWithoutCompaction: compaction:active becomes off; bare compaction becomes off; a missing entry is appended; off and empty stay; the rest keeps its order', () => {
    const cases = [
      ['all:active,compaction:active,tool-gate:off,intent:off,panel:off,slop-warning:off,task-size:shadow,session-routing:active', 'all:active,compaction:off,tool-gate:off,intent:off,panel:off,slop-warning:off,task-size:shadow,session-routing:active'],
      ['all:active,compaction', 'all:active,compaction:off'],
      ['all:active', 'all:active,compaction:off'],
      ['compaction:active', 'compaction:off'],
      ['off', 'off'],
      ['', ''],
    ];
    for (const [input, expected] of cases) {
      expect(settings.jevWithoutCompaction(input), input).toBe(expected);
    }
  });

  it('(22b) workerArgs: appends the git rule to an existing --append-system-prompt (both forms), adds its own when absent, drops --dangerously-skip-permissions, leaves arguments after -- untouched', () => {
    const first = settings.workerArgs(['-p', '--dangerously-skip-permissions', '--append-system-prompt', 'OLD', '--', 'PROMPT']);
    expect(first).toEqual(['-p', '--append-system-prompt', `OLD\n${settings.GIT_RULE}`, '--tools', settings.EXECUTOR_TOOLS, '--permission-mode', 'dontAsk', '--', 'PROMPT']);
    const second = settings.workerArgs(['--append-system-prompt=OLD']);
    expect(second).toEqual([`--append-system-prompt=OLD\n${settings.GIT_RULE}`, '--tools', settings.EXECUTOR_TOOLS, '--permission-mode', 'dontAsk']);
    const third = settings.workerArgs(['-p']);
    expect(third.includes('--append-system-prompt')).toBe(true);
    expect(third[third.indexOf('--append-system-prompt') + 1]).toContain('git config');
  });

  it('shimDir is built from the state directory, and OMC_PROVIDER_SHIM_DIR overrides it', () => {
    const dir = join(tmp.dir, 'shimdir');
    const { profile } = loadProfile(writeProfile(dir).env);
    expect(settings.shimDir(profile, {})).toBe(join(dir, 'state', 'shims'));
    expect(settings.shimDir(profile, {}, 'worker')).toBe(join(dir, 'state', 'shims-worker'));
    expect(settings.shimDir(profile, { OMC_PROVIDER_SHIM_DIR: '/fixture/override' })).toBe('/fixture/override');
  });

  it('guardEnv carries the guard lists as JSON', () => {
    const { profile } = loadProfile(writeProfile(join(tmp.dir, 'guardenv')).env);
    const parsed = JSON.parse(settings.guardEnv(profile));
    expect(parsed.blockedCommands).toContain('provider-worker');
    expect(parsed.allowedCommands).toEqual(['provider-advisor']);
  });

  it('guardEnv derives protected patterns for the key file, the profiles file and the settings copies, before the configured ones', () => {
    const dir = join(tmp.dir, 'guardenv-profile');
    const { env } = writeProfile(dir, { guard: { extraProtectedPatterns: ['configured-pattern'] } });
    const { profile } = loadProfile(env);
    const patterns = JSON.parse(settings.guardEnv(profile)).extraProtectedPatterns.map((p) => new RegExp(p));
    const protects = (text) => patterns.some((re) => re.test(text));
    expect(protects('cat /fixture/keys/fake.key')).toBe(true);
    expect(protects('cat ~/.config/claude-omc/providers.jsonc')).toBe(true);
    expect(protects('ls ~/.omc/state/provider/acme/worker-settings')).toBe(true);
    expect(protects('echo configured-pattern')).toBe(true);
    expect(protects('echo not-a-key-file.txt')).toBe(false);
  });
});
