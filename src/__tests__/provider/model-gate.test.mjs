/* global process, URL */
// Model gate of the pre-tool hook (forceInherit): ids with a context suffix that belong to a
// configured alternative provider pass; everything else keeps the existing denial.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './_helpers.mjs';

const HOOK = fileURLToPath(new URL('../../../scripts/pre-tool-enforcer.mjs', import.meta.url));

describe.skipIf(process.platform === 'win32')('model gate for alternative provider ids with a context suffix', () => {
  let tmp;
  let pluginRoot;
  beforeAll(() => {
    tmp = makeTmp('provider-model-gate-');
    pluginRoot = join(tmp.dir, 'plugin');
    // Agent definition whose model carries the suffix (the agent-definition branch of the gate).
    mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
    writeFileSync(join(pluginRoot, 'agents', 'task-agent.md'), '---\nname: task-agent\nmodel: acme-large[1m]\n---\n\nTest agent body.\n');
  });
  afterAll(() => tmp.cleanup());

  // Task/Agent input; a denial is JSON with hookSpecificOutput.permissionDecision 'deny'.
  const run = (toolInput, extraEnv = {}) => {
    const env = {
      PATH: process.env.PATH,
      HOME: tmp.home,
      USERPROFILE: tmp.home,
      CLAUDE_CONFIG_DIR: join(tmp.home, '.claude'),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      NODE_ENV: 'test',
      OMC_ROUTING_FORCE_INHERIT: 'true', // the Task branch of the gate runs under forceInherit (proxy/Bedrock)
      ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic',
      ANTHROPIC_MODEL: 'acme-large[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'acme-large[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'acme-small[1m]',
      OMC_PROVIDER_MODEL_PREFIXES: 'acme-',
      ...extraEnv,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Task', tool_input: toolInput, session_id: 'model-gate-test', cwd: tmp.dir }),
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
    expect(result.error, 'hook did not start').toBeUndefined();
    let output = null;
    try { output = JSON.parse(result.stdout); } catch { /* no output = allowed */ }
    return { denied: output?.hookSpecificOutput?.permissionDecision === 'deny', stdout: result.stdout.slice(0, 200) };
  };
  const base = { subagent_type: 'oh-my-claudecode:executor', description: 'model gate test' };

  it('(1) Task with model acme-small[1m]: no denial', () => {
    const r = run({ ...base, model: 'acme-small[1m]' });
    expect(r.denied, r.stdout).toBe(false);
  });
  it('(2) Task with model acme-large[1m]: no denial', () => {
    expect(run({ ...base, model: 'acme-large[1m]' }).denied).toBe(false);
  });
  it('(3) Task with the alias sonnet: no denial (resolved through ANTHROPIC_DEFAULT_SONNET_MODEL=acme-large[1m])', () => {
    expect(run({ ...base, model: 'sonnet' }).denied).toBe(false);
  });
  it('(4) Task with a bare Claude id claude-sonnet-5: denial as before (outside the scope of the gate change)', () => {
    expect(run({ ...base, model: 'claude-sonnet-5' }).denied).toBe(true);
  });
  it('(5) Task with a foreign id gpt-5: denial kept (the gate is not opened wider)', () => {
    expect(run({ ...base, model: 'gpt-5' }).denied).toBe(true);
  });
  it('(6) Task without a model while the session ANTHROPIC_MODEL is acme-large[1m]: no denial', () => {
    expect(run(base).denied).toBe(false);
  });
  it('(7) without OMC_PROVIDER_MODEL_PREFIXES: Task with acme-small[1m] is denied as before', () => {
    expect(run({ ...base, model: 'acme-small[1m]' }, { OMC_PROVIDER_MODEL_PREFIXES: undefined }).denied).toBe(true);
  });
  it('(8) without OMC_PROVIDER_MODEL_PREFIXES: Task without a model and a session [1m] suffix is denied as before', () => {
    expect(run(base, { OMC_PROVIDER_MODEL_PREFIXES: undefined }).denied).toBe(true);
  });
  it('(9) a Claude id with the [1m] suffix in CLAUDE_MODEL and a Task without a model: denial kept', () => {
    expect(run(base, { ANTHROPIC_MODEL: 'acme-large[1m]', CLAUDE_MODEL: 'claude-sonnet-5[1m]' }).denied).toBe(true);
  });
  it('(10) agent definition with model: acme-large[1m] and a Task without a model: no denial', () => {
    expect(run({ subagent_type: 'task-agent', description: 'model gate test' }).denied).toBe(false);
  });
});
