/**
 * The launcher of background sessions (scripts/jev-session.mjs), with a fake Jev server (HTTP) and a fake starter (a script that writes its argv).
 * Acceptance: (A) every start in shadow mode has a decision row in sessions.jsonl and a query row in shadow.jsonl (point session-routing) and
 * starts the session without --model and --effort; (B) a Jev failure (500, no answer in time, no key, a closed port, an empty answer) starts the
 * session with the default model and a `degraded` row; (G) the start directory chain --cwd, CLAUDE_PROJECT_DIR, CLAUDE_PID, the process directory,
 * and the trust check before the start (untrusted: exit 2 with the --cwd advice, no starter, no row); (C) active mode passes --model and --effort
 * from Jev's answer, the effort cap, the `use` marker, no fable; (D) the role goes through the --settings file with an env block; (J) resume.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import { clearTimeout, setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { successorUseLine } from '../../scripts/lib/jev-handoff.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'jev-session.mjs');
const SLOW = 180_000;
const CLEANUPS = [];
afterAll(() => {
  for (const path of CLEANUPS.splice(0)) rmSync(path, { recursive: true, force: true });
});
function tempDir(prefix = 'jev-session-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CLEANUPS.push(dir);
  return dir;
}

const js = (value) => JSON.stringify(value);

describe('launcher of background sessions', () => {
  let tmp;
  let home;
  let project;
  let logsRoot;
  let starter;
  let sessionCounter;
  let argvFile;
  let briefFile;
  let server;
  let port;
  let received;
  let handler;
  let counter = 0;

  beforeAll(async () => {
    tmp = tempDir();
    home = join(tmp, 'home');
    project = join(tmp, 'project');
    logsRoot = join(tmp, 'logs');
    starter = join(tmp, 'starter.mjs');
    sessionCounter = join(tmp, 'session-counter.mjs');
    argvFile = join(tmp, 'argv');
    briefFile = join(tmp, 'brief.md');
    for (const dir of [home, join(home, '.claude'), project, logsRoot]) mkdirSync(dir, { recursive: true });
    // The fake starter writes its argv (JSON) to FAKE_ARGV and its working directory to FAKE_ARGV.cwd, and pretends to be `claude --bg`.
    writeFileSync(starter, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv));
writeFileSync(process.env.FAKE_ARGV + '.cwd', process.cwd());
if (process.env.FAKE_START === 'flags' && argv.includes('--model')) { console.error('error: unknown model combination'); process.exit(1); }
if (process.env.FAKE_START === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
if (process.env.FAKE_START === 'trust') { console.error('Workspace not trusted. Run \`claude\` in ' + process.cwd() + ' once and accept the trust prompt, then retry.'); process.exit(1); }
const name = argv[argv.indexOf('--name') + 1] ?? '';
console.log('backgrounded · ab12cd34 · ' + name);
`);
    chmodSync(starter, 0o755);
    // The fake session counter of the pool gate: prints a JSON array of FAKE_SESSIONS_FILE sessions (pid null counts).
    writeFileSync(sessionCounter, `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
const file = process.env.FAKE_SESSIONS_FILE;
const n = file && existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
console.log(JSON.stringify(Array.from({ length: n }, () => ({ pid: null }))));
`);
    chmodSync(sessionCounter, 0o755);
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        received.push({ url: request.url, body });
        const result = handler(body);
        if (result === 'hang') return; // no answer: the resolver must give up after its time limit
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
        response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Answers by question name, in the reverse order of the questions (an answer taken by position would be caught).
  function answerFor(body, answers = {}) {
    const result = {};
    for (const name of Object.keys(body?.questions || {}).reverse()) {
      const question = body.questions[name];
      if (answers[name] !== undefined) result[name] = { type: question.type, ...answers[name] };
      else if (question.type === 'noul') result[name] = { type: 'noul', noul: 0.1 };
      else if (question.type === 'choice') result[name] = { type: 'choice', choice: Object.keys(question.criteria || {})[0], confidence: 0.9 };
      else result[name] = { type: question.type, score: 1 };
    }
    return { answers: result, usage: { input_tokens: 1, output_tokens: 1 } };
  }

  function launcherEnv({ jev = true, logs, extra = {} } = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|PLUGIN_ROOT$|CODEX|DISABLE_OMC)/i.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), FAKE_ARGV: argvFile, OMC_JEV_QUIET: '1', OMC_JEV_TIMEOUT_MS: '8000', OMC_JEV_SESSION_STARTER: starter });
    if (jev) Object.assign(env, { TYPESAFE_API_KEY: 'test', OMC_JEV_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone` });
    if (logs) env.OMC_JEV_LOG_DIR = logs;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  // The event loop of the test stays free: the synchronous Jev child of the launcher must be able to reach the server of this process.
  function run(argv, env, script = SCRIPT) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...argv], { cwd: project, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('jev-session: timeout')); }, 90_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  const rowsOf = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const readArgv = () => (existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) : null);
  const resetStarter = () => { rmSync(argvFile, { force: true }); rmSync(`${argvFile}.cwd`, { force: true }); };
  const hasFlag = (argv, flag) => argv.includes(flag);
  const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];
  const defaultAnswers = { 'model-tier': { choice: 'opus', confidence: 0.9 }, effort: { score: 3, confidence: 0.8 } };

  // One run of the launcher. Returns the process result, the starter's argv, the last row of sessions.jsonl and the rows of shadow.jsonl of the point.
  async function start({ brief = 'Review the payment module and list the risks.', args = [], jev = true, answers, answerFun, env = {}, role = 'worker' } = {}) {
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    writeFileSync(briefFile, brief);
    received = [];
    handler = answerFun ?? ((body) => ({ body: answerFor(body, answers ?? defaultAnswers) }));
    resetStarter();
    const result = await run(['--role', role, '--brief', briefFile, '--name', 'Test track 1', '--coordinator', 'd7ec31aa', ...args], launcherEnv({ jev, logs, extra: env }));
    const sessions = rowsOf(logs, 'sessions.jsonl');
    return {
      result, argv: readArgv(), row: sessions.at(-1), rows: sessions.length,
      shadow: rowsOf(logs, 'shadow.jsonl').filter((row) => row.point === 'session-routing'),
      queries: received.filter((entry) => entry.body?.questions), logs,
    };
  }

  // --- A: shadow, 10 of 10 ---
  it('(A) 10 of 10 starts in shadow: a decision row in sessions.jsonl, a session-routing row in shadow.jsonl, a start without --model and --effort, exit 0', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await start();
      assert.equal(r.result.code, 0, `start ${i}: exit ${r.result.code}: ${r.result.stderr.slice(0, 300)}`);
      assert.ok(r.rows === 1 && r.row.mode === 'shadow' && r.row.result === 'decided', `start ${i}: row ${js(r.row)}`);
      assert.ok(r.row.model?.to === 'opus' && r.row.model.source === 'jev' && r.row.effort?.to === 'xhigh' && r.row.effort.score === 3, `start ${i}: decision ${js(r.row)}`);
      assert.ok(r.row.started_with.model === null && r.row.started_with.effort === null, `start ${i}: started_with ${js(r.row.started_with)}`);
      assert.ok(r.shadow.length === 1 && r.shadow[0].answers, `start ${i}: shadow row ${js(r.shadow)}`);
      assert.ok(r.argv && !hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort') && hasFlag(r.argv, '--bg') && valueOf(r.argv, '--name') === 'Test track 1', `start ${i}: argv ${js(r.argv)}`);
      assert.equal(r.row.session_id, 'ab12cd34', `start ${i}: session_id ${r.row.session_id}`);
    }
  }, SLOW);

  it('(A2) the query carries the same questions as model-routing (model-tier + effort), the state has the task of the brief, no ids and no project path', async () => {
    const r = await start();
    assert.equal(r.queries.length, 1, `queries ${r.queries.length}`);
    const body = r.queries[0].body;
    assert.equal(js(Object.keys(body.questions).sort()), js(['effort', 'model-tier']));
    assert.ok(body.state.tool_name === 'SessionLauncher' && body.state.subagent_type === 'session-worker' && body.state.task.includes('payment module') && body.state.description === 'Test track 1', js(body.state).slice(0, 300));
    assert.ok(!js(body).includes(project) && !js(body).includes('d7ec31aa'), 'the query carries the project path or the coordinator id');
  }, SLOW);

  it('(D) the role goes through the --settings file with an env block (OMC_SESSION_ROLE, OMC_SESSION_COORDINATOR, OMC_SESSION_NAME); the file is in the durable log directory, not in tmp', async () => {
    const r = await start({ role: 'coordinator' });
    const file = valueOf(r.argv, '--settings');
    assert.ok(file && file.startsWith(join(r.logs, 'session-settings')), `settings path: ${file}`);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(js(settings), js({ env: { OMC_SESSION_ROLE: 'coordinator', OMC_SESSION_NAME: 'Test track 1', OMC_SESSION_COORDINATOR: 'd7ec31aa' } }));
    assert.ok(r.argv.at(-1).startsWith('Read ') && r.argv.at(-1).endsWith(' and carry it out.'), `prompt: ${r.argv.at(-1)}`);
    assert.ok(!/ultragoal|ralph|autopilot|ultrawork|ralplan/i.test(js(r.argv)), 'a keyword in the command');
  }, SLOW);

  // --- B: Jev failures ---
  it('(B1) Jev 500: a start with the default model (no --model and --effort), a degraded row, exit 0', async () => {
    const r = await start({ answerFun: () => ({ status: 500, body: { error: 'x' } }), args: ['--mode', 'active'] });
    assert.ok(r.result.code === 0 && r.row.result === 'degraded' && r.argv && !hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort'), js({ code: r.result.code, row: r.row, argv: r.argv }));
    assert.equal(r.row.started_with.model, null, js(r.row));
  }, SLOW);
  it('(B2) Jev does not answer in time (OMC_JEV_TIMEOUT_MS=700): a start without flags, degraded', async () => {
    const r = await start({ answerFun: () => 'hang', args: ['--mode', 'active'], env: { OMC_JEV_TIMEOUT_MS: '700' } });
    assert.ok(r.result.code === 0 && r.row.result === 'degraded' && !hasFlag(r.argv, '--model'), js({ code: r.result.code, row: r.row }));
  }, SLOW);
  it('(B3) no Jev key: a start without flags, degraded', async () => {
    const r = await start({ jev: false, args: ['--mode', 'active'] });
    assert.ok(r.result.code === 0 && r.row.result === 'degraded' && !hasFlag(r.argv, '--model') && r.queries.length === 0, js({ code: r.result.code, row: r.row }));
  }, SLOW);
  it('(B4) the Jev port is closed: a start without flags, degraded', async () => {
    const r = await start({ args: ['--mode', 'active'], env: { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1/v1/systemone' } });
    assert.ok(r.result.code === 0 && r.row.result === 'degraded' && !hasFlag(r.argv, '--model'), js({ code: r.result.code, row: r.row }));
  }, SLOW);
  it('(B5) an answer with no usable fields (score -1, no choice): degraded with the reason no-usable-answer, a start without flags', async () => {
    const r = await start({ answers: { 'model-tier': {}, effort: { score: -1 } }, args: ['--mode', 'active'] });
    assert.ok(r.result.code === 0 && r.row.result === 'degraded' && r.row.reason === 'no-usable-answer' && !hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort'), js({ row: r.row, argv: r.argv }));
  }, SLOW);
  it('(B6) in shadow a Jev failure also ends with a start and a degraded row', async () => {
    const r = await start({ answerFun: () => ({ status: 500, body: {} }) });
    assert.ok(r.result.code === 0 && r.row.mode === 'shadow' && r.row.result === 'degraded', js(r.row));
  }, SLOW);

  // --- C: active ---
  it('(C1) active: --model and --effort from Jev (opus, score 3 = xhigh), the started_with row agrees with the argv', async () => {
    const r = await start({ args: ['--mode', 'active'] });
    assert.ok(valueOf(r.argv, '--model') === 'opus' && valueOf(r.argv, '--effort') === 'xhigh', js(r.argv));
    assert.ok(r.row.started_with.model === 'opus' && r.row.started_with.effort === 'xhigh' && r.row.mode === 'active', js(r.row));
  }, SLOW);
  it('(C2) active: the mode from OMC_JEV=session-routing:active and from OMC_JEV_SESSION_MODE; a bad value does not turn active on; session-routing:off without a query; `all:active` alone is not enough', async () => {
    let r = await start({ env: { OMC_JEV: 'all:active,session-routing:active' } });
    assert.ok(r.row.mode === 'active' && hasFlag(r.argv, '--model'), js(r.row));
    r = await start({ env: { OMC_JEV_SESSION_MODE: 'active' } });
    assert.equal(r.row.mode, 'active', js(r.row));
    r = await start({ env: { OMC_JEV_SESSION_MODE: 'yes' } });
    assert.ok(r.row.mode === 'shadow' && !hasFlag(r.argv, '--model'), js(r.row));
    r = await start({ env: { OMC_JEV: 'all:active,session-routing:off' } });
    assert.ok(r.row.mode === 'off' && r.row.result === 'off' && r.queries.length === 0 && r.shadow.length === 0 && !hasFlag(r.argv, '--model'), js({ row: r.row, queries: r.queries.length }));
    r = await start({ env: { OMC_JEV: 'all:active' } });
    assert.ok(r.row.mode === 'shadow' && !hasFlag(r.argv, '--model'), js(r.row));
  }, SLOW);
  it('(C3) the effort scale: scores 0, 0.5, 0.51, 1.5, 2.5, 3.49, 3.5, 4 give low, low, medium, high, high, xhigh, max, max (the cap is max by default); the model choice haiku/sonnet/opus', async () => {
    const expected = [[0, 'low'], [0.5, 'low'], [0.51, 'medium'], [1.5, 'high'], [2.5, 'high'], [3.49, 'xhigh'], [3.5, 'max'], [4, 'max']];
    for (const [score, effort] of expected) {
      const r = await start({ answers: { 'model-tier': { choice: 'haiku', confidence: 0.9 }, effort: { score, confidence: 0.9 } }, args: ['--mode', 'active'] });
      assert.ok(valueOf(r.argv, '--effort') === effort && valueOf(r.argv, '--model') === 'haiku', `score ${score}: ${js(r.argv)}`);
    }
    for (const model of ['haiku', 'sonnet', 'opus']) {
      const r = await start({ answers: { 'model-tier': { choice: model, confidence: 0.9 }, effort: { score: 1 } }, args: ['--mode', 'active'] });
      assert.equal(valueOf(r.argv, '--model'), model, `${model}: ${js(r.argv)}`);
    }
  }, SLOW);
  it('(C4) the cap OMC_JEV_MAX_EFFORT=high lowers the effort from Jev (score 4 gives high); a bad cap value means max', async () => {
    let r = await start({ answers: { 'model-tier': { choice: 'opus' }, effort: { score: 4 } }, args: ['--mode', 'active'], env: { OMC_JEV_MAX_EFFORT: 'high' } });
    assert.equal(valueOf(r.argv, '--effort'), 'high', js(r.argv));
    r = await start({ answers: { 'model-tier': { choice: 'opus' }, effort: { score: 4 } }, args: ['--mode', 'active'], env: { OMC_JEV_MAX_EFFORT: 'nonsense' } });
    assert.equal(valueOf(r.argv, '--effort'), 'max', js(r.argv));
  }, SLOW);
  it('(C5) Jev does not choose fable: the answer fable gives no --model, the effort from Jev stays', async () => {
    const r = await start({ answers: { 'model-tier': { choice: 'fable' }, effort: { score: 2 } }, args: ['--mode', 'active'] });
    assert.ok(!hasFlag(r.argv, '--model') && valueOf(r.argv, '--effort') === 'high', js(r.argv));
  }, SLOW);
  it('(C6) the marker `use opus high` on the first line of the brief: no query to Jev, --model opus --effort high, the row source marker', async () => {
    const r = await start({ brief: 'use opus high\n\nTask.', args: ['--mode', 'active'] });
    assert.ok(valueOf(r.argv, '--model') === 'opus' && valueOf(r.argv, '--effort') === 'high' && r.queries.length === 0, js({ argv: r.argv, queries: r.queries.length }));
    assert.ok(r.row.model.source === 'marker' && r.row.effort.source === 'marker' && r.row.marker === 'use opus high', js(r.row));
  }, SLOW);
  it('(C7) the marker `use sonnet`: Jev is asked about the effort only, the model from the marker; `use xhigh`: the model from Jev, the effort from the marker', async () => {
    let r = await start({ brief: 'use sonnet\n\nTask.', args: ['--mode', 'active'] });
    assert.ok(js(Object.keys(r.queries[0].body.questions)) === js(['effort']) && valueOf(r.argv, '--model') === 'sonnet' && valueOf(r.argv, '--effort') === 'xhigh', js({ q: r.queries.map((q) => Object.keys(q.body.questions)), argv: r.argv }));
    r = await start({ brief: 'use xhigh\n\nTask.', args: ['--mode', 'active'] });
    assert.ok(valueOf(r.argv, '--model') === 'opus' && valueOf(r.argv, '--effort') === 'xhigh', js(r.argv));
  }, SLOW);
  it('(C8) the marker `use fable` is refused (refused fable-not-for-sessions), `use max` sets nothing and the effort comes from Jev; the cap lowers the effort of the marker', async () => {
    let r = await start({ brief: 'use fable high\n\nTask.', args: ['--mode', 'active'] });
    assert.ok(valueOf(r.argv, '--model') === 'opus' && r.row.refused === 'fable-not-for-sessions' && valueOf(r.argv, '--effort') === 'high', js({ argv: r.argv, row: r.row }));
    r = await start({ brief: 'use max\n\nTask.', args: ['--mode', 'active'] });
    assert.ok(valueOf(r.argv, '--effort') === 'xhigh' && r.row.refused === 'max', js({ argv: r.argv, row: r.row }));
    r = await start({ brief: 'use sonnet xhigh\n\nTask.', args: ['--mode', 'active'], env: { OMC_JEV_MAX_EFFORT: 'medium' } });
    assert.ok(valueOf(r.argv, '--effort') === 'medium' && r.row.capped?.requested === 'xhigh', js({ argv: r.argv, row: r.row }));
  }, SLOW);
  it('(C9) the marker `use haiku low` in shadow: it goes to the start (the user\'s choice, not Jev\'s), the started_with row agrees', async () => {
    const r = await start({ brief: 'use haiku low\n\nTask.' });
    assert.ok(valueOf(r.argv, '--model') === 'haiku' && valueOf(r.argv, '--effort') === 'low' && r.row.marker === 'use haiku low' && r.row.started_with.model === 'haiku', js({ argv: r.argv, row: r.row }));
    const r2 = await start({ brief: 'use sonnet\n\nTask.' });
    assert.ok(valueOf(r2.argv, '--model') === 'sonnet' && !hasFlag(r2.argv, '--effort'), js(r2.argv));
  }, SLOW);
  it('(C10) OMC_JEV_MODEL_ROUTING_HINTS=1 adds the same hints to the questions as in the Agent hook', async () => {
    const plain = await start();
    const hinted = await start({ env: { OMC_JEV_MODEL_ROUTING_HINTS: '1' } });
    const effort = (r) => r.queries[0].body.questions.effort.instructions;
    assert.ok(effort(hinted).length > effort(plain).length && effort(hinted).startsWith(effort(plain)), 'the hint sentences are not appended to the effort question');
    assert.ok(!('fable' in (hinted.queries[0].body.questions['model-tier'].criteria ?? {})), 'fable in the questions of a session');
  }, SLOW);

  // --- F: modes, arguments, settings files ---
  it('(F1) the global OMC_JEV=off switches the launcher off for good (no query, also with --mode active), a start without flags', async () => {
    for (const args of [[], ['--mode', 'active']]) {
      const r = await start({ env: { OMC_JEV: 'off' }, args });
      assert.ok(r.row.mode === 'off' && r.row.result === 'off' && r.queries.length === 0 && r.shadow.length === 0 && !hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort'), js({ args, row: r.row, queries: r.queries.length }));
    }
  }, SLOW);
  it('(F2) the marker in off mode and at a Jev failure: the user\'s choice goes to the start; Jev\'s values do not', async () => {
    let r = await start({ brief: 'use opus high\n\nTask.', env: { OMC_JEV: 'off' } });
    assert.ok(valueOf(r.argv, '--model') === 'opus' && valueOf(r.argv, '--effort') === 'high' && r.queries.length === 0, js(r.argv));
    r = await start({ brief: 'use sonnet\n\nTask.', answerFun: () => ({ status: 500, body: {} }), args: ['--mode', 'active'] });
    assert.ok(r.row.result === 'degraded' && valueOf(r.argv, '--model') === 'sonnet' && !hasFlag(r.argv, '--effort'), js({ row: r.row, argv: r.argv }));
    r = await start({ brief: 'A task without a marker.', answerFun: () => ({ status: 500, body: {} }), args: ['--mode', 'active'] });
    assert.ok(!hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort'), js(r.argv));
  }, SLOW);
  it('(F3) values of --name and --prompt that start with "-" are refused (exit 2, no starter); an ordinary prompt with a hyphen inside passes', async () => {
    writeFileSync(briefFile, 'Task.');
    for (const [flag, value] of [['--name', '-x'], ['--prompt', '--dangerously-skip-permissions'], ['--prompt', '- do X']]) {
      resetStarter();
      const args = flag === '--name' ? ['--role', 'worker', '--brief', briefFile, '--name', value] : ['--role', 'worker', '--brief', briefFile, '--name', 'x', flag, value];
      const result = await run(args, launcherEnv({ logs: join(logsRoot, 'f3') }));
      assert.ok(result.code === 2 && /must not start with/.test(result.stderr) && !existsSync(argvFile), `${flag} ${value}: ${js({ code: result.code, stderr: result.stderr.slice(0, 200) })}`);
    }
    const r = await start({ args: ['--prompt', 'Do this - quickly'] });
    assert.equal(r.argv.at(-1), 'Do this - quickly', js(r.argv));
  }, SLOW);
  it('(F4) claude refuses the flags of Jev\'s choice (the starter fails at --model): the start is repeated without flags, the row has fallback: true, exit 0', async () => {
    const r = await start({ args: ['--mode', 'active'], env: { FAKE_START: 'flags' } });
    assert.ok(r.result.code === 0 && r.row.fallback === true && r.row.session_id === 'ab12cd34' && !hasFlag(r.argv, '--model') && !hasFlag(r.argv, '--effort') && r.row.started_with.model === null, js({ code: r.result.code, stderr: r.result.stderr.slice(0, 200), row: r.row, argv: r.argv }));
  }, SLOW);
  it('(F5) role settings files: unique names for the same session name, --dry-run creates no file, file mode 600', async () => {
    const logs = join(logsRoot, 'f5');
    mkdirSync(logs, { recursive: true });
    const env = launcherEnv({ logs });
    writeFileSync(briefFile, 'Task.');
    handler = (body) => ({ body: answerFor(body, {}) });
    await Promise.all([1, 2, 3].map(() => run(['--role', 'worker', '--brief', briefFile, '--name', 'the same'], env)));
    const dir = join(logs, 'session-settings');
    const files = readdirSync(dir);
    assert.ok(files.length === 3 && new Set(files).size === 3, js(files));
    assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600, 'file mode');
    await run(['--role', 'worker', '--brief', briefFile, '--name', 'dry', '--dry-run'], env);
    assert.equal(readdirSync(dir).length, 3, 'the dry run created a settings file');
  }, SLOW);
  it('(F6) the row of sessions.jsonl never holds the text of the brief or a key (only the brief path)', async () => {
    const r = await start({ brief: 'SECRET-BRIEF-TEXT to check' });
    assert.ok(!js(r.row).includes('SECRET-BRIEF-TEXT'), js(r.row));
  }, SLOW);
  it('(F6b) a key in the start of the brief is masked in the query to Jev', async () => {
    const r = await start({ brief: 'Check the deploy with the key sk-ant-abcdef1234567890ABCD and report.\nAPI_KEY=hunter2hunter2 stays out.' });
    assert.ok(r.queries.length >= 1, js(r.queries));
    const sent = js(r.queries.map((entry) => entry.body));
    assert.ok(!sent.includes('abcdef1234567890ABCD') && !sent.includes('hunter2hunter2'), sent.slice(0, 400));
    assert.ok(sent.includes('sk-ant-***'), sent.slice(0, 400));
  }, SLOW);
  it('(F7) a run through a symbolic link (a wrapper on PATH) works like a direct one; importing the module does not run the launcher', async () => {
    const link = join(tmp, 'jev-session');
    if (!existsSync(link)) symlinkSync(SCRIPT, link);
    const logs = join(logsRoot, 'f7');
    mkdirSync(logs, { recursive: true });
    writeFileSync(briefFile, 'Task.');
    handler = (body) => ({ body: answerFor(body, {}) });
    const result = await run(['--role', 'worker', '--brief', briefFile, '--name', 'link'], launcherEnv({ logs }), link);
    assert.ok(result.code === 0 && rowsOf(logs, 'sessions.jsonl').length === 1, js(result));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${js(SCRIPT)}); console.log('imported')`], { encoding: 'utf8' });
    assert.ok(imported.status === 0 && imported.stdout.trim() === 'imported', js({ status: imported.status, out: imported.stdout, err: imported.stderr.slice(0, 200) }));
  }, SLOW);

  // --- E: the mask and start errors ---
  it('(E2) the starter ends with "Workspace not trusted": a readable message, exit not 0, a row in sessions.jsonl with starter_exit', async () => {
    const r = await start({ env: { FAKE_START: 'trust' } });
    assert.ok(r.result.code !== 0 && /is not trusted/.test(r.result.stderr) && r.row.starter_exit === 1 && r.row.session_id === null, js({ code: r.result.code, stderr: r.result.stderr.slice(0, 300), row: r.row }));
  }, SLOW);
  it('(E3) a missing brief and bad arguments: exit 2 with a message, no starter', async () => {
    resetStarter();
    const env = launcherEnv({ logs: join(logsRoot, 'e3') });
    let result = await run(['--role', 'worker', '--brief', join(tmp, 'missing.md'), '--name', 'x'], env);
    assert.ok(result.code === 2 && /brief/.test(result.stderr) && !existsSync(argvFile), js({ code: result.code, stderr: result.stderr }));
    writeFileSync(briefFile, 'Task.');
    result = await run(['--role', 'executor', '--brief', briefFile, '--name', 'x'], env);
    assert.ok(result.code === 2 && /--role/.test(result.stderr) && !existsSync(argvFile), js({ code: result.code, stderr: result.stderr }));
    result = await run(['--role', 'worker', '--brief', briefFile, '--name', 'x', '--model', 'opus'], env);
    assert.ok(result.code === 2 && /unknown argument/.test(result.stderr), js({ code: result.code, stderr: result.stderr }));
  }, SLOW);
  it('(E4) --dry-run: prints the decision and the command, does not run the starter, writes a dry-run row', async () => {
    const r = await start({ args: ['--dry-run', '--mode', 'active'] });
    assert.ok(r.result.code === 0 && /command: .*--model opus --effort xhigh/.test(r.result.stdout) && r.argv === null && r.row.result === 'dry-run', js({ stdout: r.result.stdout, row: r.row }));
  }, SLOW);
  it('(E5) --cwd: the starter gets the working directory of the argument', async () => {
    const other = join(tmp, 'other-directory');
    mkdirSync(other, { recursive: true });
    await start({ args: ['--cwd', other] });
    assert.equal(readFileSync(`${argvFile}.cwd`, 'utf8').trim(), other);
  }, SLOW);

  // --- G: the default start directory (--cwd, CLAUDE_PROJECT_DIR, CLAUDE_PID, process.cwd) and the trust check ---
  const starterDir = () => realpathSync(readFileSync(`${argvFile}.cwd`, 'utf8').trim());
  const configFile = () => join(home, '.claude', '.claude.json');
  const writeConfig = (content) => writeFileSync(configFile(), typeof content === 'string' ? content : js(content));
  const removeConfig = () => rmSync(configFile(), { recursive: true, force: true });
  const linuxOnly = process.platform === 'linux';
  // A helper process that stands for a Claude Code process: `sleep` started in a directory (Linux: /proc/<pid>/cwd).
  async function withProcess(dir, fn) {
    const child = spawn('sleep', ['120'], { cwd: dir, stdio: 'ignore' });
    try { await new Promise((resolve) => setTimeout(resolve, 100)); return await fn(child.pid); } finally { child.kill(); }
  }

  it.skipIf(!linuxOnly)('(G1) without --cwd the start directory is the directory of the process CLAUDE_PID, not the directory of the call; the row carries cwd_source=CLAUDE_PID', async () => {
    const other = join(tmp, 'session-project');
    mkdirSync(other, { recursive: true });
    await withProcess(other, async (pid) => {
      const r = await start({ env: { CLAUDE_PID: String(pid) } });
      assert.ok(r.result.code === 0 && starterDir() === realpathSync(other), `exit ${r.result.code}, starter directory ${readFileSync(`${argvFile}.cwd`, 'utf8').trim()}, expected ${other}: ${r.result.stderr.slice(0, 200)}`);
      assert.ok(r.row.cwd_source === 'CLAUDE_PID' && /directory=.*\(CLAUDE_PID\)/.test(r.result.stderr), js({ row: r.row, stderr: r.result.stderr.slice(0, 300) }));
    });
  }, SLOW);
  it('(G2) --cwd wins over CLAUDE_PROJECT_DIR and CLAUDE_PID (cwd_source=argument); CLAUDE_PROJECT_DIR wins over CLAUDE_PID (cwd_source=CLAUDE_PROJECT_DIR)', async () => {
    const [a, b, c] = ['dir-a', 'dir-b', 'dir-c'].map((name) => join(tmp, name));
    for (const dir of [a, b, c]) mkdirSync(dir, { recursive: true });
    const check = async (pid) => {
      let r = await start({ args: ['--cwd', a], env: { CLAUDE_PID: String(pid), CLAUDE_PROJECT_DIR: b } });
      assert.ok(starterDir() === realpathSync(a) && r.row.cwd_source === 'argument', js({ dir: starterDir(), row: r.row }));
      r = await start({ env: { CLAUDE_PID: String(pid), CLAUDE_PROJECT_DIR: b } });
      assert.ok(starterDir() === realpathSync(b) && r.row.cwd_source === 'CLAUDE_PROJECT_DIR', js({ dir: starterDir(), row: r.row }));
    };
    if (linuxOnly) await withProcess(c, check);
    else await check(0);
  }, SLOW);
  it('(G3) without CLAUDE_PID, with an invalid CLAUDE_PID (not a number, no such process) and with a missing CLAUDE_PROJECT_DIR: the process directory, cwd_source=process, no error', async () => {
    for (const env of [{}, { CLAUDE_PID: 'abc' }, { CLAUDE_PID: '4194999' }, { CLAUDE_PID: '0' }, { CLAUDE_PROJECT_DIR: join(tmp, 'no-such-directory') }]) {
      const r = await start({ env });
      assert.ok(r.result.code === 0 && starterDir() === realpathSync(project) && r.row.cwd_source === 'process', js({ env, code: r.result.code, dir: starterDir(), source: r.row.cwd_source, stderr: r.result.stderr.slice(0, 200) }));
    }
  }, SLOW);
  // A directory outside any repository, so that its ancestors have no .git
  const newBase = () => tempDir('jev-session-trust-');
  it('(G4) a directory that is not trusted in .claude.json (CLAUDE_CONFIG_DIR): exit 2, the --cwd advice, no starter, no row in sessions.jsonl, no query to Jev', async () => {
    const base = newBase();
    const trusted = join(base, 'trusted');
    const untrusted = join(base, 'untrusted');
    for (const dir of [trusted, untrusted]) mkdirSync(dir, { recursive: true });
    writeConfig({ projects: { [trusted]: { hasTrustDialogAccepted: true }, [join(base, 'other')]: { hasTrustDialogAccepted: false } } });
    try {
      const r = await start({ args: ['--cwd', untrusted] });
      assert.ok(r.result.code === 2 && /is not trusted/.test(r.result.stderr) && /--cwd <a trusted project directory>/.test(r.result.stderr) && r.result.stderr.includes(untrusted) && r.result.stderr.includes('(source: argument)'), js({ code: r.result.code, stderr: r.result.stderr.slice(0, 500) }));
      assert.ok(r.argv === null && r.rows === 0 && r.queries.length === 0, js({ argv: r.argv, rows: r.rows, queries: r.queries.length }));
      const ok = await start({ args: ['--cwd', trusted] });
      assert.ok(ok.result.code === 0 && ok.rows === 1, `trusted: exit ${ok.result.code}: ${ok.result.stderr.slice(0, 200)}`);
    } finally { removeConfig(); }
  }, SLOW);
  it('(G5) a subdirectory (also through nonexistent intermediate levels, a symlink) of a trusted directory is trusted; the trust of a sibling and a false flag are not enough', async () => {
    const base = newBase();
    const trusted = join(base, 'trusted');
    const deep = join(trusted, 'a', 'b', 'c');
    const sibling = join(base, 'trusted-next');
    for (const dir of [deep, sibling]) mkdirSync(dir, { recursive: true });
    const link = join(base, 'link-to-deep');
    symlinkSync(deep, link);
    writeConfig({ projects: { [trusted]: { hasTrustDialogAccepted: true } } });
    try {
      for (const dir of [deep, link]) {
        const r = await start({ args: ['--cwd', dir] });
        assert.equal(r.result.code, 0, `${dir}: exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
      }
      let r = await start({ args: ['--cwd', sibling] });
      assert.equal(r.result.code, 2, `a sibling with a common name prefix: exit ${r.result.code}`);
      writeConfig({ projects: { [trusted]: { hasTrustDialogAccepted: false } } });
      r = await start({ args: ['--cwd', deep] });
      assert.equal(r.result.code, 2, `a false flag: exit ${r.result.code}`);
    } finally { removeConfig(); }
  }, SLOW);
  it('(G6) worktree: the trust of the main repository (a key that is not an ancestor) covers a linked worktree; an unresolvable worktree does not block; without the repository trust exit 2', async () => {
    const base = newBase();
    const main = join(base, 'main');
    const worktree = join(base, 'worktrees', 'w1');
    const gitdir = join(main, '.git', 'worktrees', 'w1');
    for (const dir of [gitdir, worktree]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    const broken = join(base, 'worktrees', 'w2');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '.git'), 'gitdir: /no/such/gitdir\n');
    try {
      writeConfig({ projects: { [main]: { hasTrustDialogAccepted: true } } });
      let r = await start({ args: ['--cwd', worktree] });
      assert.equal(r.result.code, 0, `a worktree of a trusted repository: exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
      r = await start({ args: ['--cwd', broken] });
      assert.equal(r.result.code, 0, `an unresolvable worktree: exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
      writeConfig({ projects: { [join(base, 'foreign')]: { hasTrustDialogAccepted: true } } });
      r = await start({ args: ['--cwd', worktree] });
      assert.equal(r.result.code, 2, `a worktree without the repository trust: exit ${r.result.code}`);
    } finally { removeConfig(); }
  }, SLOW);
  it('(G7) an unreadable or uncertain config does not block: no file, broken JSON, no projects key, an empty file, a directory instead of a file, CLAUDE_CODE_SANDBOXED, CLAUDE_CODE_IGNORE_PERSISTED_TRUST', async () => {
    const base = newBase();
    const dir = join(base, 'project');
    mkdirSync(dir, { recursive: true });
    try {
      for (const [what, content, env] of [['no file', null, {}], ['broken JSON', '{"projects": {', {}], ['no projects', '{"numStartups": 3}', {}], ['an empty file', '', {}], ['projects is not an object', '{"projects": 5}', {}], ['SANDBOXED', '{"projects": {}}', { CLAUDE_CODE_SANDBOXED: '1' }], ['IGNORE_PERSISTED_TRUST', '{"projects": {}}', { CLAUDE_CODE_IGNORE_PERSISTED_TRUST: '1' }]]) {
        removeConfig();
        if (content !== null) writeConfig(content);
        const r = await start({ args: ['--cwd', dir], env });
        assert.ok(r.result.code === 0 && r.rows === 1, `${what}: exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
      }
      removeConfig();
      mkdirSync(configFile(), { recursive: true });
      const r = await start({ args: ['--cwd', dir] });
      assert.equal(r.result.code, 0, `a directory instead of a file: exit ${r.result.code}`);
    } finally { removeConfig(); }
  }, SLOW);
  it('(G8) the directory of the default chain also goes through the trust check: an untrusted CLAUDE_PROJECT_DIR gives exit 2 with the source name in the message', async () => {
    const base = newBase();
    const foreign = join(base, 'foreign');
    mkdirSync(foreign, { recursive: true });
    writeConfig({ projects: { [join(base, 'other')]: { hasTrustDialogAccepted: true } } });
    try {
      const r = await start({ env: { CLAUDE_PROJECT_DIR: foreign } });
      assert.ok(r.result.code === 2 && r.result.stderr.includes('(source: CLAUDE_PROJECT_DIR)'), js({ code: r.result.code, stderr: r.result.stderr.slice(0, 300) }));
    } finally { removeConfig(); }
  }, SLOW);

  // --- starter: --starter, OMC_JEV_SESSION_STARTER, default claude ---
  it('(H) the starter: --starter wins over OMC_JEV_SESSION_STARTER, and the default is `claude`', async () => {
    const dry = async (args, env) => {
      const r = await start({ args: ['--dry-run', ...args], env });
      return r.result.stdout.split('\n').find((line) => line.startsWith('command: ')) ?? '';
    };
    assert.match(await dry([], { OMC_JEV_SESSION_STARTER: undefined }), /^command: claude --bg --name /);
    assert.ok((await dry([], {})).startsWith(`command: ${starter} --bg --name `));
    assert.ok((await dry(['--starter', 'my-claude'], {})).startsWith('command: my-claude --bg --name '));
  }, SLOW);

  it('(I) a starter that fails (exit 3): the launcher calls the same starter at most twice (the repeat without flags), no other, exit 3, session_id null', async () => {
    const failing = join(tmp, 'failing-starter.mjs');
    const callsFile = join(tmp, 'failing-calls');
    writeFileSync(failing, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${js(callsFile)}, 'x\\n');\nconsole.error('failing-starter: no key; start aborted');\nprocess.exit(3);\n`);
    chmodSync(failing, 0o755);
    rmSync(callsFile, { force: true });
    const r = await start({ args: ['--starter', failing, '--mode', 'active'] });
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').length;
    assert.ok(r.result.code === 3 && r.row.starter_exit === 3 && r.row.session_id === null, js({ code: r.result.code, row: r.row }));
    assert.ok(calls === 2 && r.row.fallback === true, `starter calls ${calls}, fallback ${r.row.fallback}`);
    assert.equal(r.argv, null, 'the default fake starter was called (a different starter)');
  }, SLOW);

  // --- the pool gate (OMC_JEV_POOL=1) ---
  const poolEnv = (extra = {}) => ({ OMC_JEV_POOL: '1', OMC_JEV_POOL_MAX_SESSIONS: '20', OMC_JEV_POOL_SESSION_COUNTER: sessionCounter, ...extra });
  it('(pool) the pool gate is off by default: 25 counted sessions do not refuse a start; with OMC_JEV_POOL=1 and a ceiling of 20 the start is refused (exit 2, a pool-refused row, no starter, no query)', async () => {
    const sessionsFile = join(tmp, 'sessions-25');
    writeFileSync(sessionsFile, '25\n');
    const off = await start({ env: { OMC_JEV_POOL_SESSION_COUNTER: sessionCounter, OMC_JEV_POOL_MAX_SESSIONS: '20', FAKE_SESSIONS_FILE: sessionsFile } });
    assert.ok(off.result.code === 0 && !('pool' in off.row), js({ code: off.result.code, row: off.row }));
    const on = await start({ env: poolEnv({ FAKE_SESSIONS_FILE: sessionsFile }) });
    assert.ok(on.result.code === 2 && /the session pool is full \(25\/20\)/.test(on.result.stderr), `exit ${on.result.code}: ${on.result.stderr.slice(0, 300)}`);
    assert.ok(on.row.result === 'pool-refused' && on.row.pool.sessions === 25 && on.row.pool.limit === 20 && on.argv === null && on.queries.length === 0, js({ row: on.row, argv: on.argv }));
    const zero = await start({ env: poolEnv({ OMC_JEV_POOL_MAX_SESSIONS: '0', FAKE_SESSIONS_FILE: sessionsFile }) });
    assert.ok(zero.result.code === 0 && zero.row.pool.sessions === 25, `a ceiling of 0 means no limit: ${js(zero.row)}`);
    const broken = await start({ env: poolEnv({ OMC_JEV_POOL_SESSION_COUNTER: join(tmp, 'no-such-counter') }) });
    assert.ok(broken.result.code === 0 && broken.row.pool.sessions === null && broken.row.pool.error, `a counter read error never refuses: ${js(broken.row)}`);
  }, SLOW);

  it('(pool) a launch in flight holds a slot of its own: a launcher that counted the same sessions is refused, and the slot is given back when the launch ends, fails or is a dry run', async () => {
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    writeFileSync(briefFile, 'Review the payment module and list the risks.');
    const sessionsFile = join(tmp, 'sessions-none');
    writeFileSync(sessionsFile, '0\n');
    const env = (extra = {}) => launcherEnv({ jev: false, logs, extra: poolEnv({ OMC_JEV_POOL_MAX_SESSIONS: '1', FAKE_SESSIONS_FILE: sessionsFile, ...extra }) });
    const argv = ['--role', 'worker', '--brief', briefFile, '--name', 'Flight', '--mode', 'off'];
    const reservations = () => (existsSync(join(logs, 'pool-sessions')) ? readdirSync(join(logs, 'pool-sessions')) : []);
    resetStarter();
    const first = run(argv, env({ FAKE_START: 'slow' }));
    for (let waited = 0; !existsSync(argvFile) && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50)); // the starter of the first launch is running
    assert.ok(existsSync(argvFile), 'the first starter did not run');
    assert.equal(reservations().length, 1, 'the launch in flight holds no reservation');
    const second = await run(argv, env());
    assert.ok(second.code === 2 && /the session pool is full \(1\/1\)/.test(second.stderr), `exit ${second.code}: ${second.stderr.slice(0, 300)}`);
    const refused = rowsOf(logs, 'sessions.jsonl').find((row) => row.result === 'pool-refused');
    assert.ok(refused && refused.pool.sessions === 0 && refused.pool.starting === 1 && refused.pool.limit === 1, js(refused));
    assert.equal((await first).code, 0);
    assert.deepEqual(reservations(), [], 'the reservation of a finished launch stays');
    assert.equal((await run(argv, env())).code, 0, 'a start after the first one ended is refused');
    // a failed start gives its slot back, and so does a dry run
    resetStarter();
    assert.equal((await run(argv, env({ FAKE_START: 'trust' }))).code, 1);
    assert.deepEqual(reservations(), []);
    assert.equal((await run([...argv, '--dry-run'], env())).code, 0);
    assert.deepEqual(reservations(), []);
    assert.equal((await run(argv, env())).code, 0);
    // a counter read error admits the launch and takes no reservation
    assert.equal((await run(argv, env({ OMC_JEV_POOL_SESSION_COUNTER: join(tmp, 'no-such-counter') }))).code, 0);
    assert.deepEqual(reservations(), []);
  }, SLOW);

  // --- J: --resume ---
  it('(J1) --resume: a row with mode resume in sessions.jsonl, argv --bg --resume <id> <prompt> without --model/--effort/--settings/--name, the cwd from --cwd, exit 0', async () => {
    resetStarter();
    const other = join(tmp, 'resume-directory');
    mkdirSync(other, { recursive: true });
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const result = await run(['--resume', 'abc12345', '--prompt', 'Continue in the background: run the skill once.', '--cwd', other, '--name', 'Test resume'], launcherEnv({ logs }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(row.mode === 'resume' && row.result === 'resume' && row.resume === 'abc12345' && row.name === 'Test resume', js(row));
    assert.ok(row.started_with.model === null && row.started_with.effort === null && row.session_id === 'ab12cd34', js(row));
    const argv = readArgv();
    assert.ok(argv[0] === '--bg' && argv[1] === '--resume' && argv[2] === 'abc12345' && argv[3] === 'Continue in the background: run the skill once.', js(argv));
    assert.ok(!hasFlag(argv, '--model') && !hasFlag(argv, '--effort') && !hasFlag(argv, '--settings') && !hasFlag(argv, '--name'), js(argv));
    assert.equal(readFileSync(`${argvFile}.cwd`, 'utf8').trim(), other);
    assert.ok(!/ultragoal|ralph|autopilot/i.test(js(argv)), 'a forbidden word in argv');
    assert.equal(rowsOf(logs, 'shadow.jsonl').filter((entry) => entry.point === 'session-routing').length, 0, 'a query to Jev at a resume');
  }, SLOW);
  it('(J2) --resume: the pool gate at the ceiling: exit 2, a pool-refused row with mode resume, the starter not called', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const sessionsFile = join(tmp, 'sessions-20');
    writeFileSync(sessionsFile, '20\n');
    const result = await run(['--resume', 'def67890', '--prompt', 'Continue.', '--cwd', project], launcherEnv({ logs, extra: poolEnv({ FAKE_SESSIONS_FILE: sessionsFile }) }));
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(result.code === 2 && /the session pool is full \(20\/20/.test(result.stderr), `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    assert.ok(row.mode === 'resume' && row.result === 'pool-refused' && row.pool.sessions === 20, js(row));
    assert.ok(!existsSync(argvFile), 'the starter was called at a pool refusal');
  }, SLOW);
  it('(J3) --resume with options that make no sense (--role, --brief, --mode, --coordinator): exit 2, no starter, no row; no --prompt: exit 2', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const env = launcherEnv({ logs });
    for (const args of [['--resume', 'x1', '--prompt', 'p', '--cwd', project, '--role', 'worker'], ['--resume', 'x2', '--prompt', 'p', '--cwd', project, '--brief', briefFile], ['--resume', 'x3', '--prompt', 'p', '--cwd', project, '--mode', 'active'], ['--resume', 'x4', '--prompt', 'p', '--cwd', project, '--coordinator', 'd7ec31aa']]) {
      const result = await run(args, env);
      assert.ok(result.code === 2 && /makes no sense at a resume/.test(result.stderr) && !existsSync(argvFile), `${args.join(' ')}: ${result.stderr.slice(0, 200)}`);
    }
    assert.equal(rowsOf(logs, 'sessions.jsonl').length, 0);
    const missing = await run(['--resume', 'x5', '--cwd', project], env);
    assert.ok(missing.code === 2 && /needs --prompt/.test(missing.stderr), js(missing.stderr.slice(0, 200)));
  }, SLOW);
  it('(J4) --resume --dry-run: a dry-run row with mode resume, no starter, the command with --resume in stdout', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const result = await run(['--resume', 'abc12345', '--prompt', 'p', '--cwd', project, '--dry-run'], launcherEnv({ logs }));
    assert.ok(result.code === 0 && /resume abc12345/.test(result.stdout), `exit ${result.code}: ${result.stdout.slice(0, 200)}`);
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(row.mode === 'resume' && row.result === 'dry-run' && row.resume === 'abc12345', js(row));
    assert.ok(!existsSync(argvFile), 'the starter was called in a dry run');
  }, SLOW);
  it('(J5) --resume: the pool is counted, a session at 19 main sessions starts: exit 0, pool.sessions 19 in the row', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const sessionsFile = join(tmp, 'sessions-19');
    writeFileSync(sessionsFile, '19\n');
    const result = await run(['--resume', 'fff00011', '--prompt', 'Continue.', '--cwd', project], launcherEnv({ logs, extra: poolEnv({ FAKE_SESSIONS_FILE: sessionsFile }) }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(row.mode === 'resume' && row.result === 'resume' && row.pool.sessions === 19, js(row));
    assert.ok(existsSync(argvFile), 'the starter was not called at 19 sessions');
  }, SLOW);

  // --- the log directory: the same rule as the other Jev logs, shared with the handoff module ---
  it('(L) without OMC_JEV_LOG_DIR the row goes to state/jev of the state root, where the handoff module finds it for the use line of a successor', async () => {
    resetStarter();
    writeFileSync(briefFile, 'use opus high\n\nTask.');
    handler = (body) => ({ body: answerFor(body, defaultAnswers) });
    const result = await run(['--role', 'worker', '--brief', briefFile, '--name', 'default log'], launcherEnv({ logs: undefined }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    const logDir = join(home, '.omc', 'state', 'jev');
    const row = rowsOf(logDir, 'sessions.jsonl').at(-1);
    assert.ok(row && row.started_with.model === 'opus' && row.started_with.effort === 'high' && row.session_id === 'ab12cd34', js(row));
    // the handoff module reads the same file by session id
    writeFileSync(join(logDir, 'sessions.jsonl'), JSON.stringify({ ...row, session_id: 'handoff-lookup' }) + '\n');
    assert.equal(successorUseLine({ sessionId: 'handoff-lookup', stateDir: join(home, '.omc', 'state'), env: {} }), 'use opus high');
  }, SLOW);

  // --- --no-advisor: the advisor tool is switched off per session through the --settings file ---
  it('a start with --no-advisor: the settings file has CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 next to the role variables, the row says advisor: disabled', async () => {
    const r = await start({ args: ['--no-advisor'] });
    assert.equal(r.result.code, 0, `exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
    const file = valueOf(r.argv, '--settings');
    assert.ok(file && file.startsWith(join(r.logs, 'session-settings')), `settings path: ${file}`);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1', js(settings));
    assert.ok(settings.env.OMC_SESSION_ROLE === 'worker' && settings.env.OMC_SESSION_NAME === 'Test track 1' && settings.env.OMC_SESSION_COORDINATOR === 'd7ec31aa', js(settings));
    assert.equal(r.row.advisor, 'disabled', js(r.row));
  }, SLOW);
  it('a start without the flag: the settings file has exactly the three role keys, the row has no advisor field', async () => {
    const r = await start();
    assert.equal(r.result.code, 0, `exit ${r.result.code}`);
    const settings = JSON.parse(readFileSync(valueOf(r.argv, '--settings'), 'utf8'));
    assert.equal(js(Object.keys(settings.env).sort()), js(['OMC_SESSION_COORDINATOR', 'OMC_SESSION_NAME', 'OMC_SESSION_ROLE']));
    assert.ok(!('advisor' in r.row), js(r.row));
  }, SLOW);
  it('a resume with --no-advisor: argv has --settings <file> right before the prompt, the file has only that variable, the row is a resume with advisor: disabled', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const result = await run(['--resume', 'adv020001', '--prompt', 'p', '--cwd', project, '--no-advisor'], launcherEnv({ logs }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    const argv = readArgv();
    const file = valueOf(argv, '--settings');
    assert.ok(file && file.startsWith(join(logs, 'session-settings')), `settings path: ${file}`);
    assert.equal(readFileSync(file, 'utf8').trim(), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } }, null, 2));
    assert.ok(argv.at(-1) === 'p' && argv.at(-2) === file, `order: ${js(argv)}`);
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(row.mode === 'resume' && row.result === 'resume' && row.advisor === 'disabled', js(row));
  }, SLOW);
  it('a resume without the flag: argv without --settings, the row without the advisor field', async () => {
    resetStarter();
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const result = await run(['--resume', 'adv020002', '--prompt', 'p', '--cwd', project], launcherEnv({ logs }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 200)}`);
    assert.ok(!hasFlag(readArgv(), '--settings'), js(readArgv()));
    const row = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(row.mode === 'resume' && row.result === 'resume' && !('advisor' in row), js(row));
  }, SLOW);
  it('--dry-run with --no-advisor (a start and a resume): the switch-off is visible in the output and in the row, no settings file is created', async () => {
    const r = await start({ args: ['--dry-run', '--no-advisor'] });
    assert.equal(r.result.code, 0, `exit ${r.result.code}: ${r.result.stderr.slice(0, 200)}`);
    assert.match(r.result.stdout, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1/);
    assert.ok(r.row.result === 'dry-run' && r.row.advisor === 'disabled' && r.argv === null, js(r.row));
    assert.ok(!existsSync(join(r.logs, 'session-settings')), 'the dry run of a start created the settings directory');
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const resumed = await run(['--resume', 'adv020003', '--prompt', 'p', '--cwd', project, '--dry-run', '--no-advisor'], launcherEnv({ logs }));
    assert.equal(resumed.code, 0, `exit ${resumed.code}: ${resumed.stderr.slice(0, 200)}`);
    assert.match(resumed.stdout, /command: \S+ --bg --resume \S+ --settings \S+ p\b/);
    const resumedRow = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(resumedRow.result === 'dry-run' && resumedRow.advisor === 'disabled', js(resumedRow));
    assert.ok(!existsSync(join(logs, 'session-settings')), 'the dry run of a resume created the settings directory');
  }, SLOW);
  it('a settings file that cannot be written: a start and a resume with --no-advisor give advisor: settings-error, one warning line and no --settings; without the flag the row has no advisor field', async () => {
    // a file in place of the settings directory makes the mkdir of the settings writer throw
    const broken = () => {
      const dir = join(logsRoot, `s${++counter}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'session-settings'), 'a file in place of the directory');
      return dir;
    };
    const warnings = (stderr) => stderr.split('\n').filter((line) => /was not created/.test(line)).length;
    resetStarter();
    writeFileSync(briefFile, 'Review the payment module.');
    const startLogs = broken();
    const started = await run(['--role', 'worker', '--brief', briefFile, '--name', 'settings-error-start', '--no-advisor'], launcherEnv({ logs: startLogs, jev: false }));
    assert.equal(started.code, 0, `start: exit ${started.code}: ${started.stderr.slice(0, 300)}`);
    assert.ok(readArgv() && !hasFlag(readArgv(), '--settings'), `start argv: ${js(readArgv())}`);
    assert.equal(rowsOf(startLogs, 'sessions.jsonl').at(-1).advisor, 'settings-error');
    assert.equal(warnings(started.stderr), 1, started.stderr);
    resetStarter();
    const resumeLogs = broken();
    const resumed = await run(['--resume', 'adv020006', '--prompt', 'p', '--cwd', project, '--no-advisor'], launcherEnv({ logs: resumeLogs }));
    assert.equal(resumed.code, 0, `resume: exit ${resumed.code}: ${resumed.stderr.slice(0, 300)}`);
    assert.ok(readArgv() && !hasFlag(readArgv(), '--settings'), `resume argv: ${js(readArgv())}`);
    const resumeRow = rowsOf(resumeLogs, 'sessions.jsonl').at(-1);
    assert.ok(resumeRow.mode === 'resume' && resumeRow.advisor === 'settings-error', js(resumeRow));
    assert.equal(warnings(resumed.stderr), 1, resumed.stderr);
    resetStarter();
    const plainLogs = broken();
    const plain = await run(['--role', 'worker', '--brief', briefFile, '--name', 'settings-error-plain'], launcherEnv({ logs: plainLogs, jev: false }));
    assert.equal(plain.code, 0, `no flag: exit ${plain.code}: ${plain.stderr.slice(0, 300)}`);
    assert.ok(!('advisor' in rowsOf(plainLogs, 'sessions.jsonl').at(-1)), js(rowsOf(plainLogs, 'sessions.jsonl').at(-1)));
  }, SLOW);
  it('the row never holds the text of the brief, with and without --no-advisor', async () => {
    for (const args of [[], ['--no-advisor']]) {
      const r = await start({ brief: 'SECRET-BRIEF-TEXT to be checked', args });
      assert.ok(!js(r.row).includes('SECRET-BRIEF-TEXT'), js(r.row));
    }
  }, SLOW);

  // --- the provider field of the rows: OMC_JEV_SESSION_PROVIDER=1 ---
  it('without OMC_JEV_SESSION_PROVIDER no row has a provider field, also when OMC_PROVIDER is set (a start, a dry run, a resume)', async () => {
    const env = { OMC_PROVIDER: 'acme' };
    const regular = await start({ env });
    assert.ok(regular.result.code === 0 && !('provider' in regular.row), js(regular.row));
    const dry = await start({ env, args: ['--dry-run'] });
    assert.ok(dry.row.result === 'dry-run' && !('provider' in dry.row), js(dry.row));
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const resumed = await run(['--resume', 'prv000001', '--prompt', 'p', '--cwd', project], launcherEnv({ logs, extra: env }));
    assert.equal(resumed.code, 0, resumed.stderr.slice(0, 200));
    assert.ok(!('provider' in rowsOf(logs, 'sessions.jsonl').at(-1)), js(rowsOf(logs, 'sessions.jsonl').at(-1)));
  }, SLOW);
  it('with OMC_JEV_SESSION_PROVIDER=1 the row names the profile of OMC_PROVIDER, `claude` without it or when it is blank; a start, a dry run and a resume', async () => {
    const on = { OMC_JEV_SESSION_PROVIDER: '1' };
    const named = await start({ env: { ...on, OMC_PROVIDER: ' acme ' } });
    assert.ok(named.result.code === 0 && named.row.provider === 'acme' && named.row.session_id === 'ab12cd34', js(named.row));
    const plain = await start({ env: on });
    assert.equal(plain.row.provider, 'claude', js(plain.row));
    const blank = await start({ env: { ...on, OMC_PROVIDER: '  ' } });
    assert.equal(blank.row.provider, 'claude', js(blank.row));
    const dry = await start({ env: { ...on, OMC_PROVIDER: 'acme' }, args: ['--dry-run'] });
    assert.ok(dry.row.result === 'dry-run' && dry.row.provider === 'acme', js(dry.row));
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const resumed = await run(['--resume', 'prv000002', '--prompt', 'p', '--cwd', project], launcherEnv({ logs, extra: { ...on, OMC_PROVIDER: 'acme' } }));
    assert.equal(resumed.code, 0, resumed.stderr.slice(0, 200));
    assert.ok(rowsOf(logs, 'sessions.jsonl').at(-1).result === 'resume' && rowsOf(logs, 'sessions.jsonl').at(-1).provider === 'acme', js(rowsOf(logs, 'sessions.jsonl').at(-1)));
    const dryResumed = await run(['--resume', 'prv000005', '--prompt', 'p', '--cwd', project, '--dry-run'], launcherEnv({ logs, extra: { ...on, OMC_PROVIDER: 'acme' } }));
    assert.equal(dryResumed.code, 0, dryResumed.stderr.slice(0, 200));
    const dryResumeRow = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(dryResumeRow.mode === 'resume' && dryResumeRow.result === 'dry-run' && dryResumeRow.provider === 'acme', js(dryResumeRow));
  }, SLOW);
  it('the rows of a refused start and a refused resume carry the advisor and provider fields like the other rows, and neither without the switch and the flag', async () => {
    const sessionsFile = join(tmp, 'sessions-full');
    writeFileSync(sessionsFile, '25\n');
    const full = (extra = {}) => poolEnv({ FAKE_SESSIONS_FILE: sessionsFile, ...extra });
    const on = { OMC_JEV_SESSION_PROVIDER: '1', OMC_PROVIDER: 'acme' };
    const started = await start({ env: full(on), args: ['--no-advisor'] });
    assert.ok(started.result.code === 2 && started.row.result === 'pool-refused' && started.row.advisor === 'disabled' && started.row.provider === 'acme', js(started.row));
    const logs = join(logsRoot, `s${++counter}`);
    mkdirSync(logs, { recursive: true });
    const resumed = await run(['--resume', 'prv000003', '--prompt', 'p', '--cwd', project, '--no-advisor'], launcherEnv({ logs, extra: full(on) }));
    const resumeRow = rowsOf(logs, 'sessions.jsonl').at(-1);
    assert.ok(resumed.code === 2 && resumeRow.mode === 'resume' && resumeRow.result === 'pool-refused' && resumeRow.advisor === 'disabled' && resumeRow.provider === 'acme', js(resumeRow));
    const plain = await start({ env: full({ OMC_PROVIDER: 'acme' }) });
    assert.ok(plain.row.result === 'pool-refused' && !('advisor' in plain.row) && !('provider' in plain.row), js(plain.row));
    const plainLogs = join(logsRoot, `s${++counter}`);
    mkdirSync(plainLogs, { recursive: true });
    await run(['--resume', 'prv000004', '--prompt', 'p', '--cwd', project], launcherEnv({ logs: plainLogs, extra: full({ OMC_PROVIDER: 'acme' }) }));
    const plainResume = rowsOf(plainLogs, 'sessions.jsonl').at(-1);
    assert.ok(plainResume.result === 'pool-refused' && !('advisor' in plainResume) && !('provider' in plainResume), js(plainResume));
  }, SLOW);

  it('only the exact value 1 switches the provider field on', async () => {
    for (const value of ['true', '0', '']) {
      const r = await start({ env: { OMC_JEV_SESSION_PROVIDER: value, OMC_PROVIDER: 'acme' } });
      assert.ok(r.result.code === 0 && !('provider' in r.row), `${value}: ${js(r.row)}`);
    }
  }, SLOW);
});
