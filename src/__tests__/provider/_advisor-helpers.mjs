/* global process, URL */
// Shared fixtures of the advisor tests: a fake `claude` binary (a node script) and a runner of provider-advisor.cjs.
// The fake records its argv, stdin, environment names, working directory and process group next to the prefix given in FAKE_OUT
// (files <prefix>.argv, .stdin, .env, .kills, .path, .pid, .cwd, .pgid, plus a per-attempt counter <prefix>.n with .argv-N and .stdin-N)
// and answers according to the scenario (the file <prefix>.scenario or the FAKE_* variables; FAKE_TEMPLATE names a file whose text, with @TOKEN@ replaced
// by the input token, is the answer; FAKE_TOUCH names a file appended to during the consultation). Nothing here touches the network.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADVISOR = fileURLToPath(new URL('../../../scripts/provider/provider-advisor.cjs', import.meta.url));
export const ROLE_TEMPLATE = fileURLToPath(new URL('../../../templates/provider/advisor-role.md', import.meta.url));

const FAKE_SOURCE = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const out = process.env.FAKE_OUT;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
let n = Number(read(out + '.n') || 0) + 1;
fs.writeFileSync(out + '.n', String(n));
const argv = JSON.stringify(process.argv.slice(2));
fs.writeFileSync(out + '.argv', argv); fs.writeFileSync(out + '.argv-' + n, argv);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }
fs.writeFileSync(out + '.stdin', stdin); fs.writeFileSync(out + '.stdin-' + n, stdin);
fs.writeFileSync(out + '.env', Object.keys(process.env).sort().join('\\n') + '\\n');
fs.writeFileSync(out + '.kills', 'ADVISOR=' + process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL + ' OMC=' + process.env.DISABLE_OMC + '\\n');
fs.writeFileSync(out + '.path', process.env.PATH || '');
fs.writeFileSync(out + '.cwd', fs.realpathSync(process.cwd()));
fs.writeFileSync(out + '.pgid', read('/proc/self/stat').slice(read('/proc/self/stat').lastIndexOf(')') + 2).split(' ')[2] || '');
fs.writeFileSync(out + '.pid', String(process.pid));
const scenario = read(out + '.scenario').trim();
const e = process.env;
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const result = (text, extra = {}) => emit({ type: 'result', is_error: false, result: text, total_cost_usd: 0.0042, usage: { input_tokens: 120, output_tokens: 45 }, ...extra });
if (scenario === 'sleep' || e.FAKE_SLEEP) { setTimeout(() => {}, 30000); return; }
if (scenario === '429-then-ok' && n === 1) { process.stderr.write('error: too_many_requests (429), Retry-After: 1\\n'); process.exit(5); }
if (scenario === '429-then-ok' && n === 2) { result('ANSWER-AFTER-RETRY'); process.exit(0); }
if (scenario === '429-twice') { process.stderr.write('error: too_many_requests (429), Retry-After: 1\\n'); process.exit(5); }
if (e.FAKE_TOUCH) fs.appendFileSync(e.FAKE_TOUCH, 'change during the consultation\\n');
if (e.FAKE_TEMPLATE) {
  const m = /INPUT TOKEN: (\\S+)/.exec(stdin);
  const text = read(e.FAKE_TEMPLATE) || 'STUB-ANSWER: confirm';
  result(text.replace(/@TOKEN@/g, m ? m[1] : 'NO-TOKEN'));
  process.exit(Number(e.FAKE_CODE || 0));
}
if (e.FAKE_ERR) process.stderr.write(e.FAKE_ERR + '\\n');
const code = Number(e.FAKE_CODE || 0);
if (e.FAKE_TEXT) { process.stdout.write('STUB-ANSWER: confirm\\n'); process.exit(code); }
if (e.FAKE_EMPTY) { result(''); process.exit(code); }
if (e.FAKE_ANSWER_TOKEN) {
  const m = /INPUT TOKEN: ([0-9a-f]+)/.exec(stdin);
  emit({ type: 'result', is_error: false, result: 'TOKEN: ' + (m ? m[1] : 'none') });
  process.exit(code);
}
if (e.FAKE_ANSWER) { result(e.FAKE_ANSWER, { modelUsage: { 'stub-model': { costUSD: 0.003, inputTokens: 100, outputTokens: 40 } } }); process.exit(code); }
if (e.FAKE_JSON_ERROR === 'limit') { emit({ type: 'result', is_error: true, result: '429 Too Many Requests (too_many_requests)' }); process.exit(code); }
if (e.FAKE_JSON_ERROR) { emit({ type: 'result', is_error: true, result: 'refused' }); process.exit(code); }
result('STUB-ANSWER: confirm', { modelUsage: { 'stub-model': { costUSD: 0.003, inputTokens: 100, outputTokens: 40 } } });
process.exit(code);
`;

// Writes the fake claude into dir and returns its path.
export function fakeAdvisorClaude(dir) {
  const file = join(dir, 'claude-fake.cjs');
  writeFileSync(file, FAKE_SOURCE, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

// Runs the advisor script. env is the full environment of the process (only what is given); fakeOut is the prefix of the fake outputs.
// scenario is written to <fakeOut>.scenario. Returns the spawn result plus the recorded files.
export function runAdvisor({ env, argv = ['Why does the test fail? context: a.go:12'], fakeOut, scenario, input, cwd, timeoutMs = 60000 }) {
  if (scenario) writeFileSync(`${fakeOut}.scenario`, scenario);
  const e = { ...env, FAKE_OUT: fakeOut };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [ADVISOR, ...argv], { encoding: 'utf8', env: e, input, cwd, timeout: timeoutMs });
  const read = (x) => (existsSync(`${fakeOut}.${x}`) ? readFileSync(`${fakeOut}.${x}`, 'utf8') : null);
  const attempt = (k) => (existsSync(`${fakeOut}.argv-${k}`) ? JSON.parse(readFileSync(`${fakeOut}.argv-${k}`, 'utf8')) : null);
  return {
    ...r,
    out: fakeOut,
    called: existsSync(`${fakeOut}.argv`),
    argv: read('argv') && JSON.parse(read('argv')),
    attempt,
    stdin: read('stdin'),
    cwd: read('cwd')?.trim(),
    pgid: read('pgid')?.trim(),
    envNames: read('env')?.trim().split('\n'),
    path: read('path'),
    kills: read('kills'),
    calls: existsSync(`${fakeOut}.n`) ? Number(readFileSync(`${fakeOut}.n`, 'utf8')) : 0,
  };
}

// Rows of a JSONL journal.
export const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
