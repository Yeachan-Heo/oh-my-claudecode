#!/usr/bin/env node
// Dry run of the Jev panel against a local stand-in for the Jev API (mock-jev.mjs): no network, no TYPESAFE_API_KEY, no cost.
// It drives the real hook scripts of this tree (jev-lista-stan.mjs, jev-lista-paczka.mjs, jev-panel-koniec.mjs) with synthetic hook
// input and checks what the panel sent to the mock and what it handed back to the agent.
//   node scripts/jev-negative-results/jev-panel/dry-run.mjs
// Exit code 0 when every check passes. Everything happens in a temporary directory (HOME, log directory, project, transcripts).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-jev.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'jev-panel-dry-'));
const HOME = join(TMP, 'home');
const LOGS = join(TMP, 'logs');
const PROJECT = join(TMP, 'project');
const TRANSCRIPTS = join(TMP, 'transcripts');
for (const dir of [join(HOME, '.claude', 'agents'), LOGS, PROJECT, TRANSCRIPTS]) mkdirSync(dir, { recursive: true });

const mock = await startMock();
const results = [];
async function check(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK    ${name}${note ? `: ${note}` : ''}`); } catch (error) { results.push(false); console.log(`FAIL  ${name}: ${error.message}`); }
}
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

// The environment of a hook: nothing from the caller's OMC_*, TYPESAFE_* or CLAUDE* variables; a fake key and the mock endpoint.
function hookEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC)/i.test(key)));
  return Object.assign(env, {
    HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: join(HOME, '.claude'), CLAUDE_PLUGIN_ROOT: ROOT,
    OMC_JEV_LOG_DIR: LOGS, OMC_JEV_APPLIED_LOG: '1', TYPESAFE_API_KEY: 'fake-key-for-the-mock', OMC_JEV_ENDPOINT: `http://127.0.0.1:${mock.port}/v1/systemone`,
    OMC_JEV: 'panel:active', OMC_JEV_PANEL_WERSJA: '2', OMC_TODO_HINT: 'active',
  }, extra);
}
function runHook(script, input, env = hookEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script)], { cwd: PROJECT, env, windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script}: timeout`)); }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
      resolve({ code, json, context: String(json?.hookSpecificOutput?.additionalContext ?? '') });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

let counter = 0;
const newSession = () => `dry-run-${process.pid}-${++counter}`;
const transcriptOf = (sid) => join(TRANSCRIPTS, `${sid}.jsonl`);
const writeTranscript = (sid, rows) => writeFileSync(transcriptOf(sid), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
let clock = Date.parse('2026-11-11T08:00:00Z');
const stamp = () => new Date((clock += 1000)).toISOString();
const owner = (text) => ({ type: 'user', timestamp: stamp(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const brief = (text) => ({ type: 'user', timestamp: stamp(), message: { role: 'user', content: text } }); // no `origin: human`: a session started by another session
const assistant = (text) => ({ type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const read = () => ({ tool_name: 'Read', tool_input: { file_path: '/project/notes.txt' }, tool_use_id: `toolu_${++counter}`, tool_response: 'file contents' });
const batch = (sid, calls) => ({ session_id: sid, transcript_path: transcriptOf(sid), cwd: PROJECT, hook_event_name: 'PostToolBatch', tool_calls: calls });
const setList = (sid, items) => runHook('jev-lista-stan.mjs', { session_id: sid, transcript_path: transcriptOf(sid), cwd: PROJECT, hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: items }, tool_use_id: `toolu_${++counter}`, tool_response: 'ok' });
const queries = () => mock.received.filter((body) => body?.questions && body.state);
const rows = (name) => (existsSync(join(LOGS, name)) ? readFileSync(join(LOGS, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const ALL_QUESTIONS = 'deleguj,notka,poboczne,pokaz,przypomnienie,slop,utknal,zrobione,zrodlo';

try {
  await check('off by default: without the point `panel` in OMC_JEV nothing is sent and nothing is injected', async () => {
    mock.received.length = 0;
    const sid = newSession();
    writeTranscript(sid, [owner('Do the task'), assistant('Working on it.')]);
    const out = await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)), hookEnv({ OMC_JEV: 'all:active' }));
    ensure(out.code === 0 && queries().length === 0 && !out.context.includes('Panel Jeva'), `requests ${queries().length}, context ${JSON.stringify(out.context.slice(0, 80))}`);
  });

  await check('active: one query after a batch carries nine questions; a "list is out of date" yes plus the choice question gives one hint', async () => {
    mock.received.length = 0;
    mock.answer({ zrobione: { noul: 0.9 }, pokaz: { choice: 'zrobione', confidence: 0.9 } });
    const sid = newSession();
    writeTranscript(sid, [owner('Fix the failing test and report.'), assistant('I read the notes; the fix is already in place.')]);
    await setList(sid, [{ content: 'Fix the failing test', status: 'in_progress', activeForm: 'Fixing the failing test' }]);
    const out = await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)));
    const sent = queries();
    ensure(sent.length === 1, `queries ${sent.length}`);
    const names = Object.keys(sent[0].questions).sort().join(',');
    ensure(names === ALL_QUESTIONS, names);
    ensure((out.context.match(/Panel Jeva:/g) ?? []).length === 1, `context: ${JSON.stringify(out.context.slice(0, 200))}`);
    const row = rows('panel.jsonl').at(-1);
    ensure(row?.wynik === 'active' && Array.isArray(row.podpowiedzi), JSON.stringify(row)?.slice(0, 200));
    return `questions: ${names}; hint: ${JSON.stringify(out.context.slice(0, 90))}`;
  });

  await check('active: when Jev answers "no" to everything, the panel is silent (a query is sent, no hint)', async () => {
    mock.received.length = 0;
    mock.answer({});
    const sid = newSession();
    writeTranscript(sid, [owner('Do the task'), assistant('Reading.')]);
    await setList(sid, [{ content: 'Do the task', status: 'in_progress', activeForm: 'Doing the task' }]);
    const out = await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)));
    ensure(queries().length === 1 && !out.context.includes('Panel Jeva'), `queries ${queries().length}, context ${JSON.stringify(out.context.slice(0, 80))}`);
  });

  await check('the order of answers does not matter: the mock answers in reverse question order and the hint still names the chosen question', async () => {
    mock.received.length = 0;
    mock.answer({ utknal: { noul: 0.9 }, pokaz: { choice: 'utknal', confidence: 0.9 } });
    const sid = newSession();
    writeTranscript(sid, [owner('Run the build'), assistant('Trying again.')]);
    await setList(sid, [{ content: 'Run the build', status: 'in_progress', activeForm: 'Running the build' }]);
    const out = await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)));
    ensure(out.context.includes('Panel Jeva:') && /nie udała|powtarz|ponown|ta sama/i.test(out.context), JSON.stringify(out.context.slice(0, 200)));
  });

  await check('P1 symptom: a session started by another session (no `origin: human` row) still gets the order into the state field `polecenia`', async () => {
    mock.received.length = 0;
    mock.answer({});
    const sid = newSession();
    writeTranscript(sid, [brief('<teammate-message teammate_id="lead">Task: update the changelog and report back.</teammate-message>'), assistant('Starting.')]);
    await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)));
    const state = queries().at(-1)?.state;
    ensure(Array.isArray(state?.polecenia) && state.polecenia.join(' ').includes('update the changelog'), JSON.stringify(state?.polecenia));
  });

  await check('shadow mode: the state is logged by the resolver, the agent gets no hint', async () => {
    mock.received.length = 0;
    mock.answer({ zrobione: { noul: 0.9 }, pokaz: { choice: 'zrobione', confidence: 0.9 } });
    const sid = newSession();
    writeTranscript(sid, [owner('Do the task'), assistant('Reading.')]);
    await setList(sid, [{ content: 'Do the task', status: 'in_progress', activeForm: 'Doing the task' }]);
    const out = await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)), hookEnv({ OMC_JEV: 'panel:shadow' }));
    ensure(!out.context.includes('Panel Jeva'), JSON.stringify(out.context.slice(0, 120)));
  });

  await check('per-question switch: OMC_JEV_PANEL_PYTANIA=zrobione:off removes the question from the query', async () => {
    mock.received.length = 0;
    mock.answer({});
    const sid = newSession();
    writeTranscript(sid, [owner('Do the task'), assistant('Reading.')]);
    await setList(sid, [{ content: 'Do the task', status: 'in_progress', activeForm: 'Doing the task' }]);
    await runHook('jev-lista-paczka.mjs', batch(sid, Array.from({ length: 8 }, read)), hookEnv({ OMC_JEV_PANEL_PYTANIA: 'zrobione:off' }));
    const names = Object.keys(queries().at(-1)?.questions ?? {});
    ensure(names.length > 0 && !names.includes('zrobione'), names.join(','));
  });

  await check('end of turn (Stop): one query about the closing text, logged for scoring, no hint and no block', async () => {
    mock.received.length = 0;
    mock.answer({});
    const sid = newSession();
    writeTranscript(sid, [owner('Do the task'), assistant('Done: the change is made and the tests pass.')]);
    const out = await runHook('jev-panel-koniec.mjs', { session_id: sid, transcript_path: transcriptOf(sid), cwd: PROJECT, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done: the change is made and the tests pass.' });
    ensure(out.code === 0 && out.json?.decision !== 'block' && !out.context.includes('Panel Jeva'), JSON.stringify(out.json)?.slice(0, 160));
    return `queries ${queries().length}`;
  });

  await check('offline replay (replay-labelled.mjs --dry-run) rebuilds the states of a synthetic labelled case without any Jev request', async () => {
    const dir = join(TMP, 'example');
    const run = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: PROJECT, env: hookEnv({ OMC_JEV: '' }), windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    const here = join(ROOT, 'scripts', 'jev-negative-results', 'jev-panel');
    ensure((await run([join(here, 'example', 'make-example.mjs'), dir])).code === 0, 'make-example failed');
    const replay = await run([join(here, 'replay-labelled.mjs'), join(dir, 'labels.example.jsonl'), join(dir, 'out.jsonl'), '--dry-run', '--panel', join(dir, 'none.jsonl')]);
    ensure(replay.code === 0, 'replay failed');
    const summary = JSON.parse(replay.stdout.trim().split('\n').pop());
    const row = JSON.parse(readFileSync(join(dir, 'out.jsonl'), 'utf8').trim().split('\n')[0]);
    ensure(summary.przypadkow === 1 && summary.zapytan_jeva === 0 && summary.bledow === 0 && row.paczka.pytania.includes('zrobione'), JSON.stringify(summary));
  });
} finally {
  await mock.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nResult: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
