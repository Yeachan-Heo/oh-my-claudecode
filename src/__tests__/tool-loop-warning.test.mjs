/**
 * Tests for the PostToolUse tool-loop warning hook (scripts/tool-loop-warning.mjs,
 * opt-in OMC_JEV_LOOP_WARNING=1). The hook runs as Claude Code runs it: a node
 * subprocess reading the hook input from stdin, state dir in a temp dir, one
 * lane per test. Cases follow the hook test the port is based on: 3 identical
 * Reads with the same result warn at the third, different results never;
 * R,E,R,E,R neither repeats nor cycles; a cycle A,B,A,B,A,B warns once and
 * again only after the cycle breaks; sleep, status tools, MCP suffixes, Agent
 * and Task never warn; main session and subagent (agent_id) count apart; bad
 * JSON: exit 0 without output; output, journal and state never carry
 * tool_input/tool_response content; with the switch off: no output, no files.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const HOOK = join(ROOT, 'scripts', 'tool-loop-warning.mjs');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const MARKER_INPUT = 'MARKER-INPUT-LOOP';
const MARKER_RESULT = 'MARKER-RESULT-LOOP';

let lane;

const laneOf = (name) => {
  if (!lane) lane = mkdtempSync(join(tmpdir(), 'loop-warning-'));
  const dir = join(lane, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Run the hook the way Claude Code runs it: stdin JSON, temp state dir. */
const run = (data, stateDir, extraEnv = {}) => spawnSync(process.execPath, [HOOK], {
  input: typeof data === 'string' ? data : JSON.stringify({
    session_id: 's-loop',
    transcript_path: '/never/opened/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/x.md' },
    tool_response: 'shared-ok-result',
    tool_use_id: 'tool-1',
    ...data,
  }),
  encoding: 'utf8',
  env: { ...process.env, OMC_JEV_LOOP_WARNING: '1', OMC_JEV_LOOP_WARNING_STATE_DIR: stateDir, ...extraEnv },
});

const context = (r) => {
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
};

const journal = (laneDir) => {
  const path = join(laneDir, 'tool-loop-warnings.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((row) => JSON.parse(row));
};

const stateFileOf = (laneDir, session, agent = '') =>
  join(laneDir, 'state', `${createHash('sha256').update(`${session}\u0000${agent}`).digest('hex')}.json`);

describe('tool-loop warning hook', () => {
  it('warns at the 3rd and 6th identical call, journal rows, output structure', () => {
    const laneDir = laneOf('repeat');
    const state = join(laneDir, 'state');
    const call = (n) => run({ session_id: 's-pow', tool_use_id: `t${n}` }, state);
    for (const n of [1, 2]) {
      const r = call(n);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
    const text = context(call(3));
    expect(text).toMatch(/repeated 3 times in a row/);
    expect(text).toMatch(/Change approach/);
    for (const n of [4, 5]) expect(call(n).stdout.trim()).toBe('');
    expect(JSON.parse(call(6).stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('journal has one repeat row per warning (at 3 and 6), fields without content', () => {
    const laneDir = laneOf('repeat-journal');
    const state = join(laneDir, 'state');
    const call = (n) => run({ session_id: 's-pow', tool_use_id: `t${n}` }, state);
    for (let n = 1; n <= 6; n += 1) call(n);
    const rows = journal(laneDir);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'repeat' && row.tool === 'Read')).toBe(true);
    expect(rows.map((row) => row.count)).toEqual([3, 6]);
    expect(rows.every((row) => row.period === null)).toBe(true);
    expect(rows.every((row) => typeof row.signature === 'string' && row.signature.length === 12)).toBe(true);
    expect(rows.every((row) => row.session_id === 's-pow' && row.agent_id === '')).toBe(true);
    expect(rows.every((row) => typeof row.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.ts))).toBe(true);
    expect(rows.every((row) => row.count === 3 || row.count === 6)).toBe(true);
  });

  it('3 Reads with different results: no warning', () => {
    const laneDir = laneOf('different-results');
    const state = join(laneDir, 'state');
    for (let i = 1; i <= 3; i += 1) {
      const r = run({ session_id: 's-varied', tool_response: `version-${i}` }, state);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
    expect(journal(laneDir)).toHaveLength(0);
  });

  it('Read,Edit,Read,Edit,Read: no repeat and no cycle (period 2 needs 6 calls)', () => {
    const laneDir = laneOf('alternating');
    const state = join(laneDir, 'state');
    const seq = [
      { tool_name: 'Read', tool_input: { file_path: '/tmp/r.md' } },
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/r.md', old_string: 'a', new_string: 'b' } },
      { tool_name: 'Read', tool_input: { file_path: '/tmp/r.md' } },
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/r.md', old_string: 'a', new_string: 'b' } },
      { tool_name: 'Read', tool_input: { file_path: '/tmp/r.md' } },
    ];
    seq.forEach((extra) => {
      const r = run({ session_id: 's-sequence', ...extra }, state);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
    expect(journal(laneDir)).toHaveLength(0);
  });

  it('cycle A,B,A,B,A,B: shortest period, again only after the cycle breaks', () => {
    const laneDir = laneOf('cycle');
    const state = join(laneDir, 'state');
    const A = { tool_name: 'Read', tool_input: { file_path: '/tmp/c.md' }, tool_response: 'cycle-a' };
    const B = { tool_name: 'Grep', tool_input: { pattern: 'cycle-p', path: '/tmp/c' }, tool_response: 'cycle-b' };
    const C = { tool_name: 'Glob', tool_input: { pattern: 'break-*' }, tool_response: 'empty' };
    const step = (n, extra, expectWarn) => {
      const r = run({ session_id: 's-cycle', ...extra }, state);
      expect(r.status).toBe(0);
      const text = context(r);
      if (expectWarn) {
        expect(text).toMatch(/\[loop warning\] Calls repeat in a 2-step cycle \(Read, Grep\) 3 times\./);
        expect(text).toMatch(/Break the cycle and change approach\./);
      } else {
        expect(text).toBeNull();
      }
      return r;
    };
    for (const n of [1, 2, 3, 4, 5]) step(n, n % 2 === 1 ? A : B, false);
    const r6 = step(6, B, true);
    step(7, A, false);
    step(8, B, false);
    step(9, C, false);
    for (const n of [10, 11, 12, 13, 14]) step(n, n % 2 === 0 ? A : B, false);
    step(15, B, true);
    const rows = journal(laneDir);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'cycle')).toBe(true);
    expect(rows.map((row) => row.period)).toEqual([2, 2]);
    expect(rows.map((row) => row.count)).toEqual([3, 3]);
    expect(rows.every((row) => row.tool === 'Read,Grep')).toBe(true);
    expect(r6.stdout.includes('cycle-a')).toBe(false);
  });

  it('mixed cycle A,B,C x3: period 3 warning at the 9th call', () => {
    const laneDir = laneOf('cycle-3');
    const state = join(laneDir, 'state');
    const tools = [
      { tool_name: 'Read', tool_input: { file_path: '/tmp/m.md' } },
      { tool_name: 'Grep', tool_input: { pattern: 'm-pattern' } },
      { tool_name: 'Bash', tool_input: { command: 'ls /tmp/m' } },
    ];
    for (let i = 0; i < 9; i += 1) {
      const r = run({ session_id: 's-cycle3', ...tools[i % 3] }, state);
      expect(r.status).toBe(0);
      if (i === 8) expect(context(r)).toMatch(/in a 3-step cycle \(Read, Grep, Bash\) 3 times\./);
      else expect(context(r)).toBeNull();
    }
    expect(journal(laneDir)).toHaveLength(1);
  });

  it('polling and status exemptions never warn', () => {
    const laneDir = laneOf('exemptions');
    const state = join(laneDir, 'state');
    const cases = [
      { tool_name: 'Bash', tool_input: { command: 'sleep 30' } },
      { tool_name: 'Bash', tool_input: { command: 'gh run watch 42' } },
      { tool_name: 'Bash', tool_input: { command: '  tail -f /var/log/syslog' } },
      { tool_name: 'Bash', tool_input: { command: 'git status --porcelain' } },
      { tool_name: 'Bash', tool_input: { command: 'sleep' } },
      { tool_name: 'ReadNotifications' },
      { tool_name: 'TaskList' },
      { tool_name: 'Monitor' },
      { tool_name: 'mcp__plugin_x_t__state_read' },
      { tool_name: 'Task' },
    ];

    for (let i = 0; i < cases.length; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        const r = run({ session_id: 's-exempt', tool_use_id: `w${i}-${k}`, ...cases[i] }, state);
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe('');
      }
    }
    expect(journal(laneDir)).toHaveLength(0);
  });

  it('sleep as a whole word only: sleepy is not polling and warns at the 3rd call', () => {
    const laneDir = laneOf('sleep-word');
    const state = join(laneDir, 'state');
    for (let k = 1; k <= 3; k += 1) {
      const r = run({ session_id: 's-sleepy', tool_name: 'Bash', tool_input: { command: 'sleepy 5' } }, state);
      expect(r.status).toBe(0);
      if (k < 3) expect(r.stdout.trim()).toBe('');
      else expect(context(r)).toMatch(/The same Bash call/);
    }
  });

  it('MCP suffixes: the default list exempts the state tools; a custom list exempts more', () => {
    const laneDir = laneOf('mcp-suffixes');
    const state = join(laneDir, 'state');
    const taskListTool = 'mcp__other__task_list';
    // default list: the task-list suffix is not exempt, so 3 identical calls warn
    for (let k = 1; k <= 3; k += 1) {
      const r = run({ session_id: 's-mcp-def', tool_name: taskListTool }, state);
      expect(r.status).toBe(0);
      if (k === 3) expect(context(r)).toMatch(/The same mcp__other__task_list call/);
    }
    // custom list: the same calls are exempt and the counter resets
    const custom = { OMC_JEV_LOOP_WARNING_MCP_SUFFIXES: '__task_list,__state_read' };
    const r2 = run({ session_id: 's-mcp-def', tool_name: taskListTool }, state, custom);
    expect(r2.status).toBe(0);
    expect(r2.stdout.trim()).toBe('');
  });

  it('Agent resets the repeat counter (the warning moves after the exemption)', () => {
    const laneDir = laneOf('agent-resets');
    const state = join(laneDir, 'state');
    const d = { session_id: 's-agent', tool_use_id: 'a' };
    expect(context(run(d, state))).toBeNull();
    expect(context(run(d, state))).toBeNull();
    const rAgent = run({ ...d, tool_name: 'Agent', tool_input: { subagent_type: 'executor', prompt: MARKER_INPUT } }, state);
    expect(rAgent.status).toBe(0);
    expect(rAgent.stdout.trim()).toBe('');
    expect(context(run(d, state))).toBeNull();
    expect(context(run(d, state))).toBeNull();
    expect(context(run(d, state))).toMatch(/repeated 3 times in a row/);
    expect(journal(laneDir)).toHaveLength(1);
  });

  it('main session and subagent (agent_id) count apart, separate state files', () => {
    const laneDir = laneOf('contexts');
    const state = join(laneDir, 'state');
    const d = { session_id: 's-ctx', tool_use_id: 'k' };
    expect(context(run(d, state))).toBeNull();
    expect(context(run(d, state))).toBeNull();
    const dAgent = { ...d, agent_id: 'a1', agent_type: 'executor' };
    expect(context(run(dAgent, state))).toBeNull();
    expect(context(run(dAgent, state))).toBeNull();
    const r3 = run(d, state);
    expect(context(r3)).toMatch(/repeated 3 times in a row/);
    const rows = journal(laneDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].agent_id).toBe('');
    expect(readdirSync(join(state)).filter((n) => n.endsWith('.json'))).toHaveLength(2);
  });

  it('bad JSON and missing fields: exit 0, no output, error rows in the journal', () => {
    const laneDir = laneOf('bad-json');
    const state = join(laneDir, 'state');
    const rBad = run('{bad-json-loop', state);
    expect(rBad.status).toBe(0);
    expect(rBad.stdout).toBe('');
    expect(rBad.stderr).toBe('');
    const rFields = run({ session_id: '', tool_name: 'Read' }, state);
    expect(rFields.status).toBe(0);
    expect(rFields.stdout).toBe('');
    expect(rFields.stderr).toBe('');
    const rEvent = run({ hook_event_name: 'PreToolUse' }, state);
    expect(rEvent.status).toBe(0);
    expect(rEvent.stdout.trim()).toBe('');
    const rows = journal(laneDir);
    expect(rows.some((row) => row.kind === 'error' && row.category === 'json')).toBe(true);
    expect(rows.some((row) => row.kind === 'error' && row.category === 'fields')).toBe(true);
  });

  it('state write error: exit 0 without output, an error row, no stderr trace', () => {
    const laneDir = laneOf('state-error');
    const fileAsDir = join(laneDir, 'file-as-state');
    writeFileSync(fileAsDir, 'x');
    const r = run({ session_id: 's-error', tool_use_id: 'x' }, fileAsDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    const rows = journal(laneDir);
    expect(rows.some((row) => row.kind === 'error' && row.category === 'other')).toBe(true);
  });

  it('output, journal and state never carry tool_input or tool_response content', () => {
    const laneDir = laneOf('no-content');
    const state = join(laneDir, 'state');
    let last;
    for (let k = 1; k <= 3; k += 1) {
      last = run({
        session_id: 's-content',
        tool_input: { file_path: `/tmp/${MARKER_INPUT}/file.md` },
        tool_response: `result ${MARKER_RESULT}`,
      }, state);
      expect(last.status).toBe(0);
    }
    expect(context(last)).toBeTruthy();
    const whole = last.stdout
      + readFileSync(join(laneDir, 'tool-loop-warnings.jsonl'), 'utf8')
      + readFileSync(stateFileOf(laneDir, 's-content'), 'utf8');
    expect(whole.includes(MARKER_INPUT)).toBe(false);
    expect(whole.includes(MARKER_RESULT)).toBe(false);
    expect(whole).toMatch(/"tool":"Read"/);
  });

  it('sweep at the 100th call: an old foreign file is removed, the own state file stays', () => {
    const laneDir = laneOf('sweep');
    const state = join(laneDir, 'state');
    mkdirSync(state, { recursive: true });
    const own = stateFileOf(laneDir, 's-cleanup', '');
    writeFileSync(own, JSON.stringify({ calls: 99 }));
    const now = Date.now() / 1000;
    utimesSync(own, now - 5, now - 5);
    const foreign = join(state, 'stale-inactive.json');
    writeFileSync(foreign, JSON.stringify({}));
    utimesSync(foreign, now - 5, now - 5);
    const r = run({ session_id: 's-cleanup', tool_use_id: 'z' }, state, { OMC_JEV_LOOP_WARNING_STATE_DAYS: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(existsSync(foreign)).toBe(false);
    expect(existsSync(own)).toBe(true);
    expect(JSON.parse(readFileSync(own, 'utf8')).calls).toBe(100);
  });

  it('with the switch off the behavior is unchanged: no output, no state, no journal', () => {
    const laneDir = laneOf('default-off');
    const state = join(laneDir, 'state');
    for (let k = 1; k <= 3; k += 1) {
      const r = run({ session_id: 's-off', tool_use_id: `o${k}` }, state, { OMC_JEV_LOOP_WARNING: '' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(laneDir, 'tool-loop-warnings.jsonl'))).toBe(false);
  });

  it('threshold from the environment: OMC_JEV_LOOP_WARNING_THRESHOLD=2 warns at the 2nd call', () => {
    const laneDir = laneOf('threshold-env');
    const state = join(laneDir, 'state');
    const env = { OMC_JEV_LOOP_WARNING_THRESHOLD: '2' };
    expect(context(run({ session_id: 's-th', tool_use_id: 'x1' }, state, env))).toBeNull();
    expect(context(run({ session_id: 's-th', tool_use_id: 'x2' }, state, env))).toMatch(/repeated 2 times in a row/);
  });

  it('hooks.json does not register the hook for any event', () => {
    const entries = [];
    for (const groups of Object.values(MANIFEST.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          const invocation = [hook.command, ...(hook.args ?? [])].join(' ');
          if (invocation.includes('tool-loop-warning.mjs')) entries.push(hook);
        }
      }
    }
    expect(entries).toHaveLength(0);
  });

  // The bound is generous on purpose: the run time is dominated by the node process start, which
  // varies a lot on a loaded machine; the hook is documented with a 3 s limit.
  it('speed: the median of 20 runs stays below 1000 ms', () => {
    const laneDir = laneOf('speed');
    const state = join(laneDir, 'state');
    const times = [];
    for (let i = 0; i < 20; i += 1) {
      const start = process.hrtime.bigint();
      const r = run({ session_id: `s-fast-${i}` }, state);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
    times.sort((a, b) => a - b);
    const median = (times[9] + times[10]) / 2;
    expect(median).toBeLessThan(1000);
  });
});

afterEach(() => {
  if (lane) {
    try {
      rmSync(lane, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a temp lane that cannot be removed now is left to the OS
    }
  }
  lane = null;
});

describe('default state paths', () => {
  it('keeps the state directory and the journal under the home directory when no directory is set', () => {
    const home = laneOf('home');
    const source = `import { loopWarningConfig } from ${JSON.stringify(pathToFileURL(HOOK).href)};`
      + ' const c = loopWarningConfig({}); process.stdout.write(JSON.stringify({ stateDir: c.stateDir, journalPath: c.journalPath }));';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      stateDir: join(home, '.omc', 'state', 'tool-loop'),
      journalPath: join(home, '.omc', 'state', 'tool-loop-warnings.jsonl'),
    });
  });
});
