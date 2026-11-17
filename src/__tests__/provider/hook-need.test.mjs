/* global process */
// AskUserQuestion denial and tool-call counter hook (scripts/provider/provider-hook-need.cjs, lib/hook-need.cjs).
// The state directory is set explicitly per scenario through OMC_PROVIDER_STATE_DIR.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const HOOK = join(process.cwd(), 'scripts', 'provider', 'provider-hook-need.cjs');
const need = require('../../../scripts/provider/lib/hook-need.cjs');
const hookScript = require('../../../scripts/provider/provider-hook-need.cjs');
const js = JSON.stringify;

describe.skipIf(process.platform === 'win32')('provider hook need', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-need-'); });
  afterAll(() => { tmp.cleanup(); });

  const hookNeed = (input, env = {}) => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : js(input), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER: 'acme', ...env } });
  const denial = (r) => { try { const h = JSON.parse(r.stdout).hookSpecificOutput; return h.permissionDecision === 'deny' ? h : null; } catch { return null; } };

  it('(need-1) AskUserQuestion gives a denial with NEED: (3 calls of the hook), the text is exactly NEED_TEXT in permissionDecisionReason (the channel to the model)', () => {
    const state = join(tmp.dir, 'state-ask');
    const w = [1, 2, 3].map(() => denial(hookNeed({ tool_name: 'AskUserQuestion', tool_input: {}, session_id: '01890c5a-6c81-7d20-8000-000000000001' }, { OMC_PROVIDER_STATE_DIR: state })));
    expect(w.every((h) => h && h.permissionDecisionReason === need.NEED_TEXT), js(w.map((h) => h?.permissionDecisionReason))).toBe(true);
    expect(w[0].permissionDecisionReason.includes('NEED:') && w[0].permissionDecisionReason.includes('finish')).toBe(true);
    expect(hookScript.NEED_TEXT).toBe(need.NEED_TEXT);
  });

  it('(need-2) counter: OMC_PROVIDER_MAX_TOOL_CALLS=3 lets the first three calls through (empty stdout), the fourth is denied with a request for a summary and NEED:; calls.json has n=4; limit 0 = no limit; no key (no OMC_PROVIDER_TASK_ID and no session_id) passes and does not count', () => {
    const state = join(tmp.dir, 'state-counter');
    const input = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: '01890c5a-6c81-7d20-8000-000000000002' };
    const runs = [1, 2, 3, 4].map(() => hookNeed(input, { OMC_PROVIDER_MAX_TOOL_CALLS: '3', OMC_PROVIDER_STATE_DIR: state }));
    expect(runs.slice(0, 3).every((r) => r.status === 0 && r.stdout === '') && runs[3].status === 0, js(runs.map((r) => [r.status, r.stdout.slice(0, 60)]))).toBe(true);
    const h = denial(runs[3]);
    expect(h && /exhausted \(4 of 3\)/.test(h.permissionDecisionReason) && h.permissionDecisionReason.includes('NEED:') && h.permissionDecisionReason.includes('Summarize'), js(h)).toBe(true);
    const counter = JSON.parse(readFileSync(join(state, 'tasks', 'session-01890c5a-6c81-7d20-8000-000000000002', 'calls.json'), 'utf8'));
    expect(counter.n, js(counter)).toBe(4);
    const free = [1, 2, 3, 4, 5].map(() => hookNeed(input, { OMC_PROVIDER_MAX_TOOL_CALLS: '0', OMC_PROVIDER_STATE_DIR: join(tmp.dir, 'state-free') }));
    expect(free.every((r) => r.status === 0 && r.stdout === ''), `limit 0 denied: ${js(free.map((r) => r.stdout.slice(0, 80)))}`).toBe(true);
    const noKey = hookNeed({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { OMC_PROVIDER_MAX_TOOL_CALLS: '3', OMC_PROVIDER_STATE_DIR: join(tmp.dir, 'state-nokey') });
    expect(noKey.status === 0 && noKey.stdout === '' && !existsSync(join(tmp.dir, 'state-nokey', 'tasks')), js({ s: noKey.status, o: noKey.stdout.slice(0, 80) })).toBe(true);
  });

  it('(need-3) max_tool_calls of the task file wins over the configuration: file 2 with env 5 denies the third call; max_tool_calls=null falls back to env 2 and denies the third call; the task file is unchanged after the hook', () => {
    const state = join(tmp.dir, 'state-file');
    mkdirSync(join(state, 'tasks'), { recursive: true });
    const taskFile = join(state, 'tasks', 'aabbccdd.json');
    writeFileSync(taskFile, `${js({ id: 'aabbccdd', team: 'ptask-aabbccdd', start: '2026-11-14T00:00:00Z', max_tool_calls: 2, foreign: 'rescue-field' })}\n`);
    const input = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'irrelevant' };
    const runs = [1, 2, 3].map(() => hookNeed(input, { OMC_PROVIDER_TASK_ID: 'aabbccdd', OMC_PROVIDER_MAX_TOOL_CALLS: '5', OMC_PROVIDER_STATE_DIR: state }));
    expect(runs.slice(0, 2).every((r) => r.stdout === '') && denial(runs[2]) && /3 of 2/.test(denial(runs[2]).permissionDecisionReason), js(runs.map((r) => r.stdout.slice(0, 60)))).toBe(true);
    expect(JSON.parse(readFileSync(taskFile, 'utf8')).foreign, 'the task file was changed by the hook (it must only be read)').toBe('rescue-field');
    const stateB = join(tmp.dir, 'state-file-null');
    mkdirSync(join(stateB, 'tasks'), { recursive: true });
    writeFileSync(join(stateB, 'tasks', 'aabbccdd.json'), `${js({ id: 'aabbccdd', max_tool_calls: null })}\n`);
    const runsB = [1, 2, 3].map(() => hookNeed(input, { OMC_PROVIDER_TASK_ID: 'aabbccdd', OMC_PROVIDER_MAX_TOOL_CALLS: '2', OMC_PROVIDER_STATE_DIR: stateB }));
    expect(runsB.slice(0, 2).every((r) => r.stdout === '') && denial(runsB[2]) && /3 of 2/.test(denial(runsB[2]).permissionDecisionReason), js(runsB.map((r) => r.stdout.slice(0, 60)))).toBe(true);
  });

  it('(need-4) needCommand under /bin/sh: with the script missing AskUserQuestion is denied with the same NEED_TEXT (the fallback literal equals the script), the counter passes quietly; a present script works as when called directly', () => {
    const askInput = js({ tool_name: 'AskUserQuestion', tool_input: {}, session_id: 's-need' });
    const bashInput = js({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's-need' });
    const sh = (command, input, env) => spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER: 'acme', ...env } });
    const a = sh(need.needCommand(HOOK, true), askInput, {});
    const b = sh(need.needCommand(join(tmp.dir, 'no-hook-need'), true), askInput, {});
    expect(denial(a).permissionDecisionReason === need.NEED_TEXT && denial(b).permissionDecisionReason === need.NEED_TEXT, js({ a: denial(a)?.permissionDecisionReason, b: denial(b)?.permissionDecisionReason })).toBe(true);
    const c = sh(need.needCommand(join(tmp.dir, 'no-hook-need'), false), bashInput, { OMC_PROVIDER_MAX_TOOL_CALLS: '1' });
    expect(c.status === 0 && c.stdout === '', js({ s: c.status, o: c.stdout.slice(0, 80) })).toBe(true);
    const stateD = join(tmp.dir, 'state-d');
    const d1 = sh(need.needCommand(HOOK, false), bashInput, { OMC_PROVIDER_MAX_TOOL_CALLS: '1', OMC_PROVIDER_STATE_DIR: stateD });
    const d2 = sh(need.needCommand(HOOK, false), bashInput, { OMC_PROVIDER_MAX_TOOL_CALLS: '1', OMC_PROVIDER_STATE_DIR: stateD });
    expect(d1.status === 0 && d1.stdout === '' && denial(d2) && /2 of 1/.test(denial(d2).permissionDecisionReason), js(denial(d2))).toBe(true);
    const stateDirect = join(tmp.dir, 'state-direct');
    const sessionInput = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's-need' };
    expect(hookNeed(sessionInput, { OMC_PROVIDER_MAX_TOOL_CALLS: '1', OMC_PROVIDER_STATE_DIR: stateDirect }).stdout, 'the first direct call did not pass').toBe('');
    expect(denial(hookNeed(sessionInput, { OMC_PROVIDER_MAX_TOOL_CALLS: '1', OMC_PROVIDER_STATE_DIR: stateDirect })).permissionDecisionReason.includes('Summarize'), 'the second direct denial has no request for a summary').toBe(true);
  });

  it('(need-5) lifecycle commands pass after the tool budget is exhausted and are not counted: a single `omc team api <operation>` command (also the plugin bridge form, with any characters inside the quoted JSON input); text that merely occurs in a longer command line, other operations, shell control operators, redirection and command substitution outside the command are denied like any call', () => {
    const state = join(tmp.dir, 'state-lifecycle');
    const session = '01890c5a-6c81-7d20-8000-000000000005';
    const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, session_id: session });
    const env = { OMC_PROVIDER_MAX_TOOL_CALLS: '1', OMC_PROVIDER_STATE_DIR: state };
    expect(hookNeed(bash('ls'), env).stdout).toBe('');
    expect(denial(hookNeed(bash('ls'), env)), 'the budget is exhausted').not.toBeNull();
    const counter = () => JSON.parse(readFileSync(join(state, 'tasks', `session-${session}`, 'calls.json'), 'utf8')).n;
    const before = counter();
    const input = '--input "{\\"team_name\\":\\"t\\",\\"result\\":\\"Summary: a; b && c | d > e\\"}" --json';
    const allowed = [
      `omc team api transition-task-status ${input}`,
      `  omc team api claim-task ${input}`,
      `./bin/omc team api read-task ${input}`,
      `node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs team api send-message ${input}`,
      "omc team api release-task-claim --input '{\"a\":\"x;y\"}' --json",
      'omc team api renew-task-claim',
    ];
    for (const command of allowed) expect(hookNeed(bash(command), env).stdout, command).toBe('');
    expect(counter(), 'lifecycle commands are not counted').toBe(before);
    const denied = [
      'echo team api read-task',
      'ls; omc team api claim-task --input x',
      'omc team api claim-task --input x && cat /etc/hosts',
      'omc team api claim-task --input x | tee out',
      'omc team api claim-task --input x > out',
      'omc team api claim-task --input x\nls',
      'omc team api claim-task --input "$(cat secret)"',
      'omc team api claim-task --input `cat secret`',
      'omc team api mailbox-list --input x --json',
      'omc team api claim-taskx',
      'xomc team api claim-task',
      'git log --grep "omc team api read-task"',
    ];
    for (const command of denied) expect(denial(hookNeed(bash(command), env)), command).not.toBeNull();
    expect(denial(hookNeed({ tool_name: 'Read', tool_input: { command: 'omc team api read-task' }, session_id: session }, env)), 'only Bash calls are lifecycle commands').not.toBeNull();
  });

  it('addNeed appends the AskUserQuestion hook always and the counter hook only when asked, keeping existing PreToolUse entries; a damaged input is denied fail-closed', () => {
    const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    need.addNeed(settings, { script: HOOK, counter: false });
    expect(settings.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['Bash', 'AskUserQuestion']);
    need.addNeed(settings, { script: HOOK, counter: true });
    expect(settings.hooks.PreToolUse.length).toBe(4);
    expect(settings.hooks.PreToolUse[3].matcher).toBeUndefined();
    const r = hookNeed('this is not json');
    expect(denial(r)?.permissionDecisionReason).toMatch(/fail-closed/);
  });

  it('opt-in: without the counter registration and without a limit nothing is denied; the counter off by default lets every call through', () => {
    const state = join(tmp.dir, 'state-off');
    const input = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's-off' };
    const runs = [1, 2, 3, 4, 5].map(() => hookNeed(input, { OMC_PROVIDER_STATE_DIR: state }));
    expect(runs.every((r) => r.status === 0 && r.stdout === '')).toBe(true);
  });
});
