/* global process, URL */
// Team wrapper: the worktree mode default, the warning about dirty tracked files, the worker pane variables, refusals and the quota gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const TEAM = fileURLToPath(new URL('../../../scripts/provider/provider-team.cjs', import.meta.url));
const json = JSON.stringify;

describe.skipIf(process.platform === 'win32')('provider team wrapper', () => {
  let tmp;
  let bin;
  let counter = 0;
  beforeAll(() => {
    tmp = makeTmp('provider-team-');
    // Fake `omc`: argv and the full env go to files named by the environment, the exit code from FAKE_OMC_EXIT.
    bin = join(tmp.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const omc = join(bin, 'omc');
    writeFileSync(omc, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$OMC_FAKE_ARGV"\nenv | sort > "$OMC_FAKE_ENV"\nexit ${OMC_FAKE_EXIT:-0}\n', { mode: 0o755 });
    chmodSync(omc, 0o755);
  });
  afterAll(() => tmp.cleanup());

  // A fresh profile fixture and a runner of the wrapper with the fake omc first on PATH.
  const fixture = (overrides = {}) => {
    const dir = join(tmp.dir, `f${++counter}`);
    mkdirSync(join(dir, 'home'), { recursive: true });
    const p = writeProfile(dir, overrides);
    const run = (extraEnv = {}, cwd = dir) => {
      const out = join(dir, `run${++counter}`);
      mkdirSync(out, { recursive: true });
      const env = { ...p.env, PATH: `${bin}:${process.env.PATH}`, OMC_FAKE_ARGV: join(out, 'argv'), OMC_FAKE_ENV: join(out, 'env'), ...extraEnv };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const r = spawnSync(process.execPath, [TEAM, '1:claude:executor', 'task text'], { encoding: 'utf8', env, cwd });
      const read = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : null);
      return { ...r, omcEnv: read('env'), omcArgv: read('argv') };
    };
    return { dir, ...p, run };
  };
  const variable = (r, name) => (r.omcEnv || '').split('\n').find((l) => l.startsWith(`${name}=`));

  // A sample repository: a base commit with a tracked file.
  const sampleRepo = (name) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@localhost');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.gitignore'), '.omc/\n');
    writeFileSync(join(dir, 'file.txt'), 'v1\n');
    expect(git('add', '.gitignore', 'file.txt').status).toBe(0);
    expect(git('commit', '-qm', 'base').status).toBe(0);
    return dir;
  };

  it('(1) without OMC_TEAM_WORKTREE_MODE omc gets named; argv unchanged; PATH starts with the shim directory', () => {
    const f = fixture();
    const r = f.run();
    expect(r.status, r.stderr).toBe(0);
    expect(variable(r, 'OMC_TEAM_WORKTREE_MODE')).toBe('OMC_TEAM_WORKTREE_MODE=named');
    expect(r.omcArgv).toBe('team\n1:claude:executor\ntask text\n');
    expect(variable(r, 'PATH').startsWith(`PATH=${join(f.dir, 'state', 'shims')}:`)).toBe(true);
    expect(variable(r, 'OMC_TRUSTED_CLI_DIRS').startsWith(`OMC_TRUSTED_CLI_DIRS=${join(f.dir, 'state', 'shims')}`)).toBe(true);
    expect(existsSync(join(f.dir, 'state', 'shims', 'claude'))).toBe(true);
  });

  it('(2) an explicit value of the user wins (detached stays); an empty value becomes named', () => {
    const f = fixture();
    expect(variable(f.run({ OMC_TEAM_WORKTREE_MODE: 'detached' }), 'OMC_TEAM_WORKTREE_MODE')).toBe('OMC_TEAM_WORKTREE_MODE=detached');
    expect(variable(f.run({ OMC_TEAM_WORKTREE_MODE: '' }), 'OMC_TEAM_WORKTREE_MODE')).toBe('OMC_TEAM_WORKTREE_MODE=named');
  });

  it('(3) warning about changes of the lead: dirty tracked files go to stderr with their paths, the start goes on', () => {
    const f = fixture();
    const repo = sampleRepo('repo-warning');
    writeFileSync(join(repo, 'file.txt'), 'v2\n');
    const r = f.run({}, repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('changes of the lead are invisible to worktrees');
    expect(r.stderr).toContain('file.txt');
    expect(r.omcArgv).not.toBeNull();
  });

  it('(4) no warning: a clean tree, only untracked files and only .omc/', () => {
    const f = fixture();
    const repo = sampleRepo('repo-clean');
    expect(f.run({}, repo).stderr).toBe('');
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    expect(f.run({}, repo).stderr).toBe('');
    mkdirSync(join(repo, '.omc'), { recursive: true });
    writeFileSync(join(repo, '.omc', 'state.txt'), 'x\n');
    expect(f.run({}, repo).stderr).toBe('');
  });

  it('(5) mode disabled (an explicit user value) gives no warning despite dirty files', () => {
    const f = fixture();
    const repo = sampleRepo('repo-disabled');
    writeFileSync(join(repo, 'file.txt'), 'v2\n');
    const r = f.run({ OMC_TEAM_WORKTREE_MODE: 'disabled' }, repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('(14) provider-team refuses (exit 2) in a provider process and with a foreign ANTHROPIC_BASE_URL, before omc starts', () => {
    const f = fixture();
    const a = f.run({ OMC_PROVIDER: 'acme' });
    const b = f.run({ ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic' });
    expect(a.status).toBe(2);
    expect(b.status).toBe(2);
    expect(a.stderr).toMatch(/refused/);
    expect(a.omcArgv).toBeNull();
    expect(b.omcArgv).toBeNull();
  });

  it('(14b) OMC_TEAM_ENGAGED_PANE_RECHECK_MS is 120000 when unset or empty; a value of the caller stays', () => {
    const f = fixture();
    expect(variable(f.run(), 'OMC_TEAM_ENGAGED_PANE_RECHECK_MS')).toBe('OMC_TEAM_ENGAGED_PANE_RECHECK_MS=120000');
    expect(variable(f.run({ OMC_TEAM_ENGAGED_PANE_RECHECK_MS: '45000' }), 'OMC_TEAM_ENGAGED_PANE_RECHECK_MS')).toBe('OMC_TEAM_ENGAGED_PANE_RECHECK_MS=45000');
    expect(variable(f.run({ OMC_TEAM_ENGAGED_PANE_RECHECK_MS: '' }), 'OMC_TEAM_ENGAGED_PANE_RECHECK_MS')).toBe('OMC_TEAM_ENGAGED_PANE_RECHECK_MS=120000');
  });

  it('the profile selectors reach the worker pane: the profiles file as an absolute path, the profile name and the set OMC_PROVIDER_* names in the pass-through list', () => {
    const f = fixture();
    const r = f.run({ OMC_PROVIDER_ROLES: 'executor,tester', OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'OMC_OTHER' });
    expect(r.status, r.stderr).toBe(0);
    expect(variable(r, 'OMC_PROVIDER_PROFILES_FILE')).toBe(`OMC_PROVIDER_PROFILES_FILE=${f.file}`);
    expect(variable(r, 'OMC_PROVIDER_PROFILE')).toBe('OMC_PROVIDER_PROFILE=acme');
    const names = variable(r, 'OMC_TEAM_WORKER_ENV_PASSTHROUGH').split('=')[1].split(',');
    for (const name of ['OMC_OTHER', 'OMC_PROVIDER_PROFILES_FILE', 'OMC_PROVIDER_PROFILE', 'OMC_PROVIDER_ROLES']) expect(names, name).toContain(name);
    expect(names.filter((n) => n === 'OMC_PROVIDER_PROFILE').length).toBe(1);
  });

  it('an env key source (apiKey.env) is forwarded to the worker panes by name, so the provider role can read the key; a file key source adds no name', () => {
    const f = fixture({ apiKey: { env: 'ACME_API_KEY' } });
    const r = f.run({ ACME_API_KEY: 'not-printed-key-0123456789', OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'OMC_OTHER' });
    expect(r.status, r.stderr).toBe(0);
    const names = variable(r, 'OMC_TEAM_WORKER_ENV_PASSTHROUGH').split('=')[1].split(',');
    expect(names).toContain('ACME_API_KEY');
    expect(names).toContain('OMC_OTHER');
    expect(r.stdout + r.stderr).not.toContain('not-printed-key-0123456789');
    const file = fixture();
    const g = file.run({ ACME_API_KEY: 'unrelated' });
    expect(variable(g, 'OMC_TEAM_WORKER_ENV_PASSTHROUGH').split('=')[1].split(',')).not.toContain('ACME_API_KEY');
  });

  it('OMC_TEAM_TASK_LEASE_MS is not set by the wrapper', () => {
    expect(variable(fixture().run(), 'OMC_TEAM_TASK_LEASE_MS')).toBeUndefined();
  });

  it('a missing profile: exit 2 with a message, omc not started', () => {
    const f = fixture();
    const r = f.run({ OMC_PROVIDER_PROFILES_FILE: join(f.dir, 'missing.jsonc') });
    expect(r.status).toBe(2);
    expect(r.omcArgv).toBeNull();
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('a breaker written after a quota refusal blocks the start with exit 4 and omc is not started', () => {
    const f = fixture({ quota: { adapter: 'monitor-limits', url: 'https://quota.acme.example/limit' } });
    const state = join(f.dir, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'breaker.json'), json({ until: Date.now() + 600_000, class: 'quota', limit: 'week', percent: 100, reset: Date.now() + 3600_000, level: 'STOP', ts: Date.now() }));
    const r = f.run();
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/quota gate/);
    expect(r.omcArgv).toBeNull();
  });

  it('a start error of omc gives exit 127; the exit code of omc passes on', () => {
    const f = fixture();
    expect(f.run({ OMC_FAKE_EXIT: '7' }).status).toBe(7);
    const none = spawnSync(process.execPath, [TEAM, 'x'], { encoding: 'utf8', env: { ...f.env, PATH: '/nonexistent-dir' }, cwd: f.dir });
    expect(none.status).toBe(127);
  });
});
