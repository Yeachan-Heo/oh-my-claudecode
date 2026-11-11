/* global process */
/**
 * Tests for scripts/lib/jev-compaction-state.mjs (classic-hook side of the Jev compaction module):
 * the work-state registry written by PostToolUse/PostToolUseFailure, the move of the module's spool
 * records to compaction.jsonl at SessionStart, `module_missing`, and the hook entry points
 * (session-start.mjs, post-tool-verifier.mjs, post-tool-use-failure.mjs) with and without the point.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { afterSessionStart, foldRegistry, MISSING_MESSAGE, recordCompactionState, REGISTRY_CHARS, registryPath, renderRegistry } from '../../scripts/lib/jev-compaction-state.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const tmp = mkdtempSync(join(tmpdir(), 'jev-compaction-state-'));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ } });

let n = 0;
function setup() {
  const dir = join(tmp, `case-${++n}`);
  const env = { OMC_JEV: 'all:active,compaction:active', TYPESAFE_API_KEY: 'k', OMC_JEV_LOG_DIR: join(dir, 'jev') };
  return { dir, env, sid: `sess-${n}`, spool: join(dir, 'jev', 'compaction-spool'), log: join(dir, 'jev', 'compaction.jsonl') };
}
const post = (env, sid, tool_name, tool_input, extra = {}) => recordCompactionState('post', { session_id: sid, tool_name, tool_input, ...extra }, env);
const fail = (env, sid, tool_name, tool_input, error) => recordCompactionState('failure', { session_id: sid, tool_name, tool_input, error }, env);
function spoolRecord(spool, sid, record, ageMs = 0) {
  mkdirSync(spool, { recursive: true });
  const ts = new Date(Date.now() - ageMs).toISOString();
  const name = `${sid}--${Date.now() - ageMs}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(spool, name), JSON.stringify({ ts, point: 'compaction', event: 'compact', session_id: sid, agent_id: null, ...record }));
  return name;
}
const logRows = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('jev-compaction-state: secret masking keeps commit hashes in the registry', () => {
  it('masks a 40-character hex string in general text but keeps it in the git lines of the registry', () => {
    const { env, sid } = setup();
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(maskSecrets('revert ' + sha)).toBe('revert ***');
    expect(maskSecrets('revert ' + sha, { keepGitHashes: true })).toBe('revert ' + sha);
    expect(maskSecrets('token ' + 'Ab3'.repeat(14), { keepGitHashes: true })).toBe('token ***');
    post(env, sid, 'Bash', { command: 'git revert ' + sha });
    expect(readFileSync(registryPath(sid, undefined, env), 'utf8')).toContain(sha);
  });

  it('reads the camelCase toolInput of a hook input too', () => {
    const { env, sid } = setup();
    recordCompactionState('post', { session_id: sid, tool_name: 'Write', toolInput: { file_path: '/p/camel.ts' } }, env);
    expect(readFileSync(registryPath(sid, undefined, env), 'utf8')).toContain('/p/camel.ts');
  });
});

describe('jev-compaction-state: registry', () => {
  it('writes nothing unless OMC_JEV names compaction (all:active is not enough)', () => {
    const { env, sid } = setup();
    for (const OMC_JEV of [undefined, 'all', 'all:active', 'off']) {
      post({ ...env, OMC_JEV }, sid, 'Write', { file_path: '/p/a.ts' });
      fail({ ...env, OMC_JEV }, sid, 'Bash', { command: 'npm test' }, 'boom');
    }
    post({ ...env, TYPESAFE_API_KEY: undefined }, sid, 'Write', { file_path: '/p/a.ts' });
    expect(existsSync(registryPath(sid, undefined, env))).toBe(false);
    expect(existsSync(join(env.OMC_JEV_LOG_DIR))).toBe(false);
  });

  it('records changed files, repository-changing git commands, tasks and the last unresolved error', () => {
    const { env, sid } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    post(env, sid, 'Edit', { file_path: '/p/b.ts' });
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    post(env, sid, 'Bash', { command: 'git status' });
    post(env, sid, 'Bash', { command: 'git -C /p commit -m "fix" --author "x" && echo token=abcdef1234567890abcdef1234567890ab' });
    post(env, sid, 'Bash', { command: 'git push' });
    post(env, sid, 'TodoWrite', { todos: [{ content: 'write tests', status: 'in_progress' }, { content: 'done one', status: 'completed' }] });
    post(env, sid, 'TaskCreate', { subject: 'review' }, { tool_response: { task: { id: '7' } } });
    post(env, sid, 'TaskCreate', { subject: 'ship' }, { tool_response: 'Task #8 created' });
    post(env, sid, 'TaskUpdate', { taskId: '8', status: 'completed' });
    fail(env, sid, 'Bash', { command: 'npm test -- --run' }, '3 failed');
    post(env, sid, 'Bash', { command: 'ls' });
    const reg = foldRegistry(sid, undefined, env);
    expect(reg.files).toEqual(['/p/b.ts', '/p/a.ts']);
    expect(reg.git).toHaveLength(2);
    expect(reg.git[0]).toMatch(/commit/);
    expect(reg.git[0]).not.toContain('abcdef1234567890');
    expect(reg.git[1]).toBe('git push');
    expect(reg.tasks).toEqual([{ text: 'write tests', status: 'in_progress' }, { id: '7', text: 'review', status: 'pending' }]);
    expect(reg.error).toMatchObject({ tool: 'Bash', text: '3 failed' });
    post(env, sid, 'Bash', { command: 'npm test -- --run --reporter=dot' });
    expect(foldRegistry(sid, undefined, env).error).toBeNull();
  });

  it('keeps separate registries per agent and renders within REGISTRY_CHARS, dropping the oldest files first', () => {
    const { env, sid } = setup();
    for (let i = 0; i < 200; i++) post(env, sid, 'Write', { file_path: `/project/src/some/deep/folder/file-${i}.ts` });
    post(env, sid, 'Write', { file_path: '/sub/only.ts' }, { agent_id: 'agent-1' });
    const text = renderRegistry(sid, undefined, env);
    expect(text.length).toBeLessThanOrEqual(REGISTRY_CHARS);
    expect(text).toMatch(/^\[OMC: work state from before the compaction/);
    expect(text).toContain('file-199.ts');
    expect(text).not.toContain('/sub/only.ts');
    expect(renderRegistry(sid, 'agent-1', env)).toContain('/sub/only.ts');
    expect(renderRegistry('nobody', undefined, env)).toBe('');
  });
});

describe('jev-compaction-state: SessionStart', () => {
  it('does nothing unless OMC_JEV names compaction: the spool stays, no log', () => {
    const { env, sid, spool, log } = setup();
    const name = spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout' });
    for (const OMC_JEV of [undefined, 'all:active']) {
      expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, { ...env, OMC_JEV })).toEqual({});
    }
    expect(readdirSync(spool)).toEqual([name]);
    expect(existsSync(log)).toBe(false);
  });

  it('after a Jev compaction: moves the record to compaction.jsonl and adds no context', () => {
    const { env, sid, spool, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    spoolRecord(spool, sid, { result: 'jev', reduction: 0.5 });
    expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, env)).toEqual({});
    expect(logRows(log)).toEqual([expect.objectContaining({ result: 'jev', reduction: 0.5 })]);
    expect(readdirSync(spool)).toEqual([]);
  });

  it('after the built-in summary (fallback or shadow): adds the registry as context', () => {
    for (const record of [{ result: 'fallback', reason: 'jev_error' }, { result: 'shadow', mode: 'shadow' }]) {
      const { env, sid, spool, log } = setup();
      post(env, sid, 'Write', { file_path: '/p/a.ts' });
      spoolRecord(spool, sid, record);
      const out = afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
      expect(out.context).toMatch(/Changed files \(newest last\): \/p\/a\.ts/);
      expect(out.systemMessage).toBeUndefined();
      expect(logRows(log)).toHaveLength(1);
    }
  });

  it('without a record: module_missing with the registry; one systemMessage after three within a day', () => {
    const { env, sid, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    const outs = [1, 2, 3, 4].map(() => afterSessionStart({ session_id: sid, source: 'compact' }, {}, env));
    expect(outs.map((o) => Boolean(o.context))).toEqual([true, true, true, true]);
    expect(outs.map((o) => o.systemMessage)).toEqual([undefined, undefined, MISSING_MESSAGE, undefined]);
    expect(logRows(log).map((r) => r.event)).toEqual(['module_missing', 'module_missing', 'module_missing', 'module_missing']);
    expect(MISSING_MESSAGE).not.toMatch(/CLAUDE_CODE_ENABLE_FUNCTION_HOOKS/);
  });

  it('a session that started before the module was installed: no module_missing, but the registry still goes in', () => {
    const { dir, env, sid, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    const transcript = join(dir, 'old.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00.000Z' })}\n`);
    const out = afterSessionStart({ session_id: sid, source: 'compact', transcript_path: transcript }, {}, env);
    expect(out.context).toContain('/p/a.ts');
    expect(out.systemMessage).toBeUndefined();
    expect(logRows(log).map((r) => r.event)).toEqual(['session_before_module']);
  });

  it('claims the record of the compacting subagent and leaves the main loop\'s fresh record for its own SessionStart', () => {
    const { env, sid, spool, log } = setup();
    spoolRecord(spool, sid, { result: 'jev' });
    spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout', agent_id: 'abc123' });
    post(env, sid, 'Write', { file_path: '/sub/x.ts' }, { agent_id: 'abc123' });
    const sub = afterSessionStart({ session_id: sid, source: 'compact', transcript_path: `/t/${sid}/subagents/agent-abc123.jsonl` }, {}, env);
    expect(sub.context).toContain('/sub/x.ts');
    expect(logRows(log).map((r) => r.agent_id)).toEqual(['abc123']);
    expect(readdirSync(spool)).toHaveLength(1);
    expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, env)).toEqual({});
    expect(logRows(log).map((r) => r.result)).toEqual(['fallback', 'jev']);
  });

  it('leaves other sessions\' files alone, logs unreadable files, and sweeps week-old files at startup', () => {
    const { env, sid, spool, log } = setup();
    const other = spoolRecord(spool, 'other-session', { result: 'jev' });
    writeFileSync(join(spool, `${sid}--1-broken.json`), '{not json');
    afterSessionStart({ session_id: sid, source: 'resume' }, {}, env);
    expect(logRows(log)).toEqual([expect.objectContaining({ event: 'bad_module_file', session_id: sid, file: `${sid}--1-broken.json` })]);
    expect(readdirSync(spool)).toEqual([other]);
    const old = (Date.now() - 8 * 24 * 3600_000) / 1000;
    utimesSync(join(spool, other), old, old);
    post(env, 'stale', 'Write', { file_path: '/p/a.ts' });
    utimesSync(registryPath('stale', undefined, env), old, old);
    afterSessionStart({ session_id: sid, source: 'startup' }, {}, env);
    expect(readdirSync(spool)).toEqual([]);
    expect(existsSync(registryPath('stale', undefined, env))).toBe(false);
  });
});

describe('jev-compaction-state: compaction.jsonl rotation', () => {
  const ROTATED = /^compaction-\d{8}-\d{6}-\d+\.jsonl$/;
  // Just above 1 MiB (OMC_JEV_LOG_MAX_MB=1).
  const OLD_LOG = ('x'.repeat(99) + '\n').repeat(11_000);

  it('renames a file above OMC_JEV_LOG_MAX_MB before the next append, like the other Jev logs', () => {
    const { env, sid, log } = setup();
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, OLD_LOG);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, { ...env, OMC_JEV_LOG_MAX_MB: '1' });
    const rotated = readdirSync(dirname(log)).filter((name) => ROTATED.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(dirname(log), rotated[0]), 'utf8')).toBe(OLD_LOG);
    expect(logRows(log)).toEqual([expect.objectContaining({ event: 'module_missing', session_id: sid })]);
  });

  it('keeps appending to the same file without the variable', () => {
    const { env, sid, log } = setup();
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, OLD_LOG);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
    expect(readdirSync(dirname(log)).filter((name) => ROTATED.test(name))).toEqual([]);
    expect(readFileSync(log, 'utf8').startsWith(OLD_LOG)).toBe(true);
    expect(readFileSync(log, 'utf8').length).toBeGreaterThan(OLD_LOG.length);
  });
});

describe('jev-compaction-state: hook entry points', () => {
  function cleanEnv(extra) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(OMC_|TYPESAFE_|CLAUDE_PLUGIN_ROOT$|DISABLE_OMC$)/.test(k)) env[k] = v;
    return { ...env, ...extra };
  }
  function run(script, payload, env) {
    return execFileSync(NODE, [join(root, 'scripts', script)], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
  }
  function project() {
    const dir = join(tmp, `hook-${++n}`);
    const home = join(dir, 'home');
    const cwd = join(dir, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore', windowsHide: true });
    return { home, cwd };
  }
  const homeEnv = (home) => ({ HOME: home, USERPROFILE: home, OMC_SKIP_HOOKS: '' });

  it('without the point the hooks write no compaction state and SessionStart prints the same output', () => {
    const { home, cwd } = project();
    const sid = 'sess-off';
    const spool = join(home, '.omc', 'state', 'jev', 'compaction-spool');
    spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout' });
    const outputs = [undefined, 'all:active'].map((OMC_JEV) => {
      const env = cleanEnv({ ...homeEnv(home), ...(OMC_JEV ? { OMC_JEV, TYPESAFE_API_KEY: 'k' } : {}) });
      run('post-tool-verifier.mjs', { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'a.txt') }, tool_response: { success: true } }, env);
      run('post-tool-use-failure.mjs', { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'boom' }, env);
      return run('session-start.mjs', { session_id: sid, cwd, source: 'compact', hook_event_name: 'SessionStart' }, env);
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[0]).not.toMatch(/work state from before the compaction/);
    expect(existsSync(join(home, '.omc', 'state', 'jev', 'compaction-registry'))).toBe(false);
    expect(readdirSync(spool)).toHaveLength(1);
    expect(existsSync(join(cwd, '.omc', 'state', 'jev', 'compaction.jsonl'))).toBe(false);
  });

  it('with compaction named: PostToolUse records, SessionStart:compact moves the record and adds the registry after a fallback', () => {
    const { home, cwd } = project();
    const sid = 'sess-on';
    const env = cleanEnv({ ...homeEnv(home), OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'k' });
    run('post-tool-verifier.mjs', { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'changed.txt') }, tool_response: { success: true } }, env);
    run('post-tool-use-failure.mjs', { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'npm run lint' }, error: 'lint failed' }, env);
    spoolRecord(join(home, '.omc', 'state', 'jev', 'compaction-spool'), sid, { result: 'fallback', reason: 'timeout' });
    const out = JSON.parse(run('session-start.mjs', { session_id: sid, cwd, source: 'compact', hook_event_name: 'SessionStart' }, env).trim().split('\n').pop());
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('changed.txt');
    expect(context).toContain('lint failed');
    const rows = logRows(join(cwd, '.omc', 'state', 'jev', 'compaction.jsonl'));
    expect(rows).toEqual([expect.objectContaining({ result: 'fallback', reason: 'timeout', session_id: sid })]);
  });
});
