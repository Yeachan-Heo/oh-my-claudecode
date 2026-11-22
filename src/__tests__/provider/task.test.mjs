/* global process, setTimeout, URL */
// provider-task: the doctor smoke test and the task lifecycle (start, status, result, kill, list) on fakes: the fake `omc`
// (OMC_PROVIDER_TASK_OMC_BIN), the fake `provider-team` (OMC_PROVIDER_TASK_TEAM_BIN), the fake `claude` of the doctor
// (OMC_PROVIDER_CLAUDE_BIN), a loopback quota endpoint and a key file. No network beyond loopback, no real key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_KEY, fakeQuotaServer, makeTmp, waitProcessGone, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const SCRIPTS = fileURLToPath(new URL('../../../scripts/provider/', import.meta.url));
const TASK = join(SCRIPTS, 'provider-task.cjs');
const RESULT_MODULE = join(SCRIPTS, 'lib', 'task-result.cjs');
const LOG_MODULE = join(SCRIPTS, 'provider-task-log.cjs');
const STATE_ROOT = require('../../../scripts/lib/state-root.cjs');
const QUOTA_URL = 'https://quota.acme.example/api/monitor/usage/quota/limit';
const KEY = PLACEHOLDER_KEY;
const js = JSON.stringify;
const limit5h = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: Date.now() + 3600_000 });
const limitWeek = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime: Date.now() + 3 * 86400_000 });
// check(condition, message): the condition must be true; the message is shown on failure.
const check = (condition, message) => expect(Boolean(condition), typeof message === 'function' ? message() : message).toBe(true);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (condition, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (condition()) return true; await sleep(50); }
  return condition();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); } };
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // an ended process: its pid is dead
const slugLocal = (t) => { const c = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); return c.slice(0, 30).replace(/^-|-$/g, '') || 'team-task'; };
const startTimeOf = (pid) => {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(t.slice(t.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return null; }
};
const livePeer = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'ignore' });

// A real answer of `claude -p --output-format json`: no model field at the top level, the model is the key of modelUsage.
const REAL_DOCTOR_ANSWER = { duration_api_ms: 2392, stop_reason: 'end_turn', session_id: '00000000-0000-0000-0000-000000000000', total_cost_usd: 0.01146, usage: { input_tokens: 46, cache_creation_input_tokens: 0, cache_read_input_tokens: 21760, output_tokens: 14, service_tier: 'standard' }, modelUsage: { 'acme-small[1m]': { inputTokens: 46, outputTokens: 14, cacheReadInputTokens: 21760, cacheCreationInputTokens: 0, costUSD: 0.01146, contextWindow: 1000000, maxOutputTokens: 32000, provider: 'firstParty' } }, permission_denials: [], terminal_reason: 'completed', is_error: false, num_turns: 1, subtype: 'success', result: 'ok', type: 'result', duration_ms: 3153 };

describe.skipIf(process.platform === 'win32')('provider-task', () => {
  let tmp;
  let bin;
  let FAKE_OMC;
  let FAKE_TEAM;
  let FAKE_DOCTOR;
  let sharedQuota;
  let savedEnv;
  let nr = 0;

  beforeAll(async () => {
    tmp = makeTmp('provider-task-');
    bin = join(tmp.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // Fake omc: logs the calls to OMC_FAKE_LOG (JSONL), answers from the scenario file OMC_FAKE_SCENARIO; at shutdown it checks the field killed of the task file.
    FAKE_OMC = join(bin, 'omc-fake.cjs');
    writeFileSync(FAKE_OMC, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.OMC_FAKE_LOG) fs.appendFileSync(process.env.OMC_FAKE_LOG, JSON.stringify({ ts: Date.now(), argv: args }) + '\\n');
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(process.env.OMC_FAKE_SCENARIO, 'utf8')); } catch { /* no scenario: empty answers */ }
const print = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
if (args[0] === 'team' && args[1] === 'api' && args[2] === 'list-tasks') {
  if (scenario.listTasksExit) process.exit(scenario.listTasksExit);
  print(scenario.listTasks ?? { ok: true, data: { count: 0, tasks: [] } });
}
if (args[0] === 'team' && args[1] === 'api' && args[2] === 'read-task') {
  const i = args.indexOf('--input');
  const taskId = i >= 0 ? JSON.parse(args[i + 1] || '{}').task_id : null;
  print((scenario.readTask && scenario.readTask[taskId]) ? { ok: true, data: { task: scenario.readTask[taskId] } } : { ok: false, operation: 'read-task', error: { code: 'task_not_found' } });
}
if (args[0] === 'team' && args[1] === 'api' && args[2] === 'read-worker-heartbeat') print({ ok: true, data: { heartbeat: scenario.heartbeat ?? null } });
if (args[0] === 'team' && args[1] === 'api' && args[2] === 'read-worker-status') print({ ok: true, data: { status: scenario.workerStatus ?? null } });
if (args[0] === 'team' && args[1] === 'shutdown') {
  const m = String(args[2] || '').match(/^ptask-([0-9a-f]{8})(?:-|$)/);
  let answer = 'no-id';
  if (m) {
    try { answer = JSON.parse(fs.readFileSync(path.join(process.env.OMC_FAKE_TASKS_DIR, m[1] + '.json'), 'utf8')).killed ? 'killed-set' : 'killed-missing'; } catch { answer = 'no-file'; }
  }
  if (process.env.OMC_FAKE_LOG) fs.appendFileSync(process.env.OMC_FAKE_LOG, JSON.stringify({ shutdown: answer }) + '\\n');
  process.exit(scenario.exit ?? 0);
}
if (args[0] === 'team' && args[1] === 'status') { console.log('team=' + args[2] + ' phase=executing\\nworker=' + (scenario.worker ?? 'worker-1') + ' working_dir=/x'); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
    // Fake provider-team: logs argv, creates the team state directory FAKE_TEAM_DIR/ptask-<id>-actual (or -2), exits with FAKE_TEAM_EXIT, waits for the stop file FAKE_TEAM_STOP.
    FAKE_TEAM = join(bin, 'team-fake.cjs');
    writeFileSync(FAKE_TEAM, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.OMC_FAKE_LOG) fs.appendFileSync(process.env.OMC_FAKE_LOG, JSON.stringify({ ts: Date.now(), argv: args }) + '\\n');
if (process.env.FAKE_TEAM_STDERR) console.error(process.env.FAKE_TEAM_STDERR);
const m = String(args[2] || '').match(/^ptask-([0-9a-f]{8}) /); // the text is argv[2] (argv[1] is --no-decompose)
if (m && process.env.FAKE_TEAM_DIR) {
  const suffix = process.env.FAKE_TEAM_NAME === '2' ? '-2' : '-actual';
  try { fs.mkdirSync(path.join(process.env.FAKE_TEAM_DIR, 'ptask-' + m[1] + suffix), { recursive: true }); } catch { /* ignored */ }
}
const stop = process.env.FAKE_TEAM_STOP;
const waitMs = Number(process.env.FAKE_TEAM_WAIT_MS) || 30000;
const begin = Date.now();
while (stop && !fs.existsSync(stop) && Date.now() - begin < waitMs) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
process.exit(Number(process.env.FAKE_TEAM_EXIT) || 0);
`, { mode: 0o755 });
    // Fake claude of the doctor: its data come from $HOME/fake-doctor.json (the environment of the child is the allow-list of the executor, test variables do not pass).
    FAKE_DOCTOR = join(bin, 'claude-fake.cjs');
    writeFileSync(FAKE_DOCTOR, `#!${process.execPath}
const fs = require('node:fs');
const conf = JSON.parse(fs.readFileSync(process.env.HOME + '/fake-doctor.json', 'utf8'));
const out = conf.out;
fs.writeFileSync(out + '.argv', process.argv.slice(2).join('\\n') + '\\n');
fs.writeFileSync(out + '.env', Object.keys(process.env).sort().join('\\n') + '\\n');
if (conf.expected && process.env.ANTHROPIC_AUTH_TOKEN === conf.expected) fs.writeFileSync(out + '.auth', 'yes\\n');
const scenarios = {
  ok: ['{"model":"acme-small[1m]"}', 0],
  other: ['{"model":"acme-large"}', 0],
  quota429: ['API Error: 429 {"type":"error"}', 1],
  quota1308: ['{"type":"error","error":{"code":1308}}', 1],
  quota1310: ['{"type":"error","error":{"code":1310}}', 1],
  key: ['{"model":"sk-' + conf.expected + '"}', 0],
  failure: ['Something else went wrong', 7],
};
const [text, code] = conf.scenario === 'real' ? [fs.readFileSync(conf.answerFile, 'utf8'), 0] : (scenarios[conf.scenario] || scenarios.ok);
console.log(text);
process.exit(code);
`, { mode: 0o755 });
    chmodSync(FAKE_OMC, 0o755);
    chmodSync(FAKE_TEAM, 0o755);
    chmodSync(FAKE_DOCTOR, 0o755);
    sharedQuota = await fakeQuotaServer([limit5h(89), limitWeek(34)]);
    // The team state directory is resolved in this process too (the expectation of the name-correction cases): the same environment as the child.
    savedEnv = { OMC_STATE_DIR: process.env.OMC_STATE_DIR, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT };
  });
  afterAll(async () => {
    await sharedQuota.close();
    tmp.cleanup();
  });

  // The team state directory of a fixture: <omc root>/state/team, as resolved by the child processes.
  const teamDirOf = async (f) => {
    process.env.OMC_STATE_DIR = f.env.OMC_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try { return join(await STATE_ROOT.resolveOmcStateRoot(f.cwd), 'state', 'team'); } finally {
      for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  };

  // One case: a profile with non-default values (16 slots, worker model haiku and effort max, thresholds 96/99), a quota adapter, its own state directory.
  const fixture = (overrides = {}, { quotaUrl = sharedQuota.url } = {}) => {
    const dir = join(tmp.dir, `f${++nr}`);
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const cwd = join(dir, 'p');
    mkdirSync(cwd, { recursive: true });
    const p = writeProfile(dir, { contextWindow: 1000000, quota: { adapter: 'monitor-limits', url: QUOTA_URL }, ...overrides }, { tuned: true });
    const state = join(dir, 'state');
    const tasks = join(state, 'tasks');
    const log = join(dir, 'fake-log.jsonl');
    const env = {
      ...p.env,
      OMC_STATE_DIR: join(dir, 'omc-state'),
      OMC_PROVIDER_TASK_OMC_BIN: FAKE_OMC,
      OMC_PROVIDER_TASK_TEAM_BIN: FAKE_TEAM,
      OMC_PROVIDER_TASK_POLL_MS: '400',
      OMC_PROVIDER_QUOTA_URL: quotaUrl,
      OMC_FAKE_LOG: log,
      OMC_FAKE_TASKS_DIR: tasks,
    };
    let scenarios = 0;
    const scenario = (data) => { const file = join(dir, `scenario-${++scenarios}.json`); writeFileSync(file, JSON.stringify(data)); return file; };
    const task = (id) => { try { return JSON.parse(readFileSync(join(tasks, `${id}.json`), 'utf8')); } catch { return null; } };
    const put = (id, object) => { mkdirSync(tasks, { recursive: true }); writeFileSync(join(tasks, `${id}.json`), js(object)); };
    const rows = (filter = null) => {
      let text = '';
      try { text = readFileSync(log, 'utf8'); } catch { return []; }
      const all = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return filter ? all.filter((x) => js(x).includes(filter)) : all;
    };
    const omcCalls = () => rows().filter((x) => Array.isArray(x.argv) && x.argv[0] === 'team');
    const shutdowns = () => omcCalls().filter((x) => x.argv[1] === 'shutdown');
    // Synchronous commands (status, result, kill, list): no quota server is needed. By default the result and journal modules are missing files
    // (the evaluation is off); cases that need them name them in extraEnv.
    const run = (args, scenarioFile, extraEnv = {}) => spawnSync(process.execPath, [TASK, ...args], {
      encoding: 'utf8',
      env: { ...env, OMC_FAKE_SCENARIO: scenarioFile, OMC_PROVIDER_TASK_RESULT_MODULE: join(dir, 'no-result.cjs'), OMC_PROVIDER_TASK_LOG_MODULE: join(dir, 'no-journal.cjs'), ...extraEnv },
    });
    // `start` goes through the quota gate, so the quota server of this process must keep answering: asynchronous spawn.
    const start = (args, scenarioFile, extraEnv = {}) => new Promise((done) => {
      const child = spawn(process.execPath, [TASK, 'start', '--cwd', cwd, ...args], { env: { ...env, OMC_FAKE_SCENARIO: scenarioFile ?? scenario({}), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => done({ status, stdout, stderr, id: stdout.trim() }));
    });
    return { dir, home, cwd, state, tasks, env, file: p.file, keyFile: p.profile.apiKey.file, scenario, task, put, rows, omcCalls, shutdowns, run, start };
  };

  // ===== doctor =====
  const doctor = (f, extra = {}, args = ['doctor']) => {
    const { FAKE_SCENARIO, FAKE_ANSWER_FILE, ...extraEnv } = extra;
    const out = join(f.dir, `d${++nr}`);
    writeFileSync(join(f.home, 'fake-doctor.json'), JSON.stringify({ out, scenario: FAKE_SCENARIO || 'ok', expected: KEY, answerFile: FAKE_ANSWER_FILE }));
    const env = { PATH: process.env.PATH, HOME: f.home, OMC_PROVIDER_PROFILES_FILE: f.file, OMC_PROVIDER_SHIM_DIR: join(f.dir, 'shims'), OMC_PROVIDER_CLAUDE_BIN: FAKE_DOCTOR, OMC_PROVIDER_API_KEY_FILE: f.keyFile, OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1', ...extraEnv };
    const r = spawnSync(process.execPath, [TASK, ...args], { encoding: 'utf8', env });
    const read = (x) => (existsSync(`${out}.${x}`) ? readFileSync(`${out}.${x}`, 'utf8') : null);
    return { ...r, called: existsSync(`${out}.argv`), argv: read('argv')?.trim().split('\n'), env: read('env')?.trim().split('\n'), auth: read('auth') !== null };
  };

  it('(1) doctor OK: exit code 0; the fake gets exactly the expected arguments (smoke test, the worker model alias, effort max, no MCP) and the key in the process env; the key nowhere in the output', () => {
    const f = fixture();
    const r = doctor(f, { FAKE_SCENARIO: 'ok' });
    check(r.status === 0 && r.auth, js({ s: r.status, o: r.stdout, e: r.stderr }));
    const i = r.argv.indexOf('--settings');
    check(r.argv.slice(0, 8).join('|') === ['-p', 'Reply with just: ok', '--output-format', 'json', '--model', 'haiku', '--effort', 'max'].join('|'), js(r.argv));
    check(r.argv[i + 1].split('/').at(-1).startsWith('doctor-') && r.argv.includes('--strict-mcp-config') && r.argv[r.argv.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}', js(r.argv));
    check(/OK: model acme-small/.test(r.stdout) && r.stdout.includes('context window 1000000'), js(r.stdout));
    check(!r.stdout.includes(KEY) && !r.stderr.includes(KEY), 'key in the output');
  });

  it('(2) the --settings file as for a worker of a provider role: 0600, no mcpServers, subagents on the subagent model, OMC_JEV=off, the test address, PATH with the shims, the Bash guard; the key not in the file', () => {
    const f = fixture();
    const r = doctor(f, { FAKE_SCENARIO: 'ok' });
    check(r.status === 0 && r.argv, js({ s: r.status, e: r.stderr }));
    const file = r.argv[r.argv.indexOf('--settings') + 1];
    const u = JSON.parse(readFileSync(file, 'utf8'));
    check((statSync(file).mode & 0o777) === 0o600 && !('mcpServers' in u) && u.env.CLAUDE_CODE_SUBAGENT_MODEL === 'acme-small[1m]' && u.env.OMC_JEV === 'off', js({ m: statSync(file).mode & 0o777, k: Object.keys(u) }));
    check(u.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:1' && u.env.OMC_PROVIDER === 'acme' && u.env.PATH.startsWith(`${join(f.dir, 'shims')}:`) && u.hooks.PreToolUse[0].hooks[0].command.includes('provider-bash-guard'), js(u.env));
    check(!('apiKeyHelper' in u) && !JSON.stringify(u).includes(KEY), 'apiKeyHelper or the key in the file');
  });

  it('(3) the environment of the child comes from the executor allow-list: test and sensitive variables removed (ANTHROPIC_API_KEY, the incoming ANTHROPIC_AUTH_TOKEN, the provider variables); the fake token arrives explicitly; only PATH and HOME arrive from the base', () => {
    const f = fixture();
    const r = doctor(f, { FAKE_SCENARIO: 'ok', ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', GH_TOKEN: 'gh' });
    check(r.status === 0 && r.env.includes('ANTHROPIC_AUTH_TOKEN'), js({ s: r.status, e: r.stderr }));
    check(!['OMC_PROVIDER_CLAUDE_BIN', 'OMC_PROVIDER_API_KEY_FILE', 'OMC_PROVIDER_BASE_URL', 'OMC_PROVIDER_PROFILES_FILE', 'ANTHROPIC_API_KEY', 'GH_TOKEN'].some((z) => r.env.includes(z)), js(r.env?.filter((z) => z.includes('PROVIDER') || z.includes('ANTHROPIC') || z.includes('TOKEN'))));
    const outsideBase = r.env.filter((z) => !['PATH', 'HOME', 'ANTHROPIC_AUTH_TOKEN'].includes(z) && !/^(LC_|OMC_TEAM_)/.test(z) && !['USER', 'LANG', 'TMPDIR', 'TZ', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING'].includes(z));
    check(outsideBase.length === 0, `outside the allow-list: ${js(outsideBase)}`);
  });

  it('(4) classification of a failure by the failure class: the quota codes 1308 and 1310 give exit code 4 and the pause message (not a configuration error); a plain 429 is throttle (exit code 1, FAILURE, not a pause)', () => {
    const f = fixture({ errorCodes: { quota: [1308, 1310], throttle: [1305] } });
    const a = doctor(f, { FAKE_SCENARIO: 'quota1308' });
    check(a.status === 4 && /QUOTA \(pause\)/.test(a.stdout) && /not a configuration error/.test(a.stdout), js({ s: a.status, o: a.stdout, e: a.stderr }));
    const b = doctor(f, { FAKE_SCENARIO: 'quota1310' });
    check(b.status === 4 && /QUOTA \(pause\)/.test(b.stdout), js({ s: b.status, o: b.stdout }));
    const c = doctor(f, { FAKE_SCENARIO: 'quota429' });
    check(c.status === 1 && /FAILURE \(throttle\)/.test(c.stdout), js({ s: c.status, o: c.stdout }));
  });

  it('(5) another failure of the executor: exit code 1; an answer from another model than the worker model: exit code 2 (bad configuration)', () => {
    const f = fixture();
    const a = doctor(f, { FAKE_SCENARIO: 'failure' });
    check(a.status === 1 && /FAILURE/.test(a.stdout), js({ s: a.status, o: a.stdout }));
    const c = doctor(f, { FAKE_SCENARIO: 'other' });
    check(c.status === 2 && /another model/.test(c.stderr), js({ s: c.status, e: c.stderr }));
  });

  it('(6) bad configuration before the start: a foreign address, a bad model alias, a bad effort (exit code 2, the fake not called); no key: exit code 3; no binary: exit code 127; usage without a subcommand: exit code 2', () => {
    const notCalled = (r) => (!r.called ? '' : 'fake called');
    const f = fixture();
    const a = doctor(f, { OMC_PROVIDER_BASE_URL: 'https://foreign.example' });
    check(a.status === 2 && !a.called, js({ s: a.status, w: notCalled(a), e: a.stderr }));
    const b = doctor(f, { OMC_PROVIDER_WORKER_MODEL: 'a b;rm' });
    check(b.status === 2 && !b.called, js({ s: b.status, w: notCalled(b), e: b.stderr }));
    const b2 = doctor(f, { OMC_PROVIDER_WORKER_EFFORT: 'ultra' });
    check(b2.status === 2 && !b2.called, js({ s: b2.status, w: notCalled(b2), e: b2.stderr }));
    const c = doctor(f, { OMC_PROVIDER_API_KEY_FILE: join(f.dir, 'missing') });
    check(c.status === 3 && !c.called && /no usable provider API key/.test(c.stderr) && !c.stderr.includes(f.dir), js({ s: c.status, e: c.stderr }));
    const d = doctor(f, { OMC_PROVIDER_CLAUDE_BIN: join(f.dir, 'no-such-binary') });
    check(d.status === 127 && !d.called, js({ s: d.status, e: d.stderr }));
    const e0 = doctor(f, {}, []);
    check(e0.status === 2 && /Usage/.test(e0.stderr) && !e0.called, js({ s: e0.status, e: e0.stderr }));
  });

  it('(7) cleanup of the doctor-*.json copies: an old file goes, a foreign one stays, the current one stays; the key from the fake nowhere in any output of the test', () => {
    const f = fixture();
    const dir = join(f.state, 'worker-settings');
    mkdirSync(dir, { recursive: true });
    const longAgo = new Date(Date.now() - 3 * 86400_000);
    writeFileSync(join(dir, 'doctor-old-1.json'), '{}\n');
    utimesSync(join(dir, 'doctor-old-1.json'), longAgo, longAgo);
    writeFileSync(join(dir, 'other.json'), '{}\n');
    const r = doctor(f, { FAKE_SCENARIO: 'ok' });
    const left = readdirSync(dir).sort();
    check(r.status === 0 && !left.includes('doctor-old-1.json') && left.includes('other.json') && left.some((n) => n.startsWith('doctor-')), js(left));
    check(!r.stdout.includes(KEY) && !r.stderr.includes(KEY), 'key in the output');
  });

  it('(8) the executor allow-list for the doctor: 15 sensitive variables of the input do not reach the fake (a key of another service, cloud credentials, OAuth, cloud switches, effort, subagent model, the compaction window); only the explicit ANTHROPIC_AUTH_TOKEN arrives', () => {
    const sensitive = { SERVICE_API_KEY: 'ts', GH_TOKEN: 'gh', GITHUB_TOKEN: 'gt', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk', AWS_SESSION_TOKEN: 'st', ANTHROPIC_API_KEY: 'ak2', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', VERTEX_REGION_ANTHROPIC: 'eu', VERTEX_REGION_CLAUDE: 'eu', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_SUBAGENT_MODEL: 'sub', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500' };
    const f = fixture();
    const r = doctor(f, { FAKE_SCENARIO: 'ok', ...sensitive });
    check(r.status === 0 && r.env, js({ s: r.status, e: r.stderr }));
    check(r.env.includes('ANTHROPIC_AUTH_TOKEN') && !Object.keys(sensitive).some((k) => r.env.includes(k)), js(r.env?.filter((z) => /TOKEN|KEY|AWS|VERTEX|CLAUDE/.test(z))));
  });

  it('(9) redaction in fail(): a model with an echo of the key in the fake answer (scenario key): the "another model" message on stderr has sk-[REDACTED], no key', () => {
    const f = fixture();
    const r = doctor(f, { FAKE_SCENARIO: 'key' });
    check(r.status === 2 && /another model/.test(r.stderr) && r.stderr.includes('sk-[REDACTED]') && !r.stderr.includes(KEY), js({ s: r.status, e: r.stderr }));
  });

  it('(L29) doctor on a real answer (a literal from a measurement: no model field, modelUsage with the model key): exit code 0 and the model from the modelUsage key', () => {
    const f = fixture();
    const answerFile = join(f.dir, 'real-answer.json');
    writeFileSync(answerFile, JSON.stringify(REAL_DOCTOR_ANSWER));
    const r = doctor(f, { FAKE_SCENARIO: 'real', FAKE_ANSWER_FILE: answerFile });
    check(r.status === 0 && /OK: model acme-small\[1m\]/.test(r.stdout), js({ s: r.status, o: r.stdout, e: r.stderr.slice(0, 200) }));
  });

  // ===== start, status, result, kill, list =====
  it('(L1) start: the id within 5 s (8 hex); the text `ptask-<id> ...`; the task file (id, team = slug, start/cwd/brief/text); provider-team with 1:claude:executor; start_exit_code 0; the gate once; omc not called', async () => {
    const quota = await fakeQuotaServer([limit5h(89), limitWeek(34)]);
    try {
      const f = fixture({}, { quotaUrl: quota.url });
      const t0 = Date.now();
      const r = await f.start(['Test the fake task']);
      const took = Date.now() - t0;
      const id = r.id;
      check(r.status === 0 && /^[0-9a-f]{8}$/.test(id) && took < 5000, `exit code ${r.status}, id ${id}, time ${took} ms, err ${r.stderr.slice(0, 300)}`);
      check(!r.stdout.includes(KEY), 'key in the start output');
      check(await waitFor(() => (f.task(id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(id))}`);
      const z = f.task(id);
      const text = `ptask-${id} Test the fake task`;
      check(z.id === id && z.team === slugLocal(text) && z.cwd === f.cwd && z.brief === null && z.text === text, js(z));
      check(!Number.isNaN(Date.parse(z.start)) && z.killed == null && z.start_exit_code === 0, js({ start: Date.parse(z.start), killed: z.killed, start_exit_code: z.start_exit_code }));
      const team = f.rows('1:claude:executor');
      check(team.length === 1 && js(team[0].argv) === js(['1:claude:executor', '--no-decompose', text]), `team: ${js(team)}`);
      check(f.omcCalls().length === 0, `omc called by start: ${js(f.omcCalls())}`);
      check(quota.hits.length === 1, `quota requests ${quota.hits.length}`);
    } finally { await quota.close(); }
  });

  it('(L2) start --brief: the text `ptask-<id> Read <path> in full and carry it out.`; the brief field = an absolute path', async () => {
    const f = fixture();
    const brief = join(f.dir, 'task-brief.md');
    writeFileSync(brief, '# task brief\n');
    const r = await f.start(['--brief', brief]);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `exit code ${r.status}, err ${r.stderr.slice(0, 300)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const z = f.task(r.id);
    const text = `ptask-${r.id} Read ${brief} in full and carry it out.`;
    check(z.brief === brief && z.text === text && z.team === slugLocal(text), js(z));
  });

  it('(L3) start on a quota gate refusal (the 5 h window at 96 %, the PAUSE threshold): exit code 4, the gate message, provider-team not called, no task file', async () => {
    const quota = await fakeQuotaServer([limit5h(96)]);
    try {
      const f = fixture({}, { quotaUrl: quota.url });
      const r = await f.start(['Test the refusal']);
      check(r.status === 4 && /5 h window used at 96% \(threshold 96%\)/.test(r.stderr) && /reset:/.test(r.stderr) && !r.stderr.includes(KEY), js({ status: r.status, err: r.stderr.slice(0, 300) }));
      check(f.rows('1:claude:executor').length === 0, 'provider-team called despite the gate refusal');
      check(!existsSync(f.tasks) || readdirSync(f.tasks).length === 0, `a task file exists despite the refusal: ${existsSync(f.tasks) ? js(readdirSync(f.tasks)) : ''}`);
      check(quota.hits.length === 1, `quota requests ${quota.hits.length}`);
    } finally { await quota.close(); }
  });

  it('(L4) slots without taking one: 16 live (the tuned limit) give exit code 3; a dead and a corrupt one do not count; limit 1 with one live: exit code 3', async () => {
    const slots = (f, count) => {
      const dir = join(f.state, 'slots');
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) writeFileSync(join(dir, `slot-x-${i}.json`), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return dir;
    };
    const dead = deadPid();
    check(!alive(dead), `a dead pid is alive: ${dead}`);
    const fa = fixture();
    slots(fa, 16);
    const ra = await fa.start(['Test the slots']);
    check(ra.status === 3 && /no free provider session slot \(limit 16/.test(ra.stderr), js({ s: ra.status, e: ra.stderr.slice(0, 200) }));
    check(fa.rows('1:claude:executor').length === 0, 'provider-team called with no free slot');
    const fb = fixture();
    const slotsDir = slots(fb, 15);
    writeFileSync(join(slotsDir, 'slot-dead.json'), JSON.stringify({ pid: dead, ts: Date.now() }));
    writeFileSync(join(slotsDir, 'slot-broken.json'), '{not-json');
    const rb = await fb.start(['Test the dead slots']);
    check(rb.status === 0, `exit code ${rb.status}, err ${rb.stderr.slice(0, 200)}`);
    const fc = fixture({ limits: { maxSessions: 1 } });
    slots(fc, 1);
    const rc = await fc.start(['Test the slot limit']);
    check(rc.status === 3 && /limit 1/.test(rc.stderr), js({ s: rc.status, e: rc.stderr.slice(0, 200) }));
  });

  it('(L5) status on the fake (in_progress): JSON with id, team, status, worker, task; omc called (list-tasks and read-task), the .log file not read', async () => {
    const f = fixture();
    const r = await f.start(['Test the status']);
    check(r.status === 0 && await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start: ${js(f.task(r.id))}`);
    const id = r.id;
    // The OMC task is recognized by the subject `ptask-<id> ...` (the scenario is built after the start, when the id is known).
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: `ptask-${id} Test the status`, status: 'in_progress', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'in_progress', owner: 'worker-1', result: null } },
    });
    writeFileSync(join(f.tasks, `${id}.log`), 'secret-task-log\n');
    const rs = f.run(['status', id], scenario);
    check(rs.status === 0, `status exit code ${rs.status}, err ${rs.stderr.slice(0, 200)}`);
    const w = JSON.parse(rs.stdout);
    check(w.id === id && w.team === f.task(id).team && w.status === 'in_progress' && w.worker === 'worker-1', js(w));
    check(w.task && w.task.id === 'task-1' && w.start_exit_code === 0 && !rs.stdout.includes('secret-task-log'), js(w));
    check(f.rows('list-tasks').length === 1 && f.rows('"read-task"').length === 1, `omc calls: ${js(f.rows().map((x) => x.argv))}`);
  });

  it('(L6) a failed start: provider-team exit code 4 gives start_exit_code 4 and the status start_failed (omc not called, .log not read); start_error from stderr through the redaction', async () => {
    const f = fixture();
    const secret = `sk-${'a'.repeat(20)}`;
    const r = await f.start(['Test start_failed'], undefined, { FAKE_TEAM_EXIT: '4', FAKE_TEAM_STDERR: `${secret} secret` });
    check(r.status === 0, `start exit code: ${r.status}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 4), `start_exit_code: ${js(f.task(r.id))}`);
    writeFileSync(join(f.tasks, `${r.id}.log`), 'secret-task-log\n');
    const rs = f.run(['status', r.id], f.scenario({}));
    const w = JSON.parse(rs.stdout);
    check(w.status === 'start_failed' && w.start_exit_code === 4 && !rs.stdout.includes('secret-task-log'), js(w));
    const omcBefore = f.omcCalls().length;
    check(f.omcCalls().length === omcBefore, 'omc called for start_failed');
    // start_error: the last stderr line of provider-team through the redaction (the secret sk-... is redacted)
    check(w.start_error === `${secret} secret`.replace(secret, 'sk-[REDACTED]'), js(w));
  });

  it('(L7) result without the result module: JSON { id, team, status, result_raw }; verdict and verdict_ts written to the task file BEFORE printing, the verdict without result_raw', async () => {
    const f = fixture();
    const r = await f.start(['Test result']);
    check(r.status === 0 && await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start: ${js(f.task(r.id))}`);
    const id = r.id;
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: `ptask-${id} Test result`, status: 'completed', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'completed', owner: 'worker-1', result: 'Result: done.' } },
    });
    const rr = f.run(['result', id], scenario);
    check(rr.status === 0, `result exit code ${rr.status}, err ${rr.stderr.slice(0, 200)}`);
    const w = JSON.parse(rr.stdout);
    check(w.id === id && w.team === f.task(id).team && w.status === 'completed' && w.result_raw === 'Result: done.', js(w));
    check(!('cause' in w) && !('handoff' in w), `evaluation without the module: ${js(w)}`);
    const z = f.task(id);
    check(z.verdict && z.verdict.status === 'completed' && !('result_raw' in z.verdict) && !Number.isNaN(Date.parse(z.verdict_ts)), js({ verdict: z.verdict, ts: z.verdict_ts }));
  });

  it('(L8) result with a fake result module (OMC_PROVIDER_TASK_RESULT_MODULE): evaluation fields + result_raw; the verdict written without result_raw; no task journal module: stderr about the journal, the output without header', async () => {
    const f = fixture();
    const r = await f.start(['Test result with the module']);
    check(r.status === 0 && await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start: ${js(f.task(r.id))}`);
    const id = r.id;
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: `ptask-${id} Test result with the module`, status: 'completed', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'completed', owner: 'worker-1', result: 'Result: done and checked.' } },
    });
    const fakeModule = join(f.dir, 'fake-result.cjs');
    writeFileSync(fakeModule, "module.exports = { STATUSES: ['success'], evaluateResult: ({ task, taskFile }) => ({ status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: 'fake evaluation: ' + String(task && task.status) + ' / task file ' + String(taskFile && taskFile.id), points: null, handoff: false, errors: [] }) };\n");
    const rr = f.run(['result', id], scenario, { OMC_PROVIDER_TASK_RESULT_MODULE: fakeModule });
    check(rr.status === 0, `result exit code ${rr.status}, err ${rr.stderr.slice(0, 300)}`);
    const w = JSON.parse(rr.stdout);
    check(w.status === 'success' && w.evidence === `fake evaluation: completed / task file ${id}` && w.result_raw === 'Result: done and checked.', js(w));
    check(w.cause === null && w.handoff === false && js(w.errors) === '[]', js(w));
    check(!('header' in w) && /task journal is unavailable/.test(rr.stderr), `header/stderr: ${js(rr.stderr.slice(0, 200))}`);
    const z = f.task(id);
    check(z.verdict && z.verdict.status === 'success' && z.verdict.evidence === w.evidence && !('result_raw' in z.verdict) && !('header' in z.verdict) && z.verdict_ts, js(z.verdict));
  });

  it('(L9) kill: killed (ISO) written to the task file BEFORE shutdown --force (the fake omc confirms from the file); the argv of shutdown exactly; exit code 0', async () => {
    const f = fixture();
    const stop = join(f.dir, 'stop-z9');
    const r = await f.start(['Test kill'], undefined, { FAKE_TEAM_STOP: stop, FAKE_TEAM_WAIT_MS: '20000' });
    check(r.status === 0 && await waitFor(() => f.rows('1:claude:executor').length >= 1), `start: ${js(r.stdout)}`);
    const rk = f.run(['kill', r.id], f.scenario({}));
    check(rk.status === 0, `kill exit code ${rk.status}, err ${rk.stderr.slice(0, 200)}`);
    const z = f.task(r.id);
    check(z.killed && !Number.isNaN(Date.parse(z.killed)), js(z));
    const sh = f.shutdowns();
    check(sh.length === 1 && f.rows().some((x) => x.shutdown === 'killed-set'), `order of killed: ${js(f.rows())}`);
    check(js(sh[0].argv) === js(['team', 'shutdown', z.team, '--force']), `argv of shutdown: ${js(sh[0].argv)}`);
    writeFileSync(stop, 'x\n'); // the end of the fake provider-team (the _start child records start_exit_code)
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code after the stop: ${js(f.task(r.id))}`);
  });

  it('(L10) list: statuses from the files (start_failed, killed, unknown) without calling omc; --refresh calls list-tasks per task', () => {
    const f = fixture();
    f.put('aaaa0001', { id: 'aaaa0001', team: 'ptask-aaaa0001-x', start: '2026-11-14T10:00:00.000Z', start_exit_code: 4 });
    f.put('aaaa0002', { id: 'aaaa0002', team: 'ptask-aaaa0002-x', start: '2026-11-14T10:01:00.000Z', killed: '2026-11-14T10:05:00.000Z' });
    f.put('aaaa0003', { id: 'aaaa0003', team: 'ptask-aaaa0003-x', start: '2026-11-14T10:02:00.000Z' });
    // --refresh recognizes the OMC task by the subject `ptask-<id> ...` (a scenario with three tasks whose subjects carry the ids of the state files).
    const scenario = f.scenario({ listTasks: { ok: true, data: { count: 3, tasks: [
      { id: 'task-a1', subject: 'ptask-aaaa0001 refresh status', status: 'in_progress', owner: 'worker-1' },
      { id: 'task-a2', subject: 'ptask-aaaa0002 refresh status', status: 'in_progress', owner: 'worker-1' },
      { id: 'task-a3', subject: 'ptask-aaaa0003 refresh status', status: 'in_progress', owner: 'worker-1' },
    ] } } });
    const r1 = f.run(['list'], scenario);
    const l1 = JSON.parse(r1.stdout);
    check(r1.status === 0 && js(l1) === js([
      { id: 'aaaa0001', team: 'ptask-aaaa0001-x', start: '2026-11-14T10:00:00.000Z', status: 'start_failed' },
      { id: 'aaaa0002', team: 'ptask-aaaa0002-x', start: '2026-11-14T10:01:00.000Z', status: 'killed' },
      { id: 'aaaa0003', team: 'ptask-aaaa0003-x', start: '2026-11-14T10:02:00.000Z', status: 'unknown' },
    ]), js(l1));
    check(f.omcCalls().length === 0, `list without --refresh called omc: ${js(f.omcCalls())}`);
    const r2 = f.run(['list', '--refresh'], scenario);
    const l2 = JSON.parse(r2.stdout);
    check(l2.every((w) => w.status === 'in_progress'), js(l2));
    check(f.omcCalls().filter((x) => x.argv[2] === 'list-tasks').length === 3, `list-tasks: ${js(f.omcCalls())}`);
  });

  it('(L11) start --max-tool-calls 5: the field max_tool_calls = 5 in the task file', async () => {
    const f = fixture();
    const r = await f.start(['Test max-tool-calls', '--max-tool-calls', '5']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}, err ${r.stderr.slice(0, 200)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    check(f.task(r.id).max_tool_calls === 5, js(f.task(r.id)));
  });

  it('(L12) the task file lock: a live process makes kill wait (exit code 1, no shutdown); a dead one is taken over (killed and shutdown go); separate state', () => {
    const f = fixture();
    f.put('bbbb0001', { id: 'bbbb0001', team: 'ptask-bbbb0001-x', start: '2026-11-14T11:00:00.000Z' });
    f.put('bbbb0002', { id: 'bbbb0002', team: 'ptask-bbbb0002-x', start: '2026-11-14T11:00:00.000Z' });
    const dead = deadPid();
    check(!alive(dead), `a dead pid is alive: ${dead}`);
    writeFileSync(join(f.tasks, 'bbbb0001.json.lock'), js({ pid: process.pid, ts: Date.now() }));
    const r1 = f.run(['kill', 'bbbb0001'], f.scenario({}), { OMC_PROVIDER_TASK_LOCK_LIMIT_MS: '500' });
    check(r1.status === 1 && /lock .* held longer than the limit/.test(r1.stderr), js({ s: r1.status, e: r1.stderr.slice(0, 200) }));
    check(f.omcCalls().length === 0, `shutdown with a live lock: ${js(f.omcCalls())}`);
    check(existsSync(join(f.tasks, 'bbbb0001.json.lock')), 'a foreign lock destroyed');
    check(!('killed' in JSON.parse(readFileSync(join(f.tasks, 'bbbb0001.json'), 'utf8'))), 'killed written despite a live lock');

    writeFileSync(join(f.tasks, 'bbbb0002.json.lock'), js({ pid: dead, ts: Date.now() }));
    const r2 = f.run(['kill', 'bbbb0002'], f.scenario({}));
    check(r2.status === 0, `kill with a dead lock: ${js({ s: r2.status, e: (r2.stderr || '').slice(0, 200) })}`);
    check(JSON.parse(readFileSync(join(f.tasks, 'bbbb0002.json'), 'utf8')).killed, 'killed missing after taking over the lock');
    check(f.shutdowns().length === 1 && f.rows().some((x) => x.shutdown === 'killed-set'), `shutdowns: ${js(f.rows())}`);
    check(!existsSync(join(f.tasks, 'bbbb0002.json.lock')), 'the dead lock not removed after the operation');
  });

  it('(L13) correction of the team name by _start from the team state directory (the fake creates ptask-<id>-actual); the team field corrected', async () => {
    const f = fixture();
    const teamDir = await teamDirOf(f);
    const r = await f.start(['Test the name correction'], undefined, { FAKE_TEAM_DIR: teamDir, OMC_PROVIDER_TASK_POLL_MS: '3000' });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}, err ${r.stderr.slice(0, 200)}`);
    check(await waitFor(() => (f.task(r.id) || {}).team === `ptask-${r.id}-actual`), `team: ${js(f.task(r.id))}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
  }, 60000);

  it('(L14) the poll accepts a name with a number (the form of OMC on a name collision): the fake creates ptask-<id>-2; the team field = ptask-<id>-2', async () => {
    const f = fixture();
    const teamDir = await teamDirOf(f);
    const r = await f.start(['Test the numbered name'], undefined, { FAKE_TEAM_DIR: teamDir, FAKE_TEAM_NAME: '2', OMC_PROVIDER_TASK_POLL_MS: '3000' });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}, err ${r.stderr.slice(0, 200)}`);
    check(await waitFor(() => (f.task(r.id) || {}).team === `ptask-${r.id}-2`), `team: ${js(f.task(r.id))}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
  }, 60000);

  it('(L15) usage: without a subcommand all subcommands are listed, exit code 2; status/kill/result without an id: exit code 2; start without a text and without --brief: exit code 2', () => {
    const f = fixture();
    const scenario = f.scenario({});
    const a = spawnSync(process.execPath, [TASK], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.home } });
    check(a.status === 2 && /Usage/.test(a.stderr) && ['doctor', 'start', 'status', 'result', 'kill', 'list'].every((p) => a.stderr.includes(p)), js(a.stderr.slice(0, 400)));
    const b = f.run(['status'], scenario);
    check(b.status === 2 && /Usage/.test(b.stderr), js({ s: b.status, e: b.stderr.slice(0, 200) }));
    const c = f.run(['kill'], scenario);
    check(c.status === 2 && /Usage/.test(c.stderr), js({ s: c.status, e: c.stderr.slice(0, 200) }));
    const d = f.run(['result'], scenario);
    check(d.status === 2 && /Usage/.test(d.stderr), js({ s: d.status, e: d.stderr.slice(0, 200) }));
    const g = f.run(['start'], scenario);
    check(g.status === 2 && /Usage/.test(g.stderr), js({ s: g.status, e: g.stderr.slice(0, 200) }));
    const h = f.run(['status', '00000000'], scenario);
    check(h.status === 2 && /no task file/.test(h.stderr), js({ s: h.status, e: h.stderr.slice(0, 200) }));
  });

  it('(L16) the argv of provider-team contains --no-decompose between the role 1:claude:executor and the task text', async () => {
    const f = fixture();
    const r = await f.start(['Test no-decompose']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}, err ${r.stderr.slice(0, 200)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const team = f.rows('1:claude:executor');
    check(team.length === 1 && team[0].argv[0] === '1:claude:executor' && team[0].argv[1] === '--no-decompose' && team[0].argv[2] === `ptask-${r.id} Test no-decompose`, `argv: ${js(team)}`);
  });

  it('(L17) choice of the OMC task by subject: list-tasks with a newer task of a foreign subject and an older ptask-<id> ... -> the older one chosen (read-task for it)', async () => {
    const f = fixture();
    const r = await f.start(['Test the choice by subject']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const id = r.id;
    // The foreign task has the GREATER id (newer); matching by subject must choose the older ptask-<id> ... (string ids: 'task-9999' > 'task-100').
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 2, tasks: [
        { id: 'task-9999', subject: 'a foreign task with another subject', status: 'completed', owner: 'worker-2' },
        { id: 'task-100', subject: `ptask-${id} Test the choice by subject`, status: 'completed', owner: 'worker-1' },
      ] } },
      readTask: { 'task-100': { id: 'task-100', subject: `ptask-${id} Test the choice by subject`, status: 'completed', owner: 'worker-1', result: 'Summary: chosen by subject.\nStatus: success' } },
    });
    const fakeModule = join(f.dir, 'fake-result-z17.cjs');
    writeFileSync(fakeModule, "module.exports = { STATUSES: ['success'], evaluateResult: ({ task }) => ({ status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: 'task: ' + String(task && task.id), points: null, handoff: false, errors: [] }) };\n");
    const rr = f.run(['result', id], scenario, { OMC_PROVIDER_TASK_RESULT_MODULE: fakeModule });
    check(rr.status === 0, `result exit code ${rr.status}, err ${rr.stderr.slice(0, 300)}`);
    const w = JSON.parse(rr.stdout);
    check(w.status === 'success' && w.evidence === 'task: task-100', js(w));
    check(w.result_raw === 'Summary: chosen by subject.\nStatus: success', js(w));
  });

  it('(L18) no matching OMC task: 59 s after start (OMC_PROVIDER_TASK_NOW) result is in_progress without a verdict write and status pending; 61 s: result writes start_failed/environment as the verdict and status shows start_failed', async () => {
    const f = fixture();
    const r = await f.start(['Test the grace period']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const id = r.id;
    const startMs = Date.parse(f.task(id).start);
    // The grace period of 60 s from the start field applies only to a file without start_pid and omc_started_at (a file from before they existed).
    // A task from a real start has these fields, so they are removed here (the scenario "an old file"); the grace period from omc_started_at has its own cases.
    const z18 = f.task(id);
    delete z18.omc_started_at;
    delete z18.start_pid;
    delete z18.start_pid_starttime;
    f.put(id, z18);
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    // The grace period (59 s): result in_progress, no verdict write; status pending.
    const r59 = f.run(['result', id], empty, { OMC_PROVIDER_TASK_NOW: String(startMs + 59_000) });
    check(r59.status === 0, `result 59 s exit code ${r59.status}, err ${r59.stderr.slice(0, 200)}`);
    const w59 = JSON.parse(r59.stdout);
    check(w59.status === 'in_progress' && w59.handoff === false, js(w59));
    check(!f.task(id).verdict, `verdict written in the grace period: ${js(f.task(id))}`);
    const s59 = f.run(['status', id], empty, { OMC_PROVIDER_TASK_NOW: String(startMs + 59_000) });
    check(s59.status === 0 && JSON.parse(s59.stdout).status === 'pending', js({ s: s59.status, o: s59.stdout, e: s59.stderr.slice(0, 200) }));
    // After the grace period (61 s): result writes the start_failed/environment verdict (with verdict_ts) and prints it; status shows start_failed.
    const r61 = f.run(['result', id], empty, { OMC_PROVIDER_TASK_NOW: String(startMs + 61_000), OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE });
    check(r61.status === 0, `result 61 s exit code ${r61.status}, err ${r61.stderr.slice(0, 200)}`);
    const w61 = JSON.parse(r61.stdout);
    check(w61.status === 'start_failed' && w61.cause === 'environment' && w61.handoff === true && js(w61.errors) === js([`OMC task ptask-${id} not found in team ${f.task(id).team}`]), js(w61));
    check(f.task(id).verdict && f.task(id).verdict.status === 'start_failed' && !Number.isNaN(Date.parse(f.task(id).verdict_ts)), js(f.task(id).verdict));
    const s61 = f.run(['status', id], empty, { OMC_PROVIDER_TASK_NOW: String(startMs + 61_000) });
    check(s61.status === 0 && JSON.parse(s61.stdout).status === 'start_failed', js({ s: s61.status, o: s61.stdout }));
  });

  it('(L19) heartbeat from read-worker-heartbeat for the evaluation (the real result module): in_progress + heartbeat of 61 s -> worker_dead (verdict written); heartbeat of 30 s -> in_progress, no verdict in the task file; an old last_turn_at with alive true is not proof of death', async () => {
    const f = fixture();
    const real = { OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE };
    // (a) heartbeat of 61 s: proof of death, the evaluation worker_dead.
    const ra = await f.start(['Test a dead heartbeat']);
    check(ra.status === 0 && /^[0-9a-f]{8}$/.test(ra.id), `start: ${js(ra.stdout)}`);
    check(await waitFor(() => (f.task(ra.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(ra.id))}`);
    const id = ra.id;
    const startMs = Date.parse(f.task(id).start);
    const scenario61 = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-100', subject: `ptask-${id} Test a dead heartbeat`, status: 'in_progress', owner: 'worker-1' }] } },
      readTask: { 'task-100': { id: 'task-100', status: 'in_progress', owner: 'worker-1', result: null } },
      heartbeat: { pid: 4242, last_turn_at: new Date(startMs).toISOString(), turn_count: 1, alive: false }, // the real shape of data.heartbeat; proof of death: alive false
    });
    const rr = f.run(['result', id], scenario61, { ...real, OMC_PROVIDER_TASK_NOW: String(startMs + 61_000) });
    check(rr.status === 0, `result 61 s exit code ${rr.status}, err ${rr.stderr.slice(0, 300)}`);
    const w = JSON.parse(rr.stdout);
    check(w.status === 'worker_dead' && w.handoff === true && /alive false/.test(js(w.errors)), js(w));
    check(f.task(id).verdict && f.task(id).verdict.status === 'worker_dead', js(f.task(id).verdict));
    // (b) heartbeat of 30 s: no proof of death, the evaluation in_progress, no verdict write.
    const rb = await f.start(['Test a live heartbeat']);
    check(rb.status === 0 && /^[0-9a-f]{8}$/.test(rb.id), `start b: ${js(rb.stdout)}`);
    check(await waitFor(() => (f.task(rb.id) || {}).start_exit_code === 0), `start_exit_code b: ${js(f.task(rb.id))}`);
    const startMsB = Date.parse(f.task(rb.id).start);
    const scenario30 = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-100', subject: `ptask-${rb.id} Test a live heartbeat`, status: 'in_progress', owner: 'worker-1' }] } },
      readTask: { 'task-100': { id: 'task-100', status: 'in_progress', owner: 'worker-1', result: null } },
      heartbeat: { pid: 4242, last_turn_at: new Date(startMsB + 30_000).toISOString(), turn_count: 1, alive: true },
    });
    const rrB = f.run(['result', rb.id], scenario30, { ...real, OMC_PROVIDER_TASK_NOW: String(startMsB + 61_000) });
    check(rrB.status === 0, `result 30 s exit code ${rrB.status}, err ${rrB.stderr.slice(0, 300)}`);
    const wB = JSON.parse(rrB.stdout);
    check(wB.status === 'in_progress' && wB.handoff === false, js(wB));
    check(!f.task(rb.id).verdict, `verdict written while in_progress: ${js(f.task(rb.id))}`);
    // (c) an old last_turn_at (8 h) with alive true is NOT proof of death: the evaluation in_progress (not worker_dead), the age of last_turn_at only informational in heartbeat_age_s (>= 8 h).
    const rc = await f.start(['Test an old heartbeat']);
    check(rc.status === 0 && /^[0-9a-f]{8}$/.test(rc.id), `start c: ${js(rc.stdout)}`);
    check(await waitFor(() => (f.task(rc.id) || {}).start_exit_code === 0), `start_exit_code c: ${js(f.task(rc.id))}`);
    const startMsC = Date.parse(f.task(rc.id).start);
    const scenarioOld = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-100', subject: `ptask-${rc.id} Test an old heartbeat`, status: 'in_progress', owner: 'worker-1' }] } },
      readTask: { 'task-100': { id: 'task-100', status: 'in_progress', owner: 'worker-1', result: null } },
      heartbeat: { pid: 4243, last_turn_at: new Date(startMsC - 8 * 3600_000).toISOString(), turn_count: 3, alive: true },
    });
    const rrC = f.run(['result', rc.id], scenarioOld, { ...real, OMC_PROVIDER_TASK_NOW: String(startMsC + 61_000) });
    check(rrC.status === 0, `result 8 h exit code ${rrC.status}, err ${rrC.stderr.slice(0, 300)}`);
    const wC = JSON.parse(rrC.stdout);
    check(wC.status === 'in_progress' && wC.handoff === false && typeof wC.heartbeat_age_s === 'number' && wC.heartbeat_age_s >= 8 * 3600, js(wC));
    check(!f.task(rc.id).verdict, `verdict written with an old heartbeat: ${js(f.task(rc.id))}`);
  }, 60000);

  it('(L20) one verdict: a second result after a saved verdict does not call the result module (a counter in a file) and prints the same status; kill after the verdict -> the output killed, the verdict untouched', async () => {
    const f = fixture();
    const r = await f.start(['Test one verdict']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const id = r.id;
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-100', subject: `ptask-${id} Test one verdict`, status: 'completed', owner: 'worker-1' }] } },
      readTask: { 'task-100': { id: 'task-100', status: 'completed', owner: 'worker-1', result: 'Summary: one verdict.\nStatus: success' } },
    });
    // A fake result module with a call counter in a file (every result is a separate process).
    const counter = join(f.dir, 'counter');
    writeFileSync(counter, '0');
    const fakeModule = join(f.dir, 'fake-counter.cjs');
    writeFileSync(fakeModule, `const fs = require('node:fs');
module.exports = { STATUSES: ['success'], evaluateResult: () => { const n = Number(fs.readFileSync(process.env.COUNTER_FILE, 'utf8').trim() || '0'); fs.writeFileSync(process.env.COUNTER_FILE, String(n + 1)); return { status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: 'fake-counter', points: null, handoff: false, errors: [] }; } };\n`);
    const extra = { OMC_PROVIDER_TASK_RESULT_MODULE: fakeModule, COUNTER_FILE: counter };
    const rr1 = f.run(['result', id], scenario, extra);
    check(rr1.status === 0 && JSON.parse(rr1.stdout).status === 'success' && JSON.parse(rr1.stdout).evidence === 'fake-counter', js({ s: rr1.status, o: rr1.stdout.slice(0, 300), e: rr1.stderr.slice(0, 200) }));
    check(readFileSync(counter, 'utf8') === '1', `counter after the first result: ${readFileSync(counter, 'utf8')}`);
    const verdict1 = f.task(id).verdict;
    check(verdict1 && verdict1.status === 'success' && verdict1.evidence === 'fake-counter', js(verdict1));
    // The second result: the result module NOT called (the counter still 1), the same status printed (and result_raw from the OMC task).
    const rr2 = f.run(['result', id], scenario, extra);
    check(rr2.status === 0 && JSON.parse(rr2.stdout).status === 'success', js({ s: rr2.status, o: rr2.stdout.slice(0, 300) }));
    check(JSON.parse(rr2.stdout).result_raw === 'Summary: one verdict.\nStatus: success', js(JSON.parse(rr2.stdout)));
    check(readFileSync(counter, 'utf8') === '1', `counter after the second result: ${readFileSync(counter, 'utf8')}`);
    check(js(f.task(id).verdict) === js(verdict1), 'the verdict overwritten by the second result');
    // Kill after the verdict: the output status killed, the verdict in the file untouched.
    const rk = f.run(['kill', id], scenario);
    check(rk.status === 0, `kill exit code ${rk.status}, err ${rk.stderr.slice(0, 200)}`);
    const rr3 = f.run(['result', id], scenario, extra);
    const w3 = JSON.parse(rr3.stdout);
    check(w3.status === 'killed' && w3.result_raw === 'Summary: one verdict.\nStatus: success', js(w3));
    check(js(f.task(id).verdict) === js(verdict1), 'the verdict overwritten with killed');
  });

  it('(L21) status: the OMC task wins over start_exit_code (start_exit_code 1 + a task in_progress -> in_progress); a failed list-tasks -> in_progress (not start_failed); start_exit_code 4 without a task in the grace period -> start_failed at once', () => {
    const f = fixture();
    const scenario = f.scenario({ listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: 'ptask-cccc0001 Test status over start_exit_code', status: 'in_progress', owner: 'worker-1' }] } } });
    f.put('cccc0001', { id: 'cccc0001', team: 'ptask-cccc0001-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 1, start_error: 'startup_failure worker=worker-1 [REDACTED]' });
    const rs = f.run(['status', 'cccc0001'], scenario);
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'in_progress' && JSON.parse(rs.stdout).task && JSON.parse(rs.stdout).task.id === 'task-1', js({ o: rs.stdout, e: rs.stderr.slice(0, 200) }));
    // (b) a failed list-tasks (exit code 1): in_progress with a message on stderr, not start_failed after the grace period
    const rs2 = f.run(['status', 'cccc0001'], f.scenario({ listTasksExit: 1 }));
    check(rs2.status === 0 && JSON.parse(rs2.stdout).status === 'in_progress', js({ o: rs2.stdout, e: rs2.stderr.slice(0, 200) }));
    check(/list-tasks ended with exit code 1/.test(rs2.stderr), js(rs2.stderr.slice(0, 200)));
    // (c) start_exit_code 4 without a task, NOW = start + 10 s (inside the grace period): start_failed at once, without waiting 60 s
    f.put('cccc0003', { id: 'cccc0003', team: 'ptask-cccc0003-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 4 });
    const rs3 = f.run(['status', 'cccc0003'], f.scenario({}), { OMC_PROVIDER_TASK_NOW: String(Date.parse('2026-11-15T02:59:24.978Z') + 10_000) });
    check(rs3.status === 0 && JSON.parse(rs3.stdout).status === 'start_failed', js({ o: rs3.stdout, e: rs3.stderr.slice(0, 200) }));
  });

  it('(L22) result without an OMC task: start_exit_code 4 -> start_failed/quota at once (no 60 s); start_exit_code 1 -> environment; killed -> killed; start_exit_code 0 -> in_progress in the grace period', () => {
    const f = fixture();
    const verdictOf = (id) => (f.task(id) || {}).verdict;
    const NOW = String(Date.parse('2026-11-15T02:59:24.978Z') + 10_000);
    const extra = { OMC_PROVIDER_TASK_NOW: NOW, OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE };
    // (a) start_exit_code 4: start_failed/quota at once, without the grace period (NOW = start + 10 s, inside it)
    f.put('e0000001', { id: 'e0000001', team: 'ptask-e0000001-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 4 });
    const rz = f.run(['result', 'e0000001'], f.scenario({}), extra);
    const wz = JSON.parse(rz.stdout);
    check(rz.status === 0 && wz.status === 'start_failed' && wz.cause === 'quota' && wz.handoff === true, js({ o: rz.stdout, e: rz.stderr.slice(0, 200) }));
    check(verdictOf('e0000001') && verdictOf('e0000001').status === 'start_failed' && verdictOf('e0000001').cause === 'quota', js(verdictOf('e0000001')));
    // (b) start_exit_code 1 -> environment at once
    f.put('e0000002', { id: 'e0000002', team: 'ptask-e0000002-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 1 });
    const rz2 = f.run(['result', 'e0000002'], f.scenario({}), extra);
    const wz2 = JSON.parse(rz2.stdout);
    check(wz2.status === 'start_failed' && wz2.cause === 'environment', js(wz2));
    // (c) killed -> killed at once (no grace period), the verdict written
    f.put('e0000003', { id: 'e0000003', team: 'ptask-e0000003-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, killed: '2026-11-15T03:00:00.000Z' });
    const rz3 = f.run(['result', 'e0000003'], f.scenario({}), extra);
    const wz3 = JSON.parse(rz3.stdout);
    check(wz3.status === 'killed' && wz3.handoff === false, js({ o: rz3.stdout, e: rz3.stderr.slice(0, 200) }));
    check(verdictOf('e0000003') && verdictOf('e0000003').status === 'killed', js(verdictOf('e0000003')));
    // (d) start_exit_code 0 -> in_progress in the grace period, no verdict write
    f.put('e0000004', { id: 'e0000004', team: 'ptask-e0000004-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 0 });
    const rz4 = f.run(['result', 'e0000004'], f.scenario({}), extra);
    const wz4 = JSON.parse(rz4.stdout);
    check(wz4.status === 'in_progress' && wz4.handoff === false, js({ o: rz4.stdout, e: rz4.stderr.slice(0, 200) }));
    check(!verdictOf('e0000004'), js(f.task('e0000004')));
  });

  it('(L23) a race on writing the verdict: the result module saves a foreign verdict during the evaluation -> result prints the saved (foreign) one and does not overwrite it; the task file keeps the foreign verdict', () => {
    const f = fixture();
    // a completed task with Summary/Status (it passes the DoneClaim validation -> success)
    f.put('e0000005', { id: 'e0000005', team: 'ptask-e0000005-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd, start_exit_code: 0 });
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: 'ptask-e0000005 Test the race', status: 'completed', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'completed', owner: 'worker-1', result: 'Summary: one verdict.\nStatus: success' } },
    });
    // a fake result module: during the evaluation it writes a foreign verdict to the task file (the path from FAKE_TASKS_DIR + taskFile.id)
    const fakeModule = join(f.dir, 'fake-race.cjs');
    writeFileSync(fakeModule, `const fs = require('node:fs');
module.exports = { STATUSES: ['success'], evaluateResult: ({ taskFile }) => {
  if (taskFile && !taskFile.verdict) {
    const p = require('node:path').join(process.env.FAKE_TASKS_DIR, taskFile.id + '.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.verdict = { status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: 'foreign-verdict', points: null, escalation: null, handoff: false, errors: [] };
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  }
  return { status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: 'our-verdict', points: null, escalation: null, handoff: false, errors: [] };
} };
`);
    const rz = f.run(['result', 'e0000005'], scenario, { OMC_PROVIDER_TASK_RESULT_MODULE: fakeModule, FAKE_TASKS_DIR: f.tasks });
    const w = JSON.parse(rz.stdout);
    check(rz.status === 0 && w.status === 'success' && w.evidence === 'foreign-verdict', js({ o: rz.stdout, e: rz.stderr.slice(0, 300) }));
    check(f.task('e0000005').verdict && f.task('e0000005').verdict.evidence === 'foreign-verdict', js(f.task('e0000005').verdict));
  });

  it('(L24) the worker status through omc team api read-worker-status (one source for status and result): workerStatus blocked -> result blocked; blocked does not get lost; no status.json file under <cwd>/.omc/state/team', async () => {
    const f = fixture();
    const r = await f.start(['Test the worker status']);
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const id = r.id;
    const team = f.task(id).team;
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: `ptask-${id} Test the worker status`, status: 'in_progress', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'in_progress', owner: 'worker-1', result: null } },
      workerStatus: { state: 'blocked', reason: 'decision X needed' },
    });
    // no status.json file in the local directory <cwd>/.omc/state/team/<team>/workers/worker-1/ (reading a file from the first state directory would return null)
    const oldPath = join(f.cwd, '.omc', 'state', 'team', team, 'workers', 'worker-1', 'status.json');
    check(!existsSync(oldPath), `the status.json file exists: ${oldPath}`);
    const rr = f.run(['result', id], scenario, { OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE });
    check(rr.status === 0, `result exit code ${rr.status}, err ${rr.stderr.slice(0, 300)}`);
    const w = JSON.parse(rr.stdout);
    check(w.status === 'blocked' && w.required === 'decision X needed' && /read-worker-status/.test(js(f.rows('read-worker-status'))), js(w));
  });

  it('(L25) provider-team cannot be started (OMC_PROVIDER_TASK_TEAM_BIN = a missing file): start_exit_code 127, start_error ENOENT, status start_failed', async () => {
    const f = fixture();
    const r = await f.start(['Test a child error'], undefined, { OMC_PROVIDER_TASK_TEAM_BIN: join(f.dir, 'no-such-team-binary') });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout)}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 127), `start_exit_code: ${js(f.task(r.id))}`);
    const z = f.task(r.id);
    check(z.start_exit_code === 127 && z.start_error === 'ENOENT', js(z));
    const rs = f.run(['status', r.id], f.scenario({}));
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'start_failed', js({ o: rs.stdout, e: rs.stderr.slice(0, 200) }));
  });

  it('(L26) a lock with unreadable content: a fresh one (mtime now) -> kill waits (exit code 1, the lock untouched, no killed); an old one (mtime -70 s) -> taken over (kill goes, killed written, the lock removed)', () => {
    const f = fixture();
    f.put('bbbb0003', { id: 'bbbb0003', team: 'ptask-bbbb0003-x', start: '2026-11-15T02:59:24.978Z', cwd: f.cwd });
    const extra = { OMC_PROVIDER_TASK_LOCK_LIMIT_MS: '500' };
    const lock = join(f.tasks, 'bbbb0003.json.lock');
    // (a) a fresh unreadable lock: kill waits up to the limit, the lock untouched, killed not written
    const longAgo = new Date(Date.now() - 70_000);
    writeFileSync(lock, '');
    const r1 = f.run(['kill', 'bbbb0003'], f.scenario({}), extra);
    check(r1.status === 1 && /lock .* held longer than the limit/.test(r1.stderr), js({ s: r1.status, e: r1.stderr.slice(0, 200) }));
    check(existsSync(lock), 'a fresh lock removed');
    check(!f.task('bbbb0003').killed, js(f.task('bbbb0003')));
    // (b) an old unreadable lock: taken over, kill goes to the end
    utimesSync(lock, longAgo, longAgo);
    const r2 = f.run(['kill', 'bbbb0003'], f.scenario({}), extra);
    check(r2.status === 0, `kill with an old lock: ${js({ s: r2.status, e: r2.stderr.slice(0, 200) })}`);
    check(f.task('bbbb0003').killed && !Number.isNaN(Date.parse(f.task('bbbb0003').killed)), js(f.task('bbbb0003')));
    check(!existsSync(lock), 'an old lock not removed');
  });

  it('(L27) two starts in the same --cwd (0.2 s apart): both without start_failed; the second _start after the exit of the first fake; a start lock with a dead pid -> taken over at once', async () => {
    const f = fixture();
    const marker = join(f.dir, 'marker-z27');
    mkdirSync(marker, { recursive: true });
    // A fake provider-team with a marker file: a second run in the same directory -> invalid_persisted_state, exit code 1 (as the real omc with two starts).
    const fakeU4 = join(f.dir, 'team-fake-u4.cjs');
    writeFileSync(fakeU4, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.OMC_FAKE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ start: Date.now(), argv: args }) + '\\n');
const marker = process.env.MARKER_DIR + '/m';
if (fs.existsSync(marker)) { console.error('invalid_persisted_state'); if (log) fs.appendFileSync(log, JSON.stringify({ end: Date.now(), code: 1, argv: args }) + '\\n'); process.exit(1); }
fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
const waitMs = Number(process.env.FAKE_TEAM_U4_MS) || 0;
if (waitMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
if (log) fs.appendFileSync(log, JSON.stringify({ end: Date.now(), code: 0, argv: args }) + '\\n');
fs.unlinkSync(marker);
process.exit(0);
`, { mode: 0o755 });
    const common = { OMC_PROVIDER_TASK_TEAM_BIN: fakeU4, MARKER_DIR: marker };
    const first = f.start(['Test two starts'], undefined, { ...common, FAKE_TEAM_U4_MS: '600' });
    await sleep(200);
    const second = f.start(['Test two starts'], undefined, common);
    const [r1, r2] = await Promise.all([first, second]);
    const id1 = r1.id;
    const id2 = r2.id;
    check(/^[0-9a-f]{8}$/.test(id1) && /^[0-9a-f]{8}$/.test(id2), `id: ${js({ id1, id2 })}`);
    check(await waitFor(() => (f.task(id1) || {}).start_exit_code === 0 && (f.task(id2) || {}).start_exit_code === 0, 15000), `start_exit_code: ${js({ a: f.task(id1), b: f.task(id2) })}`);
    // order: the fake #1 ends before the fake #2 starts (the start lock serializes _start)
    const logRows = f.rows();
    const s2 = logRows.find((x) => x.start && js(x.argv).includes(id2));
    const e1 = logRows.find((x) => x.end != null && js(x.argv).includes(id1));
    check(e1 && s2 && e1.end <= s2.start, `order: ${js(logRows.filter((x) => x.start || x.end != null))}`);
    check(f.task(id1).omc_started_at && f.task(id2).omc_started_at, `omc_started_at after the starts: ${js({ a: f.task(id1).omc_started_at, b: f.task(id2).omc_started_at })}`);
    // (b) a start lock with a dead pid: taken over at once (no waiting)
    const dead = deadPid();
    check(!alive(dead), `a dead pid is alive: ${dead}`);
    const lockDir = join(f.state, 'locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `start-${createHash('sha1').update(realpathSync(f.cwd)).digest('hex')}.lock`), js({ pid: dead, ts: Date.now() }));
    const rB = await f.start(['Test a dead start lock']);
    check(rB.status === 0 && /^[0-9a-f]{8}$/.test(rB.id), `start b: ${js(rB.stdout)}`);
    check(await waitFor(() => (f.task(rB.id) || {}).start_exit_code === 0), `start_exit_code b: ${js(f.task(rB.id))}`);
    check(f.task(rB.id).omc_started_at, js(f.task(rB.id)));
  }, 60000);

  // The evaluation of a missing OMC task by the real result module: the start-lock queue, the grace period from omc_started_at, a dead _start, the queue ceiling.
  const withModule = { OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE };

  it('(T1) queue: a start 70 s ago, a live start_pid without omc_started_at -> status pending; result in_progress without a write', async () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const peer = livePeer();
    try {
      const start = new Date(Date.now() - 70_000).toISOString();
      f.put('f0000001', { id: 'f0000001', team: 'ptask-f0000001-x', start, cwd: f.cwd, start_pid: peer.pid, start_pid_starttime: startTimeOf(peer.pid) });
      const rs = f.run(['status', 'f0000001'], empty, withModule);
      check(rs.status === 0 && JSON.parse(rs.stdout).status === 'pending', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
      const rr = f.run(['result', 'f0000001'], empty, withModule);
      const wr = JSON.parse(rr.stdout);
      check(rr.status === 0 && wr.status === 'in_progress' && wr.handoff === false, js(wr));
      check(!f.task('f0000001').verdict, 'result wrote a verdict in the queue');
    } finally { try { peer.kill(); } catch { /* already dead */ } }
  }, 60000);

  it('(T2) omc_started_at 61 s ago (no start_pid) -> status start_failed, result writes start_failed/environment with the error as before', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const now = Date.now();
    f.put('f0000002', { id: 'f0000002', team: 'ptask-f0000002-x', start: new Date(now - 70_000).toISOString(), cwd: f.cwd, omc_started_at: new Date(now - 61_000).toISOString() });
    const rs = f.run(['status', 'f0000002'], empty, withModule);
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'start_failed', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    const rr = f.run(['result', 'f0000002'], empty, withModule);
    const wr = JSON.parse(rr.stdout);
    check(rr.status === 0 && wr.status === 'start_failed' && wr.cause === 'environment' && wr.handoff === true, js(wr));
    check(js(wr.errors) === js(['OMC task ptask-f0000002 not found in team ptask-f0000002-x']), js(wr.errors));
    const d = f.task('f0000002');
    check(d.verdict && d.verdict.status === 'start_failed', js(d.verdict));
  });

  it('(T3) the grace period counts from omc_started_at: omc_started_at 30 s ago with a start 200 s ago -> status pending and result in_progress (before it was start_failed)', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const now = Date.now();
    f.put('f0000003', { id: 'f0000003', team: 'ptask-f0000003-x', start: new Date(now - 200_000).toISOString(), cwd: f.cwd, omc_started_at: new Date(now - 30_000).toISOString() });
    const rs = f.run(['status', 'f0000003'], empty, withModule);
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'pending', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    const rr = f.run(['result', 'f0000003'], empty, withModule);
    const wr = JSON.parse(rr.stdout);
    check(rr.status === 0 && wr.status === 'in_progress' && wr.handoff === false, js(wr));
    check(!f.task('f0000003').verdict, 'result wrote a verdict in the grace period');
  });

  it('(T4) a dead _start: the start_pid of an ended process, a start 5 s ago -> start_failed at once in status and result (no grace period)', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const dead = deadPid();
    check(!alive(dead), `a dead pid is alive: ${dead}`);
    f.put('f0000004', { id: 'f0000004', team: 'ptask-f0000004-x', start: new Date(Date.now() - 5_000).toISOString(), cwd: f.cwd, start_pid: dead, start_pid_starttime: 1 });
    const rs = f.run(['status', 'f0000004'], empty, withModule);
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'start_failed', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    const rr = f.run(['result', 'f0000004'], empty, withModule);
    const wr = JSON.parse(rr.stdout);
    check(rr.status === 0 && wr.status === 'start_failed' && wr.cause === 'environment', js(wr));
    check((wr.errors || []).some((b) => b.includes('the _start process exited before it launched provider-team')), js(wr.errors));
    check(f.task('f0000004').verdict, 'result did not write the verdict of a dead _start');
  });

  it('(T5) a live start_pid whose start_pid_starttime differs from the /proc start time -> the process is treated as dead (start_failed)', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const peer = livePeer();
    try {
      f.put('f0000005', { id: 'f0000005', team: 'ptask-f0000005-x', start: new Date(Date.now() - 5_000).toISOString(), cwd: f.cwd, start_pid: peer.pid, start_pid_starttime: (startTimeOf(peer.pid) ?? 0) + 1 });
      const rs = f.run(['status', 'f0000005'], empty, withModule);
      check(rs.status === 0 && JSON.parse(rs.stdout).status === 'start_failed', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    } finally { try { peer.kill(); } catch { /* already dead */ } }
  });

  it('(T6) a file without start_pid and omc_started_at (from before they existed, or the moment between the write and the pid): 59 s gives pending, 61 s start_failed (as before)', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const t = Date.now();
    f.put('f0000006', { id: 'f0000006', team: 'ptask-f0000006-x', start: new Date(t).toISOString(), cwd: f.cwd });
    const rs = f.run(['status', 'f0000006'], empty, { ...withModule, OMC_PROVIDER_TASK_NOW: String(t + 59_000) });
    check(rs.status === 0 && JSON.parse(rs.stdout).status === 'pending', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    const rs2 = f.run(['status', 'f0000006'], empty, { ...withModule, OMC_PROVIDER_TASK_NOW: String(t + 61_000) });
    check(rs2.status === 0 && JSON.parse(rs2.stdout).status === 'start_failed', js({ o: rs2.stdout, e: rs2.stderr.slice(0, 300) }));
  });

  it('(T7) the queue ceiling: a live start_pid without omc_started_at, a start older than the start-lock limit plus 121 s (the default limit 300 s) -> start_failed/environment', () => {
    const f = fixture();
    const empty = f.scenario({ listTasks: { ok: true, data: { count: 0, tasks: [] } } });
    const peer = livePeer();
    try {
      const t = Date.now();
      f.put('f0000007', { id: 'f0000007', team: 'ptask-f0000007-x', start: new Date(t - 421_000).toISOString(), cwd: f.cwd, start_pid: peer.pid, start_pid_starttime: startTimeOf(peer.pid) });
      const rs = f.run(['status', 'f0000007'], empty, { ...withModule, OMC_PROVIDER_TASK_NOW: String(t) });
      const w = JSON.parse(rs.stdout);
      check(rs.status === 0 && w.status === 'start_failed', js({ o: rs.stdout, e: rs.stderr.slice(0, 300) }));
    } finally { try { peer.kill(); } catch { /* already dead */ } }
  });

  it('(T8) start lock: (a) a live owner over the limit -> start_exit_code 1 and start_error "start lock", the fake not started; (b) a fresh owner ends -> takeover and the start (the marker exists), omc_started_at written; (c) a change of the owner restarts the count; (d) an empty lock from 61 s ago -> takeover', async () => {
    const f = fixture();
    const lockDir = join(f.state, 'locks');
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, `start-${createHash('sha1').update(realpathSync(f.cwd)).digest('hex')}.lock`);
    const marker = join(f.dir, 'marker-t8');
    // a fake provider-team that leaves a marker file when it starts (proof of a start in T8); the pid and an ISO date in the marker
    const fakeMarker = join(f.dir, 'team-fake-marker.cjs');
    writeFileSync(fakeMarker, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.MARKER_FILE, String(process.pid) + ' ' + new Date().toISOString());
process.exit(0);
`, { mode: 0o755 });
    const extra = { OMC_PROVIDER_TASK_TEAM_BIN: fakeMarker, MARKER_FILE: marker };
    const cleanup = () => { try { unlinkSync(lock); } catch { /* none */ } try { unlinkSync(marker); } catch { /* none */ } };
    cleanup();
    // (a) a live owner holding the lock over the limit of 1500 ms: _start gives up with start_exit_code 1, the fake not started.
    const peerA = livePeer();
    try {
      writeFileSync(lock, js({ pid: peerA.pid, ts: Date.now() - 2500 }));
      const r = await f.start(['Test a lock over the limit'], undefined, { ...extra, OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS: '1500' });
      check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start a: ${js(r.stdout.slice(0, 200))}, err ${r.stderr.slice(0, 200)}`);
      check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 1, 20000), `start_exit_code a: ${js(f.task(r.id))}`);
      const z = f.task(r.id);
      check(z.start_exit_code === 1 && /start lock: process \d+ held the lock for more than 2 s/.test(z.start_error || ''), js(z));
      check(!existsSync(marker), 'the fake started despite a lock over the limit');
    } finally { try { peerA.kill(); } catch { /* already dead */ } cleanup(); }
    // (b) a fresh owner ends after 0.5 s: takeover and the start (the marker exists), omc_started_at written. The owner is a grandchild of a helper process:
    // the parent kills the child (SIGKILL) after 0.5 s, so that no zombie child of this process stays and imitates a live owner of the lock.
    const helperB = spawn(process.execPath, ['-e', `const cp=require('node:child_process');
const b=cp.spawn(process.execPath, ['-e','setInterval(()=>{}, 100)'], { stdio:'ignore' });
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: b.pid, ts: Date.now() }));
setTimeout(()=>{ try { b.kill('SIGKILL'); } catch {} }, 500);
setTimeout(()=>process.exit(0), 1500);`], { stdio: 'ignore' });
    try {
      const r = await f.start(['Test a lock takeover'], undefined, { ...extra, OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS: '1500' });
      check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start b: ${js(r.stdout.slice(0, 200))}`);
      check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0 && existsSync(marker), 20000), `start_exit_code b: ${js(f.task(r.id))}, marker ${existsSync(marker)}`);
      const z = f.task(r.id);
      check(z.omc_started_at && Number.isFinite(Date.parse(z.omc_started_at)), js(z));
    } finally { try { helperB.kill(); } catch { /* already dead */ } cleanup(); }
    // (c) two consecutive owners of about 1 s each with a limit of 1500 ms: the third _start waits more than 1.5 s in total and starts
    // (a change of the owner restarts the count), without the start lock failing.
    const orchestrator = spawn(process.execPath, ['-e', `const fs=require('node:fs'),cp=require('node:child_process');
const lock=${JSON.stringify(lock)};
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
const b=cp.spawn(process.execPath, ['-e','setInterval(()=>{}, 100)'], { stdio:'ignore' });
setTimeout(()=>{ fs.writeFileSync(lock, JSON.stringify({ pid: b.pid, ts: Date.now() })); }, 1000);
setTimeout(()=>{ try { b.kill(); } catch {} }, 2000);
setTimeout(()=>{ try { fs.unlinkSync(lock); } catch {} }, 2400);
setTimeout(()=>process.exit(0), 3200);`], { stdio: 'ignore' });
    try {
      const startedAt = Date.now();
      const r = await f.start(['Test the count restart'], undefined, { ...extra, OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS: '1500' });
      check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start c: ${js(r.stdout.slice(0, 200))}`);
      check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0 && existsSync(marker), 25000), `start_exit_code c: ${js(f.task(r.id))}, marker ${existsSync(marker)}`);
      const z = f.task(r.id);
      check(z.start_exit_code === 0 && !z.start_error, js(z));
      const waited = Date.parse(z.omc_started_at) - startedAt;
      check(waited >= 1400, `_start started too early (${waited} ms); the count was not restarted by the change of the owner`);
    } finally { try { orchestrator.kill(); } catch { /* already dead */ } cleanup(); }
    // (d) an empty lock file with an mtime of 61 s ago: takeover (the unreadable-content age rule).
    writeFileSync(lock, '');
    const longAgo = new Date(Date.now() - 61_000);
    utimesSync(lock, longAgo, longAgo);
    const rD = await f.start(['Test an empty old lock'], undefined, extra);
    check(rD.status === 0 && /^[0-9a-f]{8}$/.test(rD.id), `start d: ${js(rD.stdout.slice(0, 200))}`);
    check(await waitFor(() => (f.task(rD.id) || {}).start_exit_code === 0 && existsSync(marker), 20000), `start_exit_code d: ${js(f.task(rD.id))}`);
    cleanup();
  }, 120000);

  // A launcher queued on the start lock has no team yet, so `kill` shuts down nothing; after killed (or a verdict written by `result`) is recorded,
  // the launcher must not start the team when it takes the lock (quota and the worktree would be used by a task already reported as ended).
  const queuedLauncher = async (f, text, extraEnv = {}) => {
    const lockDir = join(f.state, 'locks');
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, `start-${createHash('sha1').update(realpathSync(f.cwd)).digest('hex')}.lock`);
    const marker = join(f.dir, 'marker-queued');
    const fakeMarker = join(f.dir, 'team-fake-marker.cjs');
    writeFileSync(fakeMarker, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.MARKER_FILE, String(process.pid));
process.exit(0);
`, { mode: 0o755 });
    const peer = livePeer();
    writeFileSync(lock, js({ pid: peer.pid, ts: Date.now() }));
    const r = await f.start([text], undefined, { OMC_PROVIDER_TASK_TEAM_BIN: fakeMarker, MARKER_FILE: marker, ...extraEnv });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout.slice(0, 200))}, err ${r.stderr.slice(0, 200)}`);
    check(await waitFor(() => (f.task(r.id) || {}).queue_ts, 15000), `the launcher did not queue: ${js(f.task(r.id))}`);
    const release = () => { try { peer.kill('SIGKILL'); } catch { /* already dead */ } try { unlinkSync(lock); } catch { /* none */ } };
    return { id: r.id, marker, lock, release };
  };
  it('(T11) a launcher queued on the start lock does not start the team after `kill`: the task stays killed, the launcher cancels and releases the lock', async () => {
    const f = fixture();
    const q = await queuedLauncher(f, 'Test a queued launcher after a kill');
    try {
      const k = f.run(['kill', q.id], f.scenario({}));
      check(k.status === 0 && f.task(q.id).killed && f.shutdowns().length === 1, js({ s: k.status, z: f.task(q.id), c: f.omcCalls() }));
      q.release();
      check(await waitFor(() => (f.task(q.id) || {}).start_error === 'cancelled before the team was started', 20000), `the launcher did not cancel: ${js(f.task(q.id))}`);
      // the launcher writes start_error first and removes the start lock right after it, so the release is awaited, not assumed
      check(await waitFor(() => !existsSync(q.lock), 5000), `the start lock was not released: ${js(f.task(q.id))}`);
      check(!existsSync(q.marker) && !existsSync(q.lock), `marker ${existsSync(q.marker)}, lock ${existsSync(q.lock)}`);
      check(JSON.parse(f.run(['status', q.id], f.scenario({})).stdout).status === 'killed', 'status killed');
    } finally { q.release(); }
  }, 120000);
  it('(T13) a launcher queued on the start lock does not start the team after a verdict is written to its task file: the task stays failed, not killed, the launcher cancels and releases the lock', async () => {
    const f = fixture();
    const q = await queuedLauncher(f, 'Test a queued launcher after a verdict');
    try {
      // a verdict written straight into the task file (the same shape a verdict of `result` has), no `killed` field
      const p = join(f.tasks, `${q.id}.json`);
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.verdict = { status: 'failed', cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, handoff: false, errors: [] };
      d.verdict_ts = new Date().toISOString();
      writeFileSync(p, JSON.stringify(d, null, 2));
      q.release();
      check(await waitFor(() => (f.task(q.id) || {}).start_error === 'cancelled before the team was started', 20000), `the launcher did not cancel: ${js(f.task(q.id))}`);
      const z = f.task(q.id);
      check(z.verdict && z.verdict.status === 'failed' && !z.killed, js(z));
      // the launcher writes start_error first and removes the start lock right after it, so the release is awaited, not assumed
      check(await waitFor(() => !existsSync(q.lock), 5000), `the start lock was not released: ${js(f.task(q.id))}`);
      check(!existsSync(q.marker) && !existsSync(q.lock), `marker ${existsSync(q.marker)}, lock ${existsSync(q.lock)}`);
      check((z.omc_started_at ?? null) === null, js(z));
      const out = JSON.parse(f.run(['status', q.id], f.scenario({})).stdout);
      check(out.status === 'failed' && !/killed/.test(js(out)), `status after the verdict: ${js(out)}`);
    } finally { q.release(); }
  }, 120000);
  it('(T12) the cancellation check of a queued launcher does not fail open: with the task file lock busy past the lock limit the check cannot run under the lock, and the launcher still sees killed in the file (read without the lock), cancels, releases the start lock and starts no team', async () => {
    const f = fixture();
    const q = await queuedLauncher(f, 'Test a queued launcher with a busy task file lock', { OMC_PROVIDER_TASK_LOCK_LIMIT_MS: '1000' });
    const holder = livePeer();
    const taskLock = join(f.tasks, `${q.id}.json.lock`);
    try {
      const k = f.run(['kill', q.id], f.scenario({}));
      check(k.status === 0 && f.task(q.id).killed, js({ s: k.status, z: f.task(q.id) }));
      writeFileSync(taskLock, js({ pid: holder.pid, ts: Date.now() })); // a live owner of the task file lock, fresh for the whole test
      const launcher = f.task(q.id).start_pid;
      check(Number.isInteger(launcher), js(f.task(q.id)));
      q.release();
      check(await waitProcessGone(launcher, 30000), 'the launcher did not end (it neither cancelled nor finished)');
      check(!existsSync(q.marker), 'the team was started although the task was killed');
      check(!existsSync(q.lock), 'the start lock of the cancelled launcher was not released');
      check((f.task(q.id).omc_started_at ?? null) === null, js(f.task(q.id)));
    } finally {
      try { holder.kill('SIGKILL'); } catch { /* already dead */ }
      try { unlinkSync(taskLock); } catch { /* none */ }
      q.release();
    }
  }, 120000);
  it('(T9) start_error null on start_exit_code 0 with a non-empty stderr of provider-team (the stderr stays in <id>.err.log); on a non-zero code the last stderr line as before (L6)', async () => {
    const f = fixture();
    const stderrLine = '[team/tmux-session] worker start submit key sent worker=worker-1 sendStatus=0 stderr=""';
    const r = await f.start(['Test start_error on code 0'], undefined, { FAKE_TEAM_STDERR: stderrLine });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout.slice(0, 200))}`);
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start_exit_code: ${js(f.task(r.id))}`);
    const z = f.task(r.id);
    check(z.start_exit_code === 0 && z.start_error === null, js(z));
    check(readFileSync(join(f.tasks, `${r.id}.err.log`), 'utf8').includes('worker start submit key sent'), 'stderr did not reach <id>.err.log');
  });

  it('(T10) the first result (a completed task, a payload Status: success) has in header "status success" (the header is computed after the verdict is written)', async () => {
    const f = fixture();
    const r = await f.start(['Test the header of the first result']);
    check(r.status === 0 && await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0), `start: ${js(f.task(r.id))}`);
    const id = r.id;
    const scenario = f.scenario({
      listTasks: { ok: true, data: { count: 1, tasks: [{ id: 'task-1', subject: `ptask-${id} Test the header of the first result`, status: 'completed', owner: 'worker-1' }] } },
      readTask: { 'task-1': { id: 'task-1', status: 'completed', owner: 'worker-1', result: 'Summary: test of the header.\nStatus: success' } },
    });
    const rr = f.run(['result', id], scenario, { OMC_PROVIDER_TASK_RESULT_MODULE: RESULT_MODULE, OMC_PROVIDER_TASK_LOG_MODULE: LOG_MODULE });
    check(rr.status === 0, `result exit code ${rr.status}, err ${rr.stderr.slice(0, 300)}`);
    const w = JSON.parse(rr.stdout);
    check(w.status === 'success' && typeof w.header === 'string' && w.header.includes('status success'), js(w));
  });

  it('(T12) start: the task file has start_pid and start_pid_starttime consistent with /proc, and after _start ends also omc_started_at', async () => {
    const f = fixture();
    const stop = join(f.dir, 'stop-t12');
    const r = await f.start(['Test start_pid'], undefined, { FAKE_TEAM_STOP: stop, FAKE_TEAM_WAIT_MS: '20000' });
    check(r.status === 0 && /^[0-9a-f]{8}$/.test(r.id), `start: ${js(r.stdout.slice(0, 200))}`);
    check(await waitFor(() => Number.isInteger((f.task(r.id) || {}).start_pid) && (f.task(r.id) || {}).omc_started_at, 15000), `start_pid/omc_started_at: ${js(f.task(r.id))}`);
    const z = f.task(r.id);
    check(z.start_pid_starttime === startTimeOf(z.start_pid), `start_pid_starttime: ${js({ w: z.start_pid_starttime, real: startTimeOf(z.start_pid) })}`);
    check(alive(z.start_pid), `the _start process dead before the stop: ${z.start_pid}`);
    writeFileSync(stop, 'x\n'); // the end of the fake provider-team; _start records start_exit_code
    check(await waitFor(() => (f.task(r.id) || {}).start_exit_code === 0, 20000), `start_exit_code: ${js(f.task(r.id))}`);
  }, 60000);

  it('without a profile, and from a provider session, nothing starts: start in a process with OMC_PROVIDER or a foreign ANTHROPIC_BASE_URL exits with code 2 and writes no task file; no profile: exit code 2', async () => {
    const f = fixture();
    const a = await f.start(['Test the refusal'], undefined, { OMC_PROVIDER: 'acme' });
    check(a.status === 2 && /does not start a team/.test(a.stderr), js({ s: a.status, e: a.stderr.slice(0, 200) }));
    const b = await f.start(['Test the refusal'], undefined, { ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic' });
    check(b.status === 2 && /does not start a team/.test(b.stderr), js({ s: b.status, e: b.stderr.slice(0, 200) }));
    check(!existsSync(f.tasks) || readdirSync(f.tasks).length === 0, 'a task file exists after the refusal');
    const c = spawnSync(process.execPath, [TASK, 'list'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.home, OMC_PROVIDER_PROFILES_FILE: join(f.dir, 'no-such-profiles.jsonc') } });
    check(c.status === 2 && /no provider profiles file/.test(c.stderr), js({ s: c.status, e: c.stderr.slice(0, 200) }));
  });
});
