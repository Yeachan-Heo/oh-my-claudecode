/* global process, Buffer */
// provider-advisor: the consultation of a provider worker with an advisor on the host login, on a fake `claude` (no network, no real key).
// The number in a case name is its number in this file; the sections: base call, shaped input (K), journal protocol and verdict mode (J), role and event parameters.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADVISOR, ROLE_TEMPLATE, fakeAdvisorClaude, readRows, runAdvisor } from './_advisor-helpers.mjs';
import { makeTmp, writeProfile } from './_helpers.mjs';

// Each case starts several node processes; on a loaded machine that takes longer than the default limit.
vi.setConfig({ testTimeout: 180000 });

const require = createRequire(import.meta.url);
const verdictLib = require('../../../scripts/provider/lib/advisor-verdict.cjs');
const journalLib = require('../../../scripts/provider/lib/advisor-journal.cjs');
const envLib = require('../../../scripts/provider/lib/env.cjs');

const js = JSON.stringify;
// check(condition, message): the condition must be true; the message is shown on failure.
const check = (condition, message) => expect(Boolean(condition), typeof message === 'function' ? message() : message).toBe(true);
const FAKE_KEY = 'FAKE-ADVISOR-KEY-0123456789';
const DEFAULT_ROLE = verdictLib.parseProfiles(readFileSync(ROLE_TEMPLATE, 'utf8')).profiles.default;
const QUESTION = 'Why does the test fail? context: a.go:12';

const gitIn = (wt, args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
const TEMPLATE_QUESTION = [
  'DECISION: whether to push the fix to b.go; if so, I will change the test, if not, I go back to the plan',
  'TRIED: attempt-1: an import change',
  'TEST TAIL: FAIL b_test.go:12',
  'HYPOTHESIS: the import order',
  'EVIDENCE: rg "func b" shows a.go:3',
  'FILES: a.go',
].join('\n');
const withoutFiles = TEMPLATE_QUESTION.split('\n').filter((l) => !l.startsWith('FILES:')).join('\n');

describe.skipIf(process.platform === 'win32')('provider advisor', () => {
  let tmp; let TMP; let FAKE; let JOURNAL; let n = 0; let wtCount = 0;
  const base = () => ({ PATH: process.env.PATH, HOME: TMP, OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL });
  const advisor = (env = {}, argv = [QUESTION], options = {}) => runAdvisor({ env: { ...base(), ...env }, argv, fakeOut: join(TMP, `w${++n}`), ...options });
  const rows = () => readRows(JOURNAL);
  const lastRow = () => rows().at(-1);
  const systemPrompt = (r) => r.argv[r.argv.indexOf('--system-prompt') + 1];
  // A worktree fixture: a git repository with a.go (5 lines) and b.go (1 line) committed, then b.go modified (the diff).
  const worktree = () => {
    const wt = join(TMP, `wt-${++wtCount}`);
    mkdirSync(wt, { recursive: true });
    gitIn(wt, ['init', '-q', '-b', 'main']);
    writeFileSync(join(wt, 'a.go'), ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n') + '\n');
    writeFileSync(join(wt, 'b.go'), 'const x = 1;\n');
    gitIn(wt, ['add', 'a.go', 'b.go']);
    gitIn(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start']);
    writeFileSync(join(wt, 'b.go'), 'const x = 2;\nconst y = 3;\n');
    return wt;
  };
  // The team state of a worker with one in-progress task (the plan of the advisor comes from the tasks of the team state root).
  const teamState = (name, tasks) => {
    const dir = join(TMP, `state-${name}`);
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    for (const t of tasks) writeFileSync(join(dir, 'tasks', `${t.id}.json`), js(t));
    return dir;
  };
  const inputOn = (wt, extra = {}) => ({ OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_TEAM_WORKTREE_PATH: wt, ...extra });

  beforeAll(() => {
    tmp = makeTmp('provider-advisor-');
    TMP = tmp.dir;
    FAKE = fakeAdvisorClaude(TMP);
    JOURNAL = join(TMP, 'data', 'advisor.jsonl');
  });
  afterAll(() => tmp.cleanup());

  it('(1) a question from argv: the answer on stdout (exit 0), claude with -p --model opus --tools "" and an empty MCP and the safe call (--setting-sources "", --no-session-persistence, --disable-slash-commands, --output-format json, --permission-mode plan, --system-prompt from the role file), the prompt on stdin with the plan and the question (the role is in --system-prompt)', () => {
    const state = teamState('plan1', [{ id: '1', subject: 'PLAN-STUB: change function a in b.go', description: 'test: go test ./...', status: 'in_progress', owner: 'worker-1' }]);
    const r = advisor({ OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_STATE_ROOT: state });
    check(r.status === 0 && /STUB-ANSWER: confirm/.test(r.stdout), js({ s: r.status, o: r.stdout, e: r.stderr })); // the answer comes from the result field of the JSON
    check(js(r.argv) === js(['-p', '--model', 'opus', '--tools', '', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--permission-mode', 'plan', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt', DEFAULT_ROLE]), js(r.argv));
    check(r.stdin.startsWith('WORKER CONTEXT:') && r.stdin.includes('TASK PLAN FROM THE LEAD:\ntask 1: PLAN-STUB: change function a in b.go: test: go test ./...\n') && r.stdin.endsWith(`WORKER QUESTION:\n${QUESTION}\n`), js(r.stdin));
    const bare = advisor();
    check(bare.stdin.startsWith('TASK PLAN FROM THE LEAD: none found.\n'), js(bare.stdin));
  });
  it('(2) a question from stdin when there are no arguments; an empty question: exit 2, claude not called, a journal row', () => {
    const r = advisor({}, [], { input: 'question from stdin\nsecond line\n' });
    check(r.status === 0 && r.stdin.endsWith('WORKER QUESTION:\nquestion from stdin\nsecond line\n'), js({ s: r.status, i: r.stdin }));
    const p = advisor({}, [], { input: '  \n' });
    check(p.status === 2 && !p.called && /usage/.test(p.stderr) && lastRow().status === 'empty-question', js({ s: p.status, w: lastRow() }));
  });
  it('(3) the plan: no task of the worker (no state root or a missing one): the information goes into the prompt, the consultation works', () => {
    for (const root of [undefined, join(TMP, 'no-such-state')]) {
      const b = advisor({ OMC_TEAM_STATE_ROOT: root });
      check(b.status === 0 && /TASK PLAN FROM THE LEAD: none found\./.test(b.stdin), js({ root, s: b.status }));
    }
  });
  it('(4) the env of claude has nothing of the provider: ANTHROPIC_*, API_TIMEOUT_MS, the provider markers and overrides, tokens; PATH without the shim directories (an own shim directory and a directory with a generated shim); the OMC team worker variables stay; the rest stays (a foreign ANTHROPIC_BASE_URL in the input is a refusal: test (19))', () => {
    const home = join(TMP, 'home-d'); const own = join(TMP, 'shims-own'); const generated = join(TMP, 'shims-generated');
    mkdirSync(own, { recursive: true }); mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, 'claude'), '#!/bin/sh\n# Generated provider shim "claude". Do not edit; rewritten on every start.\n');
    const r = advisor({
      HOME: home, OMC_PROVIDER_SHIM_DIR: own, ANTHROPIC_AUTH_TOKEN: FAKE_KEY, ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'acme-large[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'acme', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'x',
      API_TIMEOUT_MS: '3000000', OMC_PROVIDER_SETTINGS_FILE: '/x.json', OMC_PROVIDER: 'acme', OMC_PROVIDER_API_KEY_FILE: '/k', OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_OAUTH_TOKEN: 'c', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      OMC_TEAM_WORKER: 'team-k/worker-k', OMC_TEAM_STATE_ROOT: TMP, OMC_TEAM_WORKTREE_PATH: '/wt-k', OMC_TEAM_WORKER_CWD: '/wt-k/dir', // the worker context stays in the env of the advisor (needed for the prompt)
      PATH: `${generated}:${own}:${process.env.PATH}`,
    });
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr }));
    // the kill switches CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 and DISABLE_OMC=1 are deliberate in the env of the child; the rest of ANTHROPIC_*/CLAUDE_CODE_* must not stay
    const left = r.envNames.filter((z) => /^(ANTHROPIC_|OMC_PROVIDER)/.test(z) || envLib.DENY_ENV.includes(z) || (z !== 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL' && /^CLAUDE_CODE_/.test(z)) || ['API_TIMEOUT_MS', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(z));
    check(left.length === 0, js(left));
    check(['OMC_TEAM_WORKER', 'OMC_TEAM_STATE_ROOT', 'OMC_TEAM_WORKTREE_PATH', 'OMC_TEAM_WORKER_CWD'].every((z) => r.envNames.includes(z)), 'the OMC team worker variables were removed from the env of the advisor');
    const first = process.env.PATH.split(':').find((p) => p && p !== own && p !== generated);
    check(!r.path.split(':').some((p) => p === own || p === generated) && first && r.path.split(':').includes(first), r.path.slice(0, 200));
    check(r.envNames.includes('CLAUDE_CODE_DISABLE_ADVISOR_TOOL') && r.envNames.includes('DISABLE_OMC'), js(r.envNames.filter((z) => ['CLAUDE_CODE_DISABLE_ADVISOR_TOOL', 'DISABLE_OMC'].includes(z))));
    check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY) && !r.stdin.includes(FAKE_KEY), 'the key in the output');
  });
  it('(5) the journal: a row {ts, job_id, model, question_chars, answer_chars, status ok, duration_ms} plus cost and tokens, with no question text, plan or answer; the directory is 0700', () => {
    const before = rows().length;
    const question = `SECRET-QUESTION-TEXT ${'p'.repeat(50)}`;
    const r = advisor({ OMC_TEAM_WORKER: 'team-j/job-0002' }, [question]);
    const all = rows();
    const last = all.at(-1);
    // with the answer in JSON the journal gets the fields cost_usd, tokens_in, tokens_out
    check(r.status === 0 && all.length === before + 1 && js(Object.keys(last)) === js(['ts', 'job_id', 'model', 'question_chars', 'answer_chars', 'status', 'duration_ms', 'cost_usd', 'tokens_in', 'tokens_out']), js(last));
    check(last.job_id === 'team-j/job-0002' && last.status === 'ok' && last.question_chars === question.length && last.answer_chars === 'STUB-ANSWER: confirm'.length && last.cost_usd === 0.0042 && last.tokens_in === 120 && last.tokens_out === 45 && Number.isInteger(last.duration_ms) && !Number.isNaN(Date.parse(last.ts)), js(last));
    const raw = readFileSync(JOURNAL, 'utf8');
    check(!raw.includes('SECRET-QUESTION') && !raw.includes('STUB-ANSWER') && !raw.includes(FAKE_KEY), 'text in the journal');
    check((statSync(dirname(JOURNAL)).mode & 0o777) === 0o700, (statSync(dirname(JOURNAL)).mode & 0o777).toString(8));
    check(!('type' in last) && !('consultation_id' in last) && !('event' in last) && !('advice' in last), `with the journal protocol off the row has no protocol fields: ${js(Object.keys(last))}`);
  });
  it('(6) the default journal path is advisor.jsonl in the state directory (OMC_PROVIDER_STATE_DIR) when OMC_PROVIDER_ADVISOR_LOG_FILE is not set', () => {
    const stateDir = join(TMP, 'state-e'); mkdirSync(stateDir, { recursive: true });
    const r = advisor({ OMC_PROVIDER_ADVISOR_LOG_FILE: undefined, OMC_PROVIDER_STATE_DIR: stateDir });
    const file = join(stateDir, 'advisor.jsonl');
    check(r.status === 0 && existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).status === 'ok', js({ s: r.status, e: r.stderr }));
  });
  it('(7) a claude error: the exit code passes, the stderr of claude is visible, status error in the journal', () => {
    const r = advisor({ FAKE_CODE: '5', FAKE_ERR: 'error-from-claude' });
    check(r.status === 5 && /error-from-claude/.test(r.stderr) && lastRow().status === 'error' && lastRow().answer_chars > 0, js({ s: r.status, e: r.stderr, w: lastRow() }));
  });
  it('(8) no binary (OMC_PROVIDER_ADVISOR_CLAUDE_BIN points to a missing file): exit 127 and a no-binary row', () => {
    const r = advisor({ OMC_PROVIDER_ADVISOR_CLAUDE_BIN: join(TMP, 'does-not-exist') });
    check(r.status === 127 && !r.called && lastRow().status === 'no-binary', js({ s: r.status, w: lastRow() }));
  });
  it('(9) the time limit: exit 124, the claude process killed, a timeout row (the limit from OMC_PROVIDER_ADVISOR_TIMEOUT_MS only in a test); the test waits for the .pid file before reading it', () => {
    const t0 = Date.now();
    const r = advisor({ FAKE_SLEEP: '1', OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '3000' });
    let pid = null;
    for (let k = 0; k < 100; k++) { // wait for the .pid to appear (up to 5 s), not a read right away
      try { pid = Number(readFileSync(`${r.out}.pid`, 'utf8')); break; } catch { spawnSync('sleep', ['0.05']); }
    }
    check(pid !== null, 'the fake did not write .pid (a start over 5 s: finished = timeout instead of enforcement)');
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    check(r.status === 124 && !alive && Date.now() - t0 < 15_000 && lastRow().status === 'timeout' && /time limit/.test(r.stderr), js({ s: r.status, alive, w: lastRow() }));
  });
  it('(10) the script does not reach for a provider key or address (no key helper, readKey, apiKey, baseUrl or URL in the code)', () => {
    const code = readFileSync(ADVISOR, 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    check(!/readKey|keyHelper|key-helper|apiKey|baseUrl|https?:\/\//.test(code), 'the code reaches for a provider key or address');
  });
  it('(11) project settings files: the advisor claude starts in an empty temporary directory (not in the worker worktree with .claude/settings.local.json holding ANTHROPIC_BASE_URL), with --setting-sources "" (no user settings); the directory is removed afterwards', () => {
    const wt = join(TMP, 'worktree'); mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'settings.local.json'), js({ env: { ANTHROPIC_BASE_URL: 'http://foreign.example:9' } }));
    const r = advisor({ OMC_PROVIDER_FILE_ROOT: wt }, undefined, { cwd: wt });
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr }));
    check(r.cwd && r.cwd !== realpathSync(wt) && !r.cwd.startsWith(realpathSync(wt)) && existsSync(wt), `cwd of claude: ${r.cwd}`);
    check(!existsSync(r.cwd), `the temporary directory ${r.cwd} was not removed`);
    const i = r.argv.indexOf('--setting-sources');
    check(i >= 0 && r.argv[i + 1] === '', js(r.argv));
    const t = advisor({ FAKE_SLEEP: '1', OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '500' });
    check(t.status === 124 && t.cwd && !existsSync(t.cwd), `after the time limit the directory ${t.cwd} stayed`);
  });
  it('(12) no detached: claude in the process group of the advisor; SIGTERM to the group of the worker kills the advisor and claude (no orphan)', () => {
    const out = join(TMP, 'group');
    const script = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const e = ${js({ ...base(), FAKE_OUT: out, FAKE_SLEEP: '1', OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '120000' })};
const d = spawn(process.execPath, [${js(ADVISOR)}, 'question'], { env: e, detached: true, stdio: 'ignore' });
const t0 = Date.now(); const wait = () => { if (fs.existsSync(${js(`${out}.pgid`)}) && fs.readFileSync(${js(`${out}.pgid`)}, 'utf8').trim()) { process.kill(-d.pid, 'SIGTERM'); } else if (Date.now() - t0 < 60000) setTimeout(wait, 50); else { process.kill(-d.pid, 'SIGKILL'); } };
d.on('exit', (code) => { console.log(JSON.stringify({ advisorPgid: d.pid, code })); }); wait();`;
    const g = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const result = JSON.parse(g.stdout.trim().split('\n').at(-1));
    const pgid = Number(readFileSync(`${out}.pgid`, 'utf8')); const pid = Number(readFileSync(`${out}.pid`, 'utf8'));
    let alive = true; for (let k = 0; k < 40 && alive; k++) { try { process.kill(pid, 0); spawnSync('sleep', ['0.05']); } catch { alive = false; } }
    check(pgid === result.advisorPgid && !alive, js({ pgid, advisorPgid: result.advisorPgid, alive, g: g.stderr }));
  });

  // The worker context of an OMC team worker (the worker env, the plan from the tasks) and the journal path.
  it('(13) the OMC context: the worker env (OMC_TEAM_WORKER, OMC_TEAM_STATE_ROOT, OMC_TEAM_WORKTREE_PATH, OMC_TEAM_WORKER_CWD) goes into the prompt (worker, team, worktree, working directory); the plan from $OMC_TEAM_STATE_ROOT/tasks/*.json: only the task with owner = the short worker name and status in_progress, with the number in the line; a completed or foreign task is skipped; job_id in the journal = the worker', () => {
    const state = teamState('omc', [
      { id: '1', subject: 'write file a', description: 'test: node tests/x.mjs', status: 'in_progress', owner: 'worker-1' },
      { id: '2', subject: 'completed-task', description: 'x', status: 'completed', owner: 'worker-1' },
      { id: '3', subject: 'foreign-task', description: 'x', status: 'in_progress', owner: 'worker-2' },
    ]);
    const r = advisor({ OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_STATE_ROOT: state, OMC_TEAM_WORKTREE_PATH: '/wt-a', OMC_TEAM_WORKER_CWD: '/wt-a/dir' });
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr }));
    check(r.stdin.includes('WORKER CONTEXT:\nworker: team-a/worker-1\nteam: team-a\nworktree: /wt-a\nworking directory: /wt-a/dir'), js(r.stdin));
    check(r.stdin.includes('TASK PLAN FROM THE LEAD:\ntask 1: write file a: test: node tests/x.mjs\n') && !r.stdin.includes('completed-task') && !r.stdin.includes('foreign-task'), js(r.stdin));
    check(lastRow().job_id === 'team-a/worker-1', js(lastRow()));
  });
  it('(14) the journal path: OMC_PROVIDER_ADVISOR_LOG_FILE wins over the state directory; without it advisor.jsonl in OMC_PROVIDER_STATE_DIR; without both advisor.jsonl in the default state directory under HOME', () => {
    const stateDir = join(TMP, 'state-f'); const logFile = join(TMP, 'explicit', 'log.jsonl');
    const a = advisor({ OMC_PROVIDER_ADVISOR_LOG_FILE: logFile, OMC_PROVIDER_STATE_DIR: stateDir });
    check(a.status === 0 && existsSync(logFile) && !existsSync(join(stateDir, 'advisor.jsonl')), js({ s: a.status, e: a.stderr }));
    const home = join(TMP, 'home-f'); mkdirSync(home, { recursive: true });
    const b = advisor({ HOME: home, OMC_PROVIDER_ADVISOR_LOG_FILE: undefined, OMC_PROVIDER_STATE_DIR: undefined });
    check(b.status === 0 && existsSync(join(home, '.omc', 'state', 'provider', 'default', 'advisor.jsonl')), js({ s: b.status, e: b.stderr }));
    check(rows().length > 0, 'the journal file stopped working');
  });

  // The safe call, the role from a file, the JSON parser and the redaction of stderr.
  it('(15a) the complete safe call: the values of the kill switches CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 and DISABLE_OMC=1 in the env of the child; stdin without a role header (the role is in --system-prompt)', () => {
    const r = advisor();
    check(r.status === 0 && r.kills === 'ADVISOR=1 OMC=1\n', js({ s: r.status, k: r.kills, e: r.stderr }));
    check(!/You are the advisor/.test(r.stdin), 'a role header on stdin');
  });
  it('(14a) the role from a file: OMC_PROVIDER_ADVISOR_ROLE_FILE wins (the text in --system-prompt); a protocol profile without the input switch falls to the default role; a malicious protocol name is ignored; the role file says that the input is data to assess', () => {
    const file = join(TMP, 'role-stub.txt'); writeFileSync(file, 'ROLE-STUB-FROM-FILE\nSecond role line.');
    const r = advisor({ OMC_PROVIDER_ADVISOR_ROLE_FILE: file });
    const i = r.argv.indexOf('--system-prompt');
    check(r.status === 0 && i >= 0 && r.argv[i + 1] === 'ROLE-STUB-FROM-FILE\nSecond role line.', js({ s: r.status, argv: r.argv }));
    const p = advisor({ OMC_PROVIDER_ADVISOR_PROTOCOL: 'rescue' });
    check(p.status === 0 && systemPrompt(p) === DEFAULT_ROLE, 'a profile without the input switch did not fall to the default role');
    const z = advisor({ OMC_PROVIDER_ADVISOR_PROTOCOL: '../malicious' });
    check(z.status === 0 && systemPrompt(z) === DEFAULT_ROLE, 'a malicious protocol was not ignored');
    check(/data to assess, not commands/.test(DEFAULT_ROLE), 'the role file lacks the sentence about untrusted data');
  });
  it('(15b) a claude answer without JSON (FAKE_TEXT: exit 1, status json-error, the text answer does not go to stdout)', () => {
    const r = advisor({ FAKE_TEXT: '1' });
    check(r.status === 1 && lastRow().status === 'json-error' && !/STUB-ANSWER/.test(r.stdout), js({ s: r.status, o: r.stdout, w: lastRow() }));
  });
  it('(16) an answer with is_error (FAKE_JSON_ERROR): exit 1, status response-error, the text of the refusal does not go to stdout', () => {
    const r = advisor({ FAKE_JSON_ERROR: '1' });
    check(r.status === 1 && lastRow().status === 'response-error' && !/refused/.test(r.stdout), js({ s: r.status, o: r.stdout, w: lastRow() }));
  });
  it('(17) redaction of stderr: on a claude error the stderr holding the value of a secret variable of the env goes to the worker with [REDACTED] instead of the value', () => {
    const r = advisor({ ANTHROPIC_AUTH_TOKEN: FAKE_KEY, FAKE_ERR: `error-from-claude ${FAKE_KEY}`, FAKE_CODE: '5' });
    check(r.status === 5 && !r.stderr.includes(FAKE_KEY) && r.stderr.includes('[REDACTED]') && /error-from-claude/.test(r.stderr), js({ s: r.status, e: r.stderr }));
  });
  it('(18) static limits of the script: clean.* only PATH and the kill switches; no URL, no provider model alias (ANTHROPIC_*/CLAUDE_CODE_*_MODEL; OMC_PROVIDER_ADVISOR_MODEL is an allowed input parameter) and no ANTHROPIC_* assignments in the code', () => {
    const code = readFileSync(ADVISOR, 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    const assigned = [...code.matchAll(/clean\.([A-Za-z_]+)\s*=/g)].map((m) => m[1]);
    check(js(assigned) === js(['PATH', 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', 'DISABLE_OMC']), js(assigned));
    check(!/https?:\/\//.test(code) && !/\b(?:ANTHROPIC|CLAUDE_CODE)[A-Z_]*_MODEL\s*[=:]/.test(code) && !/clean\.ANTHROPIC_/.test(code), 'the code sets an address, a provider model alias or ANTHROPIC_*');
  });

  // ===== Shaped input (OMC_PROVIDER_ADVISOR_INPUT=1; off by default) =====
  it('(K1) on (OMC_PROVIDER_ADVISOR_INPUT=1): the full input: the template fields, the file a.go with numbers `number<TAB>code`, the git diff with the numbering of the new file, the journal with input_hash/size/files/shown/head/decision_chars; argv --model opus', () => {
    const wt = worktree();
    const r = advisor(inputOn(wt), [TEMPLATE_QUESTION]);
    const w = lastRow();
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr }));
    check(r.stdin.includes('WORKER QUESTION (question template):') && r.stdin.includes('DECISION: whether to push the fix to b.go') && r.stdin.includes('FILES: a.go'), js(r.stdin.slice(0, 400)));
    check(r.stdin.includes('=== file a.go (5 lines) ===') && r.stdin.includes('1\tline1') && r.stdin.includes('5\tline5'), js(r.stdin.slice(0, 400)));
    check(r.stdin.includes('TASK DIFF (git diff HEAD --stat):') && r.stdin.includes(' b.go | 3 ++-') && r.stdin.includes('=== diff file b.go ===') && r.stdin.includes('1\t+const x = 2;') && r.stdin.includes('2\t+const y = 3;'), js(r.stdin.slice(0, 800)));
    check(js(w.input_hash) === js(createHash('sha256').update(r.stdin).digest('hex')) && w.size === Buffer.byteLength(r.stdin) && w.decision_chars === 'whether to push the fix to b.go; if so, I will change the test, if not, I go back to the plan'.length, js({ hash: w.input_hash, size: w.size, dc: w.decision_chars }));
    check(js(w.shown['a.go']) === js([[1, 5]]) && js(w.shown['b.go']) === js([[1, 2]]), js(w.shown));
    const head = gitIn(wt, ['rev-parse', 'HEAD']).stdout.trim();
    check(js(w.files) === js(['b.go', 'a.go']) && w.head === head, js({ files: w.files, head: w.head, expectedHead: head }));
    check(r.argv.includes('--model') && r.argv[r.argv.indexOf('--model') + 1] === 'opus', js(r.argv));
  });
  it('(K2) a refusal of a question without the DECISION field (5 of 5 cases): exit 2, status refused-missing-decision in the journal, a message with the template, claude not called', () => {
    const bad = [
      'a plain question without fields',
      'TRIED: a\nHYPOTHESIS: b',
      'HYPOTHESIS: only a hypothesis',
      'DECISION:   \nTRIED: x',
      'decision: in lower case',
    ];
    for (const [k, p] of bad.entries()) {
      const r = advisor(inputOn(join(TMP, 'wt-1')), [p]);
      check(r.status === 2 && !r.called && lastRow().status === 'refused-missing-decision', `case ${k + 1}: ${js({ s: r.status, w: lastRow().status })}`);
      check(r.stderr.includes('DECISION:') && r.stderr.includes('FILES:'), `case ${k + 1}: the template in the message (${js(r.stderr.slice(0, 120))})`);
    }
  });
  it('(K3) a refusal of paths (4 of 4 plus a missing file): .credentials.json, a credential path of the session, a symlink leaving the worktree and ../ leaving the worktree: exit 2, status refused-path, no claude; a missing file (fail-closed)', () => {
    const wt = worktree();
    writeFileSync(join(wt, '.credentials.json'), '{}');
    symlinkSync(TMP, join(wt, 'escaped'));
    mkdirSync(join(TMP, 'shared'), { recursive: true });
    writeFileSync(join(TMP, 'shared', 'x.txt'), 'content\n');
    const stateDir = join(TMP, 'state-k3');
    const cases = [
      ['.credentials.json', 'credential pattern'],
      [join(stateDir, 'worker-settings', 'task-1.json'), 'credential pattern'], // a copy of the session settings (the pattern is built from OMC_PROVIDER_STATE_DIR)
      ['escaped', 'outside the worktree'],
      ['../shared/x.txt', 'outside the worktree'],
      ['missing.txt', 'inaccessible'],
    ];
    for (const [file, part] of cases) {
      const r = advisor(inputOn(wt, { OMC_PROVIDER_STATE_DIR: stateDir }), [TEMPLATE_QUESTION.replace('FILES: a.go', `FILES: ${file}`)]);
      check(r.status === 2 && !r.called && lastRow().status === 'refused-path' && r.stderr.includes(part), js({ file, s: r.status, e: r.stderr.slice(0, 140) }));
    }
  });
  it('(K4) off (no OMC_PROVIDER_ADVISOR_INPUT) = the old behaviour: a question without fields passes, no input section, the journal without metadata; on without a worktree: the no-worktree section, exit 0', () => {
    const r = advisor({}, ['a plain question without fields']);
    const w = lastRow();
    check(r.status === 0 && r.stdin.endsWith('WORKER QUESTION:\na plain question without fields\n') && !r.stdin.includes('TASK DIFF'), js({ s: r.status, i: r.stdin.slice(-120) }));
    check(!('input_hash' in w) && !('shown' in w), js(Object.keys(w)));
    const b = advisor({ OMC_PROVIDER_ADVISOR_INPUT: '1' }, [withoutFiles]);
    check(b.status === 0 && b.stdin.includes('TASK DIFF: no worktree'), js({ s: b.status, e: b.stderr.slice(0, 140), i: b.stdin?.slice(-160) }));
    const c = advisor(inputOn(join(TMP, 'no-wt')), [withoutFiles]);
    check(c.status === 0 && c.stdin.includes('TASK DIFF: reading the diff failed'), js({ s: c.status, e: c.stderr.slice(0, 140), i: c.stdin?.slice(-160) }));
  });
  it('(K5) budgets of named files: a file over the file budget drops out whole (OMITTED with the name and size), the file count limit (6), an omitted file has no shown ranges', () => {
    const wt = worktree();
    writeFileSync(join(wt, 'big.txt'), ('x'.repeat(99) + '\n').repeat(610));
    for (let i = 1; i <= 7; i++) writeFileSync(join(wt, `f${i}.txt`), `content${i}\n`);
    const r = advisor(inputOn(wt), [TEMPLATE_QUESTION.replace('FILES: a.go', 'FILES: big.txt f1.txt f2.txt f3.txt f4.txt f5.txt f6.txt f7.txt')]);
    const w = lastRow();
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(r.stdin.includes('big.txt (61000 B; over the file budget 50000 B)'), js(r.stdin.slice(-400)));
    check(r.stdin.includes('f7.txt (file count limit 6)'), js(r.stdin.slice(-400)));
    check(r.stdin.includes('=== file f1.txt') && !r.stdin.includes('=== file big.txt'), js(r.stdin.slice(-200)));
    check(!('big.txt' in w.shown) && !('f7.txt' in w.shown) && js(w.shown['f1.txt']) === js([[1, 1]]), js(Object.keys(w.shown)));
  });
  it('(K6) the hard cap of the input (OMC_PROVIDER_ADVISOR_CAP_INPUT=3000): the input not over the cap, trimming on whole lines with an [OMITTED lines] marker, partial shown ranges', () => {
    const wt = worktree();
    writeFileSync(join(wt, 'big2.txt'), (`${'z'.repeat(29)}\n`).repeat(400));
    const r = advisor(inputOn(wt, { OMC_PROVIDER_ADVISOR_CAP_INPUT: '3000' }), [TEMPLATE_QUESTION.replace('FILES: a.go', 'FILES: big2.txt')]);
    const w = lastRow();
    check(r.status === 0 && r.stdin.length <= 3000, js({ s: r.status, len: r.stdin.length }));
    check(r.stdin.includes('[OMITTED lines'), js(r.stdin.slice(-300)));
    const range = w.shown['big2.txt'][0];
    check(range[0] === 1 && range[1] < 400, js(w.shown));
    check(!r.stdin.includes('=== file a.go'), 'the file a.go of the FILES field was replaced by big2.txt');
  });
  it('(K7) material head plus tail (OMC_PROVIDER_ADVISOR_CAP_MATERIAL_HEAD/TAIL=100): a [TRIMMED] marker, the head and the tail present, the middle absent; on the boundary of whole lines', () => {
    const tail = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');
    const question = ['DECISION: material test', `TEST TAIL:\n${tail}`].join('\n');
    const r = advisor({ OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_PROVIDER_ADVISOR_CAP_MATERIAL_HEAD: '100', OMC_PROVIDER_ADVISOR_CAP_MATERIAL_TAIL: '100' }, [question]);
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(r.stdin.includes('[TRIMMED') && r.stdin.includes('line0') && r.stdin.includes('line199'), js(r.stdin.slice(0, 400)));
    check(!r.stdin.includes('line100') && !r.stdin.includes('line20\n') && !r.stdin.includes('\nline185'), 'the middle of the material is present');
  });
  it('(K8) a diff with a gap between hunks: the numbering of the new file, the gap marker [OMITTED lines 5-21], shown [[1,4],[22,28]]', () => {
    const wt = worktree();
    const lines = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
    writeFileSync(join(wt, 'c.go'), lines.join('\n') + '\n');
    gitIn(wt, ['add', 'c.go']);
    gitIn(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c']);
    lines[0] = 'C1-changed';
    lines[24] = 'C25-changed';
    writeFileSync(join(wt, 'c.go'), lines.join('\n') + '\n');
    const r = advisor(inputOn(wt), [withoutFiles]);
    const w = lastRow();
    check(r.status === 0 && r.stdin.includes('[OMITTED lines 5-21]'), js(r.stdin.slice(0, 600)));
    check(r.stdin.includes('1\t+C1-changed') && r.stdin.includes('22\t c22') && r.stdin.includes('25\t+C25-changed'), js(r.stdin.slice(0, 600)));
    check(js(w.shown['c.go']) === js([[1, 4], [22, 28]]), js(w.shown));
  });
  it('(K9) the diff of one file over the diff budget of a file (24 000 characters): OMITTED with the name and size, no embedding, no shown ranges', () => {
    const wt = worktree();
    writeFileSync(join(wt, 'd.go'), 'd1\n');
    gitIn(wt, ['add', 'd.go']);
    gitIn(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'd']);
    writeFileSync(join(wt, 'd.go'), Array.from({ length: 2600 }, (_, i) => `dd-line-${i}-xxxxxxxxxxxxxxxxxxxxxxxx`).join('\n') + '\n');
    const r = advisor(inputOn(wt), [TEMPLATE_QUESTION.replace('FILES: a.go', 'FILES: d.go')]);
    const w = lastRow();
    check(r.status === 0 && r.stdin.includes('over the diff budget of a file'), js(r.stdin.slice(-300)));
    check(!r.stdin.includes('=== diff file d.go ===') && !('d.go' in w.shown), js({ shown: Object.keys(w.shown) }));
  });
  it('(K11) static limits of the module advisor-input.cjs: no URL, no provider key, no key reads; a path refusal checks the credential pattern before realpath', () => {
    const code = readFileSync(join(dirname(ADVISOR), 'lib', 'advisor-input.cjs'), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    check(!/https?:\/\//.test(code) && !/readKey|keyHelper|key-helper|apiKey|baseUrl/.test(code), 'the module reaches for the network or a provider key');
    const w1 = require('../../../scripts/provider/lib/advisor-input.cjs').verifyPath('.credentials.json', TMP);
    check(w1.refusal && w1.refusal.includes('credential pattern'), js(w1));
  });

  // ===== Journal of explicit advice and cost (OMC_PROVIDER_ADVISOR_JOURNAL=1; off by default) =====
  const journalOn = (extra = {}) => ({ OMC_TEAM_WORKER: 'job-0002', OMC_PROVIDER_ADVISOR_JOURNAL: '1', ...extra });
  it('(J1) off (no OMC_PROVIDER_ADVISOR_JOURNAL): the old behaviour: argv stays the question in full (the --event flag does not exist with the journal off, so nothing is taken off), the old row shape, no protocol fields', () => {
    const r = advisor(journalOn({ OMC_PROVIDER_ADVISOR_JOURNAL: undefined }), ['--event', 'plan', 'question-after-flag-XYZ']);
    const w = lastRow();
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(r.stdin.endsWith('WORKER QUESTION:\n--event plan question-after-flag-XYZ\n'), js(r.stdin.slice(-120)));
    check(!('type' in w) && !('consultation_id' in w) && !('event' in w) && !('advice' in w), js(Object.keys(w)));
    const empty = advisor(journalOn({ OMC_PROVIDER_ADVISOR_JOURNAL: undefined, FAKE_EMPTY: '1' }), ['question']);
    check(empty.status === 0 && empty.stdout === '\n' && lastRow().status === 'ok', `an empty answer with the journal off: ${js({ s: empty.status, o: empty.stdout, st: lastRow().status })}`); // an empty answer on exit code 0 is stdout '\n' and status ok
    const refused = advisor(journalOn({ OMC_PROVIDER_ADVISOR_JOURNAL: undefined, FAKE_JSON_ERROR: 'limit' }), ['question']);
    check(refused.status === 1 && lastRow().status === 'response-error', `a rate-limit refusal with the switches off: ${js(lastRow().status)}`); // no rate-limit recognition with the switches off
  });
  it('(J2) on (OMC_PROVIDER_ADVISOR_JOURNAL=1): two rows (start + end), consultation_id job-0002#1 and number 1, task/worker, event plan, input metadata absent (a plain input), advice (full text), model_usage from modelUsage, cost/tokens; the second consultation is number 2', () => {
    const before = rows().length;
    const r = advisor(journalOn(), ['--event', 'plan', 'question-J2-first']);
    const all = rows();
    const start = all.at(-2);
    const end = all.at(-1);
    check(r.status === 0 && r.called && all.length === before + 2, js({ s: r.status, l: all.length, before }));
    check(start.type === 'start' && start.consultation_id === 'job-0002#1' && start.number === 1 && start.event === 'plan' && start.task === null && start.worker === 'job-0002', js(start));
    check(!('input_hash' in start) && !('token' in start), 'the input metadata on the start row with a plain input is absent');
    check(end.type === 'end' && end.consultation_id === 'job-0002#1' && end.number === 1 && end.event === 'plan' && end.status === 'ok' && end.advice === 'STUB-ANSWER: confirm' && end.cost_usd === 0.0042 && end.tokens_in === 120 && end.tokens_out === 45, js(end));
    check(js(end.model_usage) === js({ 'stub-model': { costUSD: 0.003, inputTokens: 100, outputTokens: 40 } }), js(end.model_usage));
    const r2 = advisor(journalOn(), ['--event', 'plan', 'question-J2-second']);
    const start2 = rows().at(-2);
    check(r2.status === 0 && start2.number === 2 && start2.consultation_id === 'job-0002#2', js({ number: start2.number, id: start2.consultation_id }));
  });
  it('(J3) the event is required with the protocol on: no flag and no env = exit 2, status refused-event, only an end row (no type and consultation_id), claude not called', () => {
    const r = advisor(journalOn(), ['question-without-event']);
    const w = lastRow();
    check(r.status === 2 && !r.called && w.status === 'refused-event' && !('type' in w) && !('consultation_id' in w), js({ s: r.status, w }));
    check(/--event/.test(r.stderr), js(r.stderr.slice(0, 200)));
  });
  it('(J4) event values: plan, test-failure with --failure-no 2 (failure_no in the rows), final, other pass; a value outside the list = exit 2 refused-event, also with the protocol off; the env OMC_PROVIDER_ADVISOR_EVENT as an alternative path', () => {
    for (const [e, extra] of [['plan', []], ['test-failure', ['--failure-no', '2']], ['final', []], ['other', []]]) {
      const r = advisor(journalOn(), ['--event', e, ...extra, 'question-J4']);
      const start = rows().at(-2);
      check(r.status === 0 && start.event === e && (e === 'test-failure' ? start.failure_no === 2 : !('failure_no' in start)), js({ e, s: r.status, start }));
    }
    const bad = advisor(journalOn(), ['--event', 'max', 'question']);
    check(bad.status === 2 && !bad.called && lastRow().status === 'refused-event', js({ s: bad.status, w: lastRow().status }));
    const bad2 = advisor(journalOn({ OMC_PROVIDER_ADVISOR_JOURNAL: undefined }), ['--event', 'bad-value', 'question']);
    check(bad2.status === 0 && bad2.called && bad2.stdin.endsWith('WORKER QUESTION:\n--event bad-value question\n'), `with the journal off argv stays the question: ${js({ s: bad2.status, i: bad2.stdin?.slice(-60) })}`);
    const fromEnv = advisor(journalOn({ OMC_PROVIDER_ADVISOR_EVENT: 'final' }), ['question-J4-env']);
    const startEnv = rows().at(-2);
    check(fromEnv.status === 0 && startEnv.event === 'final', js({ s: fromEnv.status, event: startEnv.event }));
  });
  it('(J5) a rate-limit refusal: stderr with too_many_requests on exit code 5 = status refused-limit (the code passes); a JSON is_error with rate-limit text = refused-limit (exit code 1)', () => {
    const a = advisor(journalOn({ FAKE_ERR: 'error-from-claude too_many_requests', FAKE_CODE: '5' }), ['--event', 'plan', 'question-D5a']);
    check(a.status === 5 && lastRow().status === 'refused-limit', js({ s: a.status, w: lastRow().status }));
    const b = advisor(journalOn({ FAKE_JSON_ERROR: 'limit' }), ['--event', 'plan', 'question-D5b']);
    check(b.status === 1 && lastRow().status === 'refused-limit', js({ s: b.status, w: lastRow().status }));
  });
  it('(J6) an empty answer on exit code 0 (the plain path): exit 0, empty stdout, status empty-answer-on-zero-exit, an end row without the advice field', () => {
    const r = advisor(journalOn({ FAKE_EMPTY: '1' }), ['--event', 'plan', 'question-J6']);
    const w = lastRow();
    check(r.status === 0 && r.stdout === '' && w.status === 'empty-answer-on-zero-exit' && !('advice' in w), js({ s: r.status, o: r.stdout, w }));
  });
  it('(J7) the verdict parser with the plan protocol and the journal: the input metadata and the token and diff_hash on the START row (not on the end row); the parser reason no-verdict = status no-verdict; the reason empty = empty-answer-on-zero-exit', () => {
    const wt = worktree();
    const env = inputOn(wt, journalOn({ OMC_PROVIDER_ADVISOR_PROTOCOL: 'plan' }));
    const r = advisor(env, ['--event', 'plan', TEMPLATE_QUESTION]);
    const start = rows().at(-2);
    const end = rows().at(-1);
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(start.type === 'start' && typeof start.input_hash === 'string' && start.input_hash.length === 64 && typeof start.token === 'string' && typeof start.head === 'string' && typeof start.diff_hash === 'string' && !('input_hash' in end), js({ start: Object.keys(start), end: Object.keys(end) }));
    check(js(start.input_hash) === js(createHash('sha256').update(r.stdin).digest('hex')) && js(start.shown['a.go']) === js([[1, 5]]), js(start.shown));
    check(js(start.diff_hash) === js(createHash('sha256').update(gitIn(wt, ['diff', 'HEAD']).stdout).digest('hex')), 'diff_hash = SHA-256 of git diff HEAD');
    const b = advisor({ ...env, FAKE_ANSWER_TOKEN: '1' }, ['--event', 'plan', TEMPLATE_QUESTION]);
    check(b.status === 0 && /ADVICE UNAVAILABLE \(no-verdict\)/.test(b.stdout) && lastRow().status === 'no-verdict', js({ s: b.status, o: b.stdout.slice(0, 120), w: lastRow().status }));
    const c = advisor({ ...env, FAKE_EMPTY: '1' }, ['--event', 'plan', TEMPLATE_QUESTION]);
    check(c.status === 0 && /ADVICE UNAVAILABLE \(empty\)/.test(c.stdout) && lastRow().status === 'empty-answer-on-zero-exit', js({ s: c.status, o: c.stdout.slice(0, 120), w: lastRow().status }));
  });
  it('(J8) redaction of secrets in the advice field: the value of a secret from the env in the advice text = [REDACTED] in the journal, the raw file without the secret; without a secret in the env the advice is untouched', () => {
    const r = advisor(journalOn({ ANTHROPIC_API_KEY: 'TOP-SECRET-VALUE-XYZ', FAKE_ANSWER: 'advice: set ANTHROPIC_API_KEY to TOP-SECRET-VALUE-XYZ and check' }), ['--event', 'plan', 'question-J8']);
    const w = lastRow();
    check(r.status === 0 && w.advice === 'advice: set ANTHROPIC_API_KEY to [REDACTED] and check', js({ w: w.advice }));
    check(!readFileSync(JOURNAL, 'utf8').includes('TOP-SECRET-VALUE-XYZ'), 'a secret in the journal');
  });
  it('(J9) appending from 4 parallel processes: 4 complete pairs (8 rows), all parsable, numbers 1-4 without collisions', () => {
    const before = rows().length;
    const env = { ...base(), OMC_TEAM_WORKER: 'parallel-1', OMC_PROVIDER_ADVISOR_JOURNAL: '1' };
    const script = `const { spawn } = require('node:child_process');
const procs = [0,1,2,3].map((i) => spawn(process.execPath, [${js(ADVISOR)}, '--event', 'plan', 'parallel-question-' + i], { env: { ...${js(env)}, FAKE_OUT: ${js(join(TMP, 'par'))} + '-' + i } }));
let ok = 0; let finished = 0;
for (const p of procs) p.on('exit', (code) => { finished++; if (code === 0) ok++; if (finished === 4) console.log(JSON.stringify({ ok, finished })); });`;
    const g = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...base(), OMC_PROVIDER_ADVISOR_JOURNAL: '1' } });
    const parallel = JSON.parse(g.stdout.trim().split('\n').at(-1));
    const after = rows();
    const starts = after.slice(before).filter((w) => w.type === 'start');
    const ends = after.slice(before).filter((w) => w.type === 'end');
    check(parallel.ok === 4, js(parallel) + ' ' + js(g.stderr.slice(0, 200)));
    check(starts.length === 4 && ends.length === 4, js({ starts: starts.length, ends: ends.length }));
    check(js(starts.map((w) => w.number).sort()) === js([1, 2, 3, 4]), js(starts.map((w) => w.number)));
    check(js([...new Set(after.slice(before).map((w) => w.consultation_id))].sort()) === js(['parallel-1#1', 'parallel-1#2', 'parallel-1#3', 'parallel-1#4']), js(after.slice(before).map((w) => w.consultation_id)));
  });
  it('(J10) permissions with the journal on: the journal file 0600, the directory 0700; manual retention (purge): advice older than 30 days removed, newer stays, the file still 0600, the second pass idempotent; retentionNeeded false against a fresh marker', () => {
    const dir = join(TMP, 'retention');
    const path = join(dir, 'advisor.jsonl');
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, [
      JSON.stringify({ type: 'start', ts: old, consultation_id: 'a#1', job_id: 'a', number: 1, event: 'plan' }),
      JSON.stringify({ type: 'end', ts: old, consultation_id: 'a#1', number: 1, event: 'plan', status: 'ok', advice: 'old-advice-to-remove' }),
      JSON.stringify({ type: 'start', ts: fresh, consultation_id: 'a#2', job_id: 'a', number: 2, event: 'plan' }),
      JSON.stringify({ type: 'end', ts: fresh, consultation_id: 'a#2', number: 2, event: 'plan', status: 'ok', advice: 'fresh-advice-stays' }),
    ].join('\n') + '\n');
    const purged = journalLib.purge(path, { days: 30 });
    const after = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check(purged.removed === 1 && purged.reviewed === 4, js(purged));
    check(!('advice' in after[1]) && after[1].status === 'ok', js(after[1]));
    check(after[3].advice === 'fresh-advice-stays', js(after[3].advice));
    check((statSync(path).mode & 0o777) === 0o600 && (statSync(dir).mode & 0o777) === 0o700, js([(statSync(path).mode & 0o777).toString(8), (statSync(dir).mode & 0o777).toString(8)]));
    check(journalLib.purge(path, { days: 30 }).removed === 0, 'the second pass is not idempotent');
    check(journalLib.retentionNeeded(path) === false, 'the marker is fresh after purge');
    // an existing file with 0644 gets 0600 after the write (chmod after the append)
    const dir2 = join(TMP, 'mode-0644'); const path2 = join(dir2, 'advisor.jsonl');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path2, JSON.stringify({ ts: new Date().toISOString(), status: 'ok' }) + '\n', { mode: 0o644 });
    const modeBefore = statSync(path2).mode & 0o777;
    check(modeBefore === 0o644, `preparation: the file is not 0644 (${modeBefore.toString(8)})`);
    process.env.OMC_PROVIDER_ADVISOR_JOURNAL = '1'; // appendRow with the lock and chmod 0600 after the write
    try { journalLib.appendRow(path2, { ts: new Date().toISOString(), status: 'ok' }, { secrets: [] }); } finally { delete process.env.OMC_PROVIDER_ADVISOR_JOURNAL; }
    check((statSync(path2).mode & 0o777) === 0o600, `a 0644 file after appendRow: ${(statSync(path2).mode & 0o777).toString(8)}`);
  });
  it('(J11) the summary read status(): pairs ok/timeout/empty, a refusal without an id, an orphaned start; counts, shares, cost, tokens, statuses and events; a missing file = zeros without throwing', () => {
    const path = join(TMP, 'read', 'advisor.jsonl');
    const now = Date.now();
    const t = () => new Date(now - 60_000).toISOString();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ type: 'start', ts: t(), consultation_id: 'z#1', job_id: 'z', number: 1, event: 'plan' }),
      JSON.stringify({ type: 'end', ts: t(), consultation_id: 'z#1', number: 1, event: 'plan', status: 'ok', cost_usd: 0.0042, tokens_in: 100, tokens_out: 50 }),
      JSON.stringify({ type: 'start', ts: t(), consultation_id: 'z#2', job_id: 'z', number: 2, event: 'plan' }),
      JSON.stringify({ type: 'end', ts: t(), consultation_id: 'z#2', number: 2, event: 'plan', status: 'timeout' }),
      JSON.stringify({ type: 'start', ts: t(), consultation_id: 'z#3', job_id: 'z', number: 3, event: 'plan' }),
      JSON.stringify({ type: 'end', ts: t(), consultation_id: 'z#3', number: 3, event: 'final', status: 'empty-answer-on-zero-exit', cost_usd: 0.0028, tokens_in: 60, tokens_out: 0 }),
      JSON.stringify({ ts: t(), job_id: 'z', status: 'refused-path' }),
      JSON.stringify({ type: 'start', ts: t(), consultation_id: 'z#4', job_id: 'z', number: 4, event: 'plan' }),
    ].join('\n') + '\n');
    const stat = journalLib.status({ path, windowHours: 5, now });
    check(stat.consultations_total === 5 && stat.delivered === 1 && stat.errors === 1 && stat.advice_unavailable === 1 && stat.refusals === 1, js(stat));
    check(stat.orphaned === 1 && stat.delivered_pct === 20 && stat.refusals_pct === 20 && stat.errors_pct === 20 && stat.advice_unavailable_pct === 20, js(stat));
    check(Math.abs(stat.cost_usd_total - 0.007) < 1e-9, js(stat.cost_usd_total));
    check(js(stat.tokens_in_total) === js(160) && js(stat.tokens_out_total) === js(50), js({ in: stat.tokens_in_total, out: stat.tokens_out_total }));
    check(js(stat.statuses) === js({ ok: 1, timeout: 1, 'empty-answer-on-zero-exit': 1, 'refused-path': 1 }), js(stat.statuses));
    check(js(stat.events) === js({ plan: 2, final: 1 }), js(stat.events));
    const none = journalLib.status({ path: join(TMP, 'read', 'missing.jsonl'), windowHours: 5, now });
    check(none.consultations_total === 0 && none.orphaned === 0 && none.cost_usd_total === 0, js(none));
  });
  // ===== Review corrections: lock, shown from the finished prompt, diff base and untracked files, diff parsing, field parsing, secret scan, canonical statuses =====
  it('(J13) the lock: an empty lock from an hour ago does not block a write (taken over by age from statSync), the lock is removed after the operation; an unparsable lock content is taken over too', () => {
    const dir = join(TMP, 'lock-d13');
    const path = join(dir, 'advisor.jsonl');
    mkdirSync(dir, { recursive: true });
    const lock = `${path}.lock`;
    writeFileSync(lock, ''); // empty
    spawnSync('touch', ['-d', new Date(Date.now() - 3600_000).toISOString(), lock], { encoding: 'utf8' }); // an mtime from an hour ago (takeover by age)
    const result = journalLib.withLock(path, () => 'ok');
    check(result === 'ok', 'the operation under an empty lock from an hour ago did not pass');
    check(!existsSync(lock), 'the lock was not removed after the operation');
    writeFileSync(lock, 'not-json'); // an unparsable content, an mtime from an hour ago: taken over by age
    spawnSync('touch', ['-d', new Date(Date.now() - 3600_000).toISOString(), lock], { encoding: 'utf8' });
    const result2 = journalLib.withLock(path, () => 'ok2');
    check(result2 === 'ok2' && !existsSync(lock), 'the operation under an unparsable lock from an hour ago did not pass');
  });
  it('(K12) the hard cap of the input recomputes meta.shown from the FINISHED prompt: a cap just below the sum, every line of shown is present in the prompt as `number<TAB>` in the section of the right file', () => {
    const wt = worktree();
    for (let i = 1; i <= 6; i++) writeFileSync(join(wt, `p${i}.txt`), Array.from({ length: 40 }, (_, k) => `p${i}-line-${k}`).join('\n') + '\n');
    gitIn(wt, ['add', 'p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt', 'p6.txt']); // tracked, so they do not also enter as untracked
    const r = advisor(inputOn(wt, { OMC_PROVIDER_ADVISOR_CAP_INPUT: '7900', OMC_PROVIDER_ADVISOR_CAP_DIFF_FILE: '5000', OMC_PROVIDER_ADVISOR_CAP_FILES_TOTAL: '40000' }), [TEMPLATE_QUESTION.replace('FILES: a.go', 'FILES: p1.txt p2.txt p3.txt p4.txt p5.txt p6.txt')]);
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    const w = lastRow();
    const shownFromMeta = Object.entries(w.shown);
    check(shownFromMeta.length > 0, 'meta.shown is empty (the cap is too low: pick the test data)');
    const filePattern = /^=== (?:file|diff file) (.+?)(?: \([^)]*\))? ===$/;
    const numbersInPrompt = {};
    let current = null;
    for (const line of r.stdin.split('\n')) {
      const m = filePattern.exec(line);
      if (m) { current = m[1]; continue; }
      const num = /^(\d+)\t/.exec(line);
      if (num && current) (numbersInPrompt[current] ||= []).push(Number(num[1]));
    }
    for (const [file, ranges] of shownFromMeta) {
      const expected = [];
      for (const [a, b] of ranges) for (let i = a; i <= b; i++) expected.push(i);
      // a file may be embedded twice (in the diff after git add and in the named files), so the sets of numbers are compared
      const unique = [...new Set(numbersInPrompt[file] || [])].sort((a, b) => a - b);
      check(js(unique) === js(expected), `file ${file}: shown ${js(ranges)} vs unique lines in the prompt ${js(unique.length)}`);
    }
  });
  it('(K13) the diff base OMC_PROVIDER_ADVISOR_DIFF_BASE and untracked files: the worker commit and a new untracked file are visible (the diff against HEAD is empty, the untracked file embedded with numbers and in shown); with the start ref of the task the diff shows the task changes', () => {
    const wt = worktree();
    writeFileSync(join(wt, 'c.txt'), 'new-task-result\nsecond line\n'); // an untracked file
    gitIn(wt, ['add', 'b.go']);
    gitIn(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'worker work']); // the commit of a task change
    const r = advisor(inputOn(wt), [withoutFiles]);
    const w = lastRow();
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(r.stdin.includes('UNTRACKED FILES (embedded by the script):') && r.stdin.includes('=== file c.txt (untracked, 2 lines) ===') && r.stdin.includes('1\tnew-task-result'), js(r.stdin.slice(-400)));
    check(js(w.shown['c.txt']) === js([[1, 2]]), js(w.shown));
    check(r.stdin.includes('the diff against HEAD is empty (changes are committed'), js(r.stdin.slice(-400)));
    const startRef = gitIn(wt, ['rev-parse', 'HEAD~1']).stdout.trim();
    const r2 = advisor(inputOn(wt, { OMC_PROVIDER_ADVISOR_DIFF_BASE: startRef }), [withoutFiles]);
    check(r2.status === 0 && r2.stdin.includes('=== diff file b.go ===') && r2.stdin.includes('TASK DIFF (git diff'), js(r2.stdin.slice(0, 800)));
  });
  it('(K14) parseDiff: the marker `\\ No newline at end of file` has no number and is not in shown (a 3-line file = shown [1,2,3]); a diff row `+++ b/bad` as the content of an added line does not replace the file name and the numbering does not shift', () => {
    const inputLib = require('../../../scripts/provider/lib/advisor-input.cjs');
    const diff1 = [
      'diff --git a/x b/x', 'index 111..222 100644', '--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@',
      ' a', '-b', '\\ No newline at end of file', '+B', ' c',
    ].join('\n');
    const p1 = inputLib.parseDiff(diff1);
    check(p1.length === 1 && p1[0].file === 'x' && p1[0].hunks.length === 1 && p1[0].hunks[0].lines.filter((l) => l.sign === '\\').length === 0, js(p1));
    const e1 = inputLib.embedDiffFile(p1[0], 100_000);
    check(js(e1.shownNumbers) === js([1, 2, 3]), js(e1.shownNumbers));
    check(!e1.lines.some((l) => l.includes('No newline')), js(e1.lines));
    const diff2 = [
      'diff --git a/good b/good', 'index 111..222 100644', '--- a/good', '+++ b/good', '@@ -1,2 +1,3 @@',
      ' first', '++++ b/bad', ' third',
    ].join('\n');
    const p2 = inputLib.parseDiff(diff2);
    check(p2.length === 1 && p2[0].file === 'good', js(p2));
    const e2 = inputLib.embedDiffFile(p2[0], 100_000);
    check(js(e2.shownNumbers) === js([1, 2, 3]) && e2.lines.some((l) => l.includes('++ b/bad')), js(e2.lines));
  });
  it('(K15) parseFields: only the fields of the template start a field, text before the first field = the QUESTION field, rows FAIL:/ERROR: stay as the content of the field', () => {
    const inputLib = require('../../../scripts/provider/lib/advisor-input.cjs');
    const result = inputLib.parseFields('Why does the test fail?\nDECISION: x\nTEST TAIL: a\nFAIL: TestX\nERROR: boom\nFILES: a.go');
    check(result.fields.QUESTION === 'Why does the test fail?' && result.fields.DECISION === 'x' && result.fields['TEST TAIL'] === 'a\nFAIL: TestX\nERROR: boom' && result.fields.FILES === 'a.go', js(result.fields));
    check(js(result.order) === js(['QUESTION', 'DECISION', 'TEST TAIL', 'FILES']), js(result.order));
    const none = inputLib.parseFields('DECISION: x\nUnknown: field');
    check('Unknown' in none.fields === false && /Unknown: field/.test(none.fields.DECISION), js(none.fields));
  });
  it('(K16) the secret scan: a diff with a secret pattern is omitted (suspected secret in the diff), a named file with a secret is omitted, advice with an sk- key goes to stdout redacted', () => {
    const wt = worktree();
    writeFileSync(join(wt, 'g.go'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n'); // AKIA + 16 characters
    gitIn(wt, ['add', 'g.go']);
    gitIn(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'g']);
    writeFileSync(join(wt, 'g.go'), 'const key = "AKIAIOSFODNN7ROTATE1";\n'); // a new diff change with AKIA + 16 characters
    const r = advisor(inputOn(wt, { FAKE_ANSWER: 'advice: the key sk-abcdef0123456789abcdef0123456789 needs rotation' }), [TEMPLATE_QUESTION.replace('FILES: a.go', 'FILES: g.go')]);
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr.slice(0, 160) }));
    check(!r.stdout.includes('sk-abcdef0123456789') && r.stdout.includes('[REDACTED]'), js(r.stdout.slice(0, 200)));
    const w = lastRow();
    check(!r.stdin.includes('AKIAIOSFODNN7') && r.stdin.includes('suspected secret'), js({ inDiff: r.stdin.includes('AKIAIOSFODNN7'), secret: r.stdin.includes('suspected secret') }));
    check(!('g.go' in w.shown), js(Object.keys(w.shown)));
  });
  it('(K17) canonical statuses: every status literal in the finish() calls of the script belongs to STATUSES of the journal module', () => {
    const code = readFileSync(ADVISOR, 'utf8');
    const vocabKeys = Object.keys(require('../../../scripts/provider/lib/vocab.cjs').ADVISOR_STATUSES);
    const literals = [...code.matchAll(/finish\(\s*\d+,\s*S\.([A-Z_]+)/g)].map((m) => m[1]);
    check(literals.length >= 15, `too few status literals found: ${literals.length}`);
    const outside = literals.filter((x) => !vocabKeys.includes(x));
    check(outside.length === 0, `statuses outside the vocabulary: ${js(outside)}`);
    const values = Object.values(require('../../../scripts/provider/lib/vocab.cjs').ADVISOR_STATUSES);
    check(values.every((v) => journalLib.STATUSES.includes(v)), 'a vocabulary status is missing in STATUSES of the journal module');
    check(journalLib.STATUSES.includes('no-role') && journalLib.STATUSES.includes('stop') && journalLib.STATUSES.includes('limit-error'), 'no-role, stop, limit-error in STATUSES');
  });
  it('(K18) the worker rule: worker-rule.md holds the words DECISION and --event and TOKEN: (the template fields and the event parameter once the shaped input mode is on)', () => {
    const rule = readFileSync(join(dirname(ROLE_TEMPLATE), 'worker-rule.md'), 'utf8');
    check(rule.includes('DECISION') && rule.includes('--event') && rule.includes('TOKEN:'), 'the rule lacks DECISION/--event/TOKEN');
  });

  // A foreign address in the input, the advisor model parameter, the advisor shim and the missing role file.
  it('(19) a foreign ANTHROPIC_BASE_URL in the incoming env: exit 2 before the env clearing and before the claude start (the fake not called), a refused-env row; an anthropic.com address passes', () => {
    const r = advisor({ ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic' });
    check(r.status === 2 && !r.called && lastRow().status === 'refused-env', js({ s: r.status, e: r.stderr, w: lastRow() }));
    const a = advisor({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    check(a.status === 0 && a.called, js({ s: a.status, e: a.stderr }));
  });
  it('(20) OMC_PROVIDER_ADVISOR_MODEL: sonnet and FABLE go to --model and to the journal row (trim, case-insensitive), none = opus, a wrong value: exit 2, the fake not called, a bad-model row', () => {
    const s = advisor({ OMC_PROVIDER_ADVISOR_MODEL: ' sonnet ' });
    check(s.status === 0 && s.argv[s.argv.indexOf('--model') + 1] === 'sonnet' && lastRow().model === 'sonnet', js({ s: s.status, m: lastRow().model, e: s.stderr }));
    const f = advisor({ OMC_PROVIDER_ADVISOR_MODEL: 'FABLE' });
    check(f.status === 0 && f.argv[f.argv.indexOf('--model') + 1] === 'fable' && lastRow().model === 'fable', js({ s: f.status, m: lastRow().model }));
    const d = advisor({});
    check(d.argv[d.argv.indexOf('--model') + 1] === 'opus' && lastRow().model === 'opus', js({ d: d.argv?.slice(0, 3), m: lastRow().model })); // fable is never the default: the default is opus
    const z = advisor({ OMC_PROVIDER_ADVISOR_MODEL: 'bogus' });
    check(z.status === 2 && !z.called && /opus, sonnet, fable/.test(z.stderr) && lastRow().status === 'bad-model', js({ s: z.status, e: z.stderr, w: lastRow() }));
    const maxRun = advisor({ OMC_PROVIDER_ADVISOR_MODEL: 'max' }, ['question']); // the forbidden "max" is refused too
    check(maxRun.status === 2 && !maxRun.called && lastRow().status === 'bad-model' && /disallowed/.test(maxRun.stderr), js({ s: maxRun.status, e: maxRun.stderr.slice(0, 140) }));
  });
  it('(21) the advisor shim (the settings library, the exec body) passes OMC_PROVIDER_ADVISOR_MODEL unchanged to the advisor script', () => {
    const settings = require('../../../scripts/provider/lib/settings.cjs');
    const profile = { name: 'acme', shimNames: [], stateDir: join(TMP, 'state-shim'), advisor: { commandName: 'provider-advisor' } };
    const dir = settings.installShims(profile, { ...base(), OMC_PROVIDER_SHIM_DIR: join(TMP, 'shim-advisor') }, { target: ADVISOR, extra: { 'provider-advisor': ADVISOR } });
    const out = join(TMP, 'w-shim');
    const r = spawnSync(join(dir, 'provider-advisor'), ['question via the shim'], { encoding: 'utf8', env: { ...base(), FAKE_OUT: out, OMC_PROVIDER_ADVISOR_MODEL: 'sonnet' } });
    const argv = existsSync(`${out}.argv`) ? JSON.parse(readFileSync(`${out}.argv`, 'utf8')) : null;
    check(r.status === 0 && argv && argv[argv.indexOf('--model') + 1] === 'sonnet', js({ s: r.status, argv, e: r.stderr }));
  });
  it('(22) a copy of the script tree without the role template: exit 2, the fake not called, a no-role row; the message names the missing role file', () => {
    const copy = join(TMP, 'no-role');
    cpSync(dirname(ADVISOR), join(copy, 'scripts', 'provider'), { recursive: true });
    const out = join(TMP, 'w-no-role');
    const r = spawnSync(process.execPath, [join(copy, 'scripts', 'provider', 'provider-advisor.cjs'), 'question'], { encoding: 'utf8', env: { ...base(), FAKE_OUT: out } });
    check(r.status === 2 && !existsSync(`${out}.argv`) && /no role file/.test(r.stderr) && lastRow().status === 'no-role', js({ s: r.status, e: r.stderr, w: lastRow() }));
  });

  // ===== Profile configuration of the advisor (new cases: the settings come from the profile, not from constants) =====
  it('(N1) the profile supplies the advisor settings: advisor.claudeBinary, advisor.roleFile, advisor.defaultModel and advisor.commandName (in the usage message) are used when the profile named by OMC_PROVIDER is found', () => {
    const roleFile = join(TMP, 'profile-role.txt'); writeFileSync(roleFile, 'ROLE-FROM-THE-PROFILE');
    const { env } = writeProfile(join(TMP, 'profile-n1'), { advisor: { claudeBinary: FAKE, roleFile, defaultModel: 'sonnet', commandName: 'ask-advisor' } });
    const r = advisor({ ...env, OMC_PROVIDER: 'acme', OMC_PROVIDER_ADVISOR_CLAUDE_BIN: undefined });
    check(r.status === 0 && r.called && systemPrompt(r) === 'ROLE-FROM-THE-PROFILE' && r.argv[r.argv.indexOf('--model') + 1] === 'sonnet', js({ s: r.status, e: r.stderr, argv: r.argv?.slice(0, 3) }));
    const usage = advisor({ ...env, OMC_PROVIDER: 'acme' }, [], { input: '' });
    check(usage.status === 2 && /usage: ask-advisor/.test(usage.stderr), js(usage.stderr));
  });
  it('(N2) without a profile the advisor works on the defaults (opus, the default role template, the default command name) and the first non-shim claude on PATH is used when no binary is configured', () => {
    const bin = join(TMP, 'path-bin'); mkdirSync(bin, { recursive: true });
    const onPath = join(bin, 'claude'); writeFileSync(onPath, readFileSync(FAKE, 'utf8'), { mode: 0o755 }); chmodSync(onPath, 0o755);
    const r = advisor({ OMC_PROVIDER_ADVISOR_CLAUDE_BIN: undefined, PATH: `${bin}:${process.env.PATH}` });
    check(r.status === 0 && r.called && systemPrompt(r) === DEFAULT_ROLE && r.argv[r.argv.indexOf('--model') + 1] === 'opus', js({ s: r.status, e: r.stderr }));
    const none = advisor({ OMC_PROVIDER_ADVISOR_CLAUDE_BIN: undefined, PATH: join(TMP, 'empty-path') });
    check(none.status === 127 && lastRow().status === 'no-binary' && /none found on PATH/.test(none.stderr), js({ s: none.status, e: none.stderr }));
  });
});
