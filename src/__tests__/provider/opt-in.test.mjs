/* global process, URL */
// Nothing changes without a profile and without the opt-in variables: the worker wrapper passes calls through,
// the team wrapper refuses, the model gate and the SSRF check behave as before.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnthropicBaseUrl } from '../../utils/ssrf-guard.js';
import { makeTmp } from './_helpers.mjs';

const SCRIPTS = fileURLToPath(new URL('../../../scripts/provider/', import.meta.url));
const HOOK = fileURLToPath(new URL('../../../scripts/pre-tool-enforcer.mjs', import.meta.url));

describe.skipIf(process.platform === 'win32')('opt-in: no profile, no change', () => {
  let tmp;
  let bin;
  beforeAll(() => {
    tmp = makeTmp('provider-opt-in-');
    bin = join(tmp.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // `claude` found by PATH (no OMC_PROVIDER_* variable is used): records argv and the env names.
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.HOME + '/fake.argv', JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(process.env.HOME + '/fake.env', JSON.stringify(Object.keys(process.env).sort()));\n`, { mode: 0o755 });
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(bin, 'omc'), '#!/bin/bash\ntouch "$HOME/omc-was-called"\n', { mode: 0o755 });
    chmodSync(join(bin, 'omc'), 0o755);
  });
  afterAll(() => tmp.cleanup());

  const cleanEnv = () => ({ PATH: `${bin}:${process.env.PATH}`, HOME: tmp.home, LANG: 'C.UTF-8', SOME_VARIABLE: 'kept' });

  it('(1) the worker wrapper in plain mode passes argv and env unchanged to claude', () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'provider-worker.cjs'), '--version', '-p', 'hello'], { encoding: 'utf8', env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp.home, 'fake.argv'), 'utf8'))).toEqual(['--version', '-p', 'hello']);
    expect(JSON.parse(readFileSync(join(tmp.home, 'fake.env'), 'utf8'))).toEqual(Object.keys({ ...cleanEnv() }).sort());
  });

  it('(1b) the worker wrapper for a worker without any profile runs plain claude and writes no files', () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'provider-worker.cjs'), '--model', 'sonnet'], { encoding: 'utf8', env: { ...cleanEnv(), OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_ROLE: 'executor' } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp.home, 'fake.argv'), 'utf8'))).toEqual(['--model', 'sonnet']);
    expect(existsSync(join(tmp.home, '.omc'))).toBe(false);
  });

  it('(2) the team wrapper exits with 2 and a message about the missing profile, and does not run omc', () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'provider-team.cjs'), '1:claude:executor', 'task'], { encoding: 'utf8', env: cleanEnv() });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/profile/);
    expect(existsSync(join(tmp.home, 'omc-was-called'))).toBe(false);
  });

  it('(2b) the task command exits with 2 and a message about the missing profile, runs no omc and no team, and creates no state', () => {
    for (const args of [['start', 'task'], ['list'], ['status', 'a1b2c3d4'], ['doctor']]) {
      const r = spawnSync(process.execPath, [join(SCRIPTS, 'provider-task.cjs'), ...args], { encoding: 'utf8', env: cleanEnv() });
      expect(r.status, `${args[0]}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/profile/);
    }
    expect(existsSync(join(tmp.home, 'omc-was-called'))).toBe(false);
    expect(existsSync(join(tmp.home, '.omc'))).toBe(false);
  });

  it('(3) the model gate of the pre-tool hook denies as before without OMC_PROVIDER_MODEL_PREFIXES', () => {
    const env = { PATH: process.env.PATH, HOME: tmp.home, USERPROFILE: tmp.home, CLAUDE_CONFIG_DIR: join(tmp.home, '.claude'), NODE_ENV: 'test', OMC_ROUTING_FORCE_INHERIT: 'true', ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic', ANTHROPIC_MODEL: 'acme-large[1m]' };
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: 'Task', tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'x', model: 'acme-small[1m]' }, session_id: 'opt-in', cwd: tmp.dir }) });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('(4) validateAnthropicBaseUrl rejects a loopback address as before (no option, no variable)', () => {
    expect(validateAnthropicBaseUrl('http://127.0.0.1:33177').allowed).toBe(false);
    expect(validateAnthropicBaseUrl('http://localhost:33177').allowed).toBe(false);
  });
});
