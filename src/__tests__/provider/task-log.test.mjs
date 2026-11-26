/* global process, URL */
// Task journal of provider tasks (provider-task-log.cjs), all on synthetic data in a temp directory: the task file
// <state>/tasks/<id>.json, rows of <state>/workers.jsonl (point team-worker), a transcript
// <HOME>/.claude/projects/<dir>/<sid>.jsonl and <state>/advisor.jsonl. Covered: 10 synthetic tasks = 10 rows with a
// non-empty model and tokens; turns match the transcript (every task); a mismatching model = model_mismatch; the row
// has no task text, paths or secrets (the secret fixture of the transcript disappears); a second writeRow of the same id
// appends nothing; rotation at a small threshold through OMC_PROVIDER_TASK_LOG_ROTATE_BYTES; the switch
// OMC_PROVIDER_TASK_LOG=off; require of the module without side effects. The git fake goes through OMC_PROVIDER_TASK_GIT_BIN.
// The fixture profile sets contextWindow 1000000, the window of the models of the fixture provider.
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const TASK_LOG = fileURLToPath(new URL('../../../scripts/provider/provider-task-log.cjs', import.meta.url));
const SECRET = 'sk-ant-api03-SECRETFORTESTS-123456789012345678901234';

describe.skipIf(process.platform === 'win32')('provider task journal', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-tasklog-'); });
  afterAll(() => { tmp.cleanup(); });

  let counter = 0;
  // One case: a profile with its own state dir (contextWindow 1000000), the HOME with transcripts, a journal env.
  const fixture = (extraEnv = {}) => {
    const dir = join(tmp.dir, `case-${++counter}`);
    mkdirSync(dir, { recursive: true });
    const { env, profile } = writeProfile(dir, { contextWindow: 1000000 });
    const state = join(dir, 'state');
    return { dir, state, env: { ...env, ...extraEnv }, profile };
  };
  const logModule = () => require(TASK_LOG);

  // Builds one synthetic task in the fixture: the task file, rows of workers.jsonl (appended: there may be more tasks), the transcript, advisor.jsonl.
  const buildTask = (f, {
    turns = 3, text = true, model = 'acme-small[1m]', ordered = 'haiku', status = 'success',
    startAgoS = 60, intervalTsMs = 1000, secret = false, consultations = 0,
  } = {}) => {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    const team = `ptask-${id}`;
    const sid = randomUUID();
    mkdirSync(join(f.state, 'tasks'), { recursive: true });
    const projectDir = join(f.dir, 'home', '.claude', 'projects', 'project-x');
    mkdirSync(projectDir, { recursive: true });
    const start = new Date(Date.now() - startAgoS * 1000).toISOString();
    const endTs = new Date(Date.now() - (startAgoS - 10) * 1000).toISOString();
    writeFileSync(join(f.state, 'tasks', `${id}.json`), JSON.stringify({ id, team, start, cwd: f.dir, verdict: { status } }) + '\n');
    const rows = [
      { ts: start, point: 'team-worker', role: 'executor', name: `${team}/executor`, team, provider: 'acme', session_id: sid, started_with: { model: ordered, effort: 'high' } },
      { ts: endTs, point: 'team-worker', name: `${team}/executor`, team, result: 'end', exit_code: status === 'success' ? 0 : 1, ...(status === 'success' ? {} : { class: 'other' }) },
    ];
    appendFileSync(join(f.state, 'workers.jsonl'), rows.map((w) => JSON.stringify(w)).join('\n') + '\n');
    const lines = [];
    for (let i = 0; i < turns; i++) {
      const ts = new Date(Date.parse(start) + (i + 1) * intervalTsMs).toISOString();
      const toolId = `toolu-${id}-${i}`;
      const hasBash = i < turns - 1;
      const content = text ? [{ type: 'text', text: `work result ${i}` }] : [];
      lines.push(JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 1000 + i, output_tokens: 100 + i, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 }, content: hasBash ? [...content, { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo x' } }] : content }, timestamp: ts }));
      if (hasBash) lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: i === 0, content: secret && i === 0 ? `output ${SECRET}` : 'output' }] }, toolUseResult: { returnCode: i === 0 ? 2 : 0 }, timestamp: new Date(Date.parse(ts) + 100).toISOString() }));
    }
    writeFileSync(join(projectDir, `${sid}.jsonl`), lines.join('\n') + '\n');
    if (consultations > 0) appendFileSync(join(f.state, 'advisor.jsonl'), Array.from({ length: consultations }, () => [JSON.stringify({ ts: start, type: 'start', job_id: `${team}/executor`, question_chars: 10 }), JSON.stringify({ ts: start, type: 'end', job_id: `${team}/executor`, question_chars: 10, answer_chars: 20, status: 'ok', duration_ms: 1000 })].join('\n')).concat(consultations > 0 ? [JSON.stringify({ ts: start, type: 'cache', job_id: `${team}/executor` })] : []).join('\n') + '\n');
    return { id, team, sid, projectDir };
  };

  // Fake git (OMC_PROVIDER_TASK_GIT_BIN): rev-parse per scenario, merge-base prints a sha, diff per GIT_SCENARIO (empty|changes|none).
  const fakeGit = (f) => {
    const p = join(f.dir, 'git-fake.cjs');
    writeFileSync(p, [`#!${process.execPath}`,
      'const args = process.argv.slice(2);',
      "const s = process.env.GIT_SCENARIO || 'changes';",
      "if (args[0] === 'rev-parse') process.exit(s === 'none' ? 1 : 0);",
      "if (args[0] === 'merge-base') { console.log('0123456789abcdef0123456789abcdef01234567'); process.exit(0); }",
      "if (args[0] === 'diff') { if (s === 'empty') process.exit(0); console.log(' 3 files changed, 120 insertions(+), 45 deletions(-)'); process.exit(0); }",
      'process.exit(1);',
    ].join('\n') + '\n', { mode: 0o755 });
    return p;
  };

  const readRows = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Transcript lines in the shape of a real session (model without the [1m] suffix, a <synthetic> API error row, Bash results without toolUseResult.returnCode).
  const assistantLine = (ts, model, usage, content, id) => JSON.stringify({ type: 'assistant', message: { ...(id ? { id } : {}), model, usage, content }, timestamp: ts });
  const resultLine = (ts, content, extra = {}) => JSON.stringify({ type: 'user', message: { content }, timestamp: ts, ...extra });
  const skeleton = (f, opts = {}) => buildTask(f, { turns: 0, ...opts });

  it('(1) require of the module without side effects: the exports and an empty state after the require', () => {
    const f = fixture();
    const script = join(f.dir, 'tl-require.cjs');
    writeFileSync(script, 'const m = require(process.argv[2]); console.log(JSON.stringify(Object.keys(m).sort()));');
    const r = spawnSync(process.execPath, [script, TASK_LOG], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, 0, `exit code ${r.status}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout.trim()), ['resultHeader', 'taskRow', 'writeRow']);
    assert.ok(!existsSync(f.state), 'the require created the state directory');
  });

  it('(2) 10 synthetic tasks = 10 rows with a non-empty model and tokens; turns, bash, code, consultations, window, duration', () => {
    const f = fixture();
    const { taskRow } = logModule();
    for (let i = 0; i < 10; i++) {
      const turns = 1 + (i % 5);
      const z = buildTask(f, { turns, consultations: i === 2 ? 2 : 0 });
      const w = taskRow(z.id, { env: f.env, git: false });
      assert.ok(w, `no row for ${z.id}`);
      assert.equal(w.id, z.id);
      assert.equal(w.team, z.team);
      assert.equal(w.session_id, z.sid);
      assert.ok(w.model_ordered, 'empty ordered model');
      assert.ok(w.model_used, `empty used model (${z.id})`);
      assert.ok(w.tokens_in > 0 && w.tokens_out > 0 && w.tokens_cache > 0, `empty tokens (${z.id})`);
      assert.equal(w.turns, turns, `turns (${z.id})`);
      assert.equal(w.status, 'success');
      assert.ok(w.window_percent > 0 && w.window_percent < 1, 'window_percent');
      assert.ok(w.duration_s >= 1, 'duration_s');
      if (i === 2) {
        assert.equal(w.bash_calls, 2, 'bash calls');
        assert.equal(w.bash_failures, 1, 'bash failures');
        assert.equal(w.bash_last_code, 0, 'code of the last bash');
        assert.equal(w.consultations, 2, 'consultations');
      }
    }
  });

  it('(3) a task with an empty result: a status other than done/success and the empty_response warning', () => {
    const f = fixture();
    const env = { ...f.env, OMC_PROVIDER_TASK_GIT_BIN: fakeGit(f), GIT_SCENARIO: 'empty' };
    const { taskRow } = logModule();
    const z = buildTask(f, { text: false, status: 'empty_response' });
    const w = taskRow(z.id, { env });
    assert.equal(w.status, 'empty_response');
    assert.ok(!['done', 'success'].includes(w.status));
    assert.ok(w.warnings.includes('empty_response'), 'no empty_response');
    assert.ok(!w.warnings.includes('success_without_changes'), 'success_without_changes outside success');
  });

  it('(4) a mismatching model: model_mismatch in warnings; a matching one is not flagged', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const a = buildTask(f, { model: 'claude-sonnet-4-5' });
    const wa = taskRow(a.id, { env: f.env, git: false });
    assert.ok(wa.warnings.includes('model_mismatch'), 'no model_mismatch');
    const b = buildTask(f, {});
    const wb = taskRow(b.id, { env: f.env, git: false });
    assert.ok(!wb.warnings.includes('model_mismatch'), 'a matching model flagged as mismatching');
  });

  it('(5) a very short run: very_short_run below 45 s; a longer one has no warning', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const short = buildTask(f, { startAgoS: 20, intervalTsMs: 5000, turns: 3 }); // the last ts ~15 s from the start
    const ws = taskRow(short.id, { env: f.env, git: false });
    assert.ok(ws.duration_s < 45, 'the duration is not short');
    assert.ok(ws.warnings.includes('very_short_run'), 'no very_short_run');
    const long = buildTask(f, { startAgoS: 80, intervalTsMs: 25000, turns: 4 }); // the last ts ~75 s from the start
    const wl = taskRow(long.id, { env: f.env, git: false });
    assert.ok(wl.duration_s >= 45, 'the duration is not long');
    assert.ok(!wl.warnings.includes('very_short_run'), 'a warning for a long run');
  });

  it('(6) the row and the header without task text, paths and secrets; the fields in order', () => {
    const f = fixture();
    const { taskRow, writeRow, resultHeader } = logModule();
    const z = buildTask(f, { secret: true, consultations: 1 });
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(writeRow(z.id, { env: f.env, git: false }), true);
    const content = readFileSync(join(f.state, 'tasks.jsonl'), 'utf8');
    assert.ok(!content.includes('SECRETFORTESTS'), 'a secret in the written row');
    assert.ok(!content.includes(f.dir), 'a temp path in the written row');
    assert.ok(!content.includes('.claude'), 'a .claude path in the written row');
    assert.ok(!content.includes('work result'), 'answer text in the row');
    const written = JSON.parse(content.trim());
    assert.equal(written.consultations, 1);
    assert.deepEqual(Object.keys(written).slice(0, 19), ['id', 'team', 'session_id', 'start', 'duration_s', 'status', 'model_ordered', 'model_used', 'tokens_in', 'tokens_out', 'tokens_cache', 'window_percent', 'turns', 'bash_calls', 'bash_failures', 'bash_last_code', 'consultations', 'warnings', 'class'], 'order of the fields');
    const header = resultHeader(w);
    assert.ok(!header.includes('SECRETFORTESTS') && !header.includes(f.dir), 'a secret or a path in the header');
    assert.ok(!/est\.?\s*cost|opus|git clean/i.test(header), 'forbidden phrases in the header');
    assert.ok(header.includes('task ') && header.includes('model:') && header.includes('tokens:'), 'a header without fields');
  });

  it('(7) a second writeRow of the same id appends nothing', () => {
    const f = fixture();
    const { writeRow } = logModule();
    const z = buildTask(f, {});
    assert.equal(writeRow(z.id, { env: f.env, git: false }), true);
    const file = join(f.state, 'tasks.jsonl');
    assert.equal(readRows(file).length, 1);
    assert.equal(writeRow(z.id, { env: f.env, git: false }), false);
    assert.equal(readRows(file).length, 1);
  });

  it('(8) rotation at a small threshold (OMC_PROVIDER_TASK_LOG_ROTATE_BYTES=400) to tasks.jsonl.1', () => {
    const f = fixture();
    const { writeRow } = logModule();
    const a = buildTask(f, {});
    assert.equal(writeRow(a.id, { env: f.env, git: false }), true);
    const file = join(f.state, 'tasks.jsonl');
    const size = statSync(file).size;
    assert.ok(size >= 400, `a row too small for rotation: ${size} B`);
    const b = buildTask(f, {});
    assert.equal(writeRow(b.id, { env: { ...f.env, OMC_PROVIDER_TASK_LOG_ROTATE_BYTES: '400' }, git: false }), true);
    assert.ok(existsSync(`${file}.1`), 'no rotation file');
    assert.ok(readRows(`${file}.1`).some((w) => w.id === a.id), 'the old row is not in .1');
    const fresh = readRows(file);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, b.id);
  });

  it('(9) the switch OMC_PROVIDER_TASK_LOG=off: writeRow writes nothing, the file does not appear', () => {
    const f = fixture({ OMC_PROVIDER_TASK_LOG: 'off' });
    const { writeRow } = logModule();
    const z = buildTask(f, {});
    assert.equal(writeRow(z.id, { env: f.env, git: false }), false);
    assert.ok(!existsSync(join(f.state, 'tasks.jsonl')), 'the journal file appeared despite the switch');
  });

  it('(10) CLI: read without a write, write, a second write does nothing, usage and no data', () => {
    const f = fixture();
    const z = buildTask(f, {});
    const run = (args) => spawnSync(process.execPath, [TASK_LOG, ...args], { env: f.env, encoding: 'utf8' });
    const file = join(f.state, 'tasks.jsonl');
    const r1 = run([z.id]);
    assert.equal(r1.status, 0, `code ${r1.status}: ${r1.stderr}`);
    assert.equal(JSON.parse(r1.stdout.trim()).id, z.id);
    assert.ok(!existsSync(file), 'a CLI read writes');
    const r2 = run(['write', z.id]);
    assert.equal(r2.status, 0, `code ${r2.status}: ${r2.stderr}`);
    assert.equal(readRows(file).length, 1, 'CLI write');
    const r3 = run(['write', z.id]);
    assert.equal(r3.status, 1);
    assert.equal(readRows(file).length, 1, 'a second write appended');
    assert.equal(run([]).status, 2);
    assert.equal(run(['write']).status, 2);
    assert.equal(run(['no-such-id']).status, 1);
  });

  it('(11) git in named mode on a fake git: success_without_changes, change counts, header; no branch = null fields', () => {
    const f = fixture();
    const gitFake = fakeGit(f);
    const { taskRow, resultHeader } = logModule();
    const z = buildTask(f, {});
    const w = taskRow(z.id, { env: { ...f.env, OMC_PROVIDER_TASK_GIT_BIN: gitFake, GIT_SCENARIO: 'empty' } });
    assert.equal(w.branch, `omc-team/${z.team}/executor`);
    assert.equal(w.base_sha, '0123456789ab');
    assert.equal(w.files_changed, null);
    assert.ok(w.warnings.includes('success_without_changes'), 'no success_without_changes');
    const w2 = taskRow(z.id, { env: { ...f.env, OMC_PROVIDER_TASK_GIT_BIN: gitFake, GIT_SCENARIO: 'changes' } });
    assert.equal(w2.files_changed, 3);
    assert.equal(w2.added, 120);
    assert.equal(w2.removed, 45);
    assert.ok(!w2.warnings.includes('success_without_changes'), 'a warning with changes');
    const header = resultHeader(w2);
    assert.ok(header.includes(`branch: omc-team/${z.team}/executor`), 'a header without the branch');
    assert.ok(header.includes('base 0123456789ab'), 'a header without the base');
    assert.ok(header.includes('3 file(s), +120/-45'), 'a header without the changes');
    const w3 = taskRow(z.id, { env: { ...f.env, OMC_PROVIDER_TASK_GIT_BIN: gitFake, GIT_SCENARIO: 'none' } });
    assert.equal(w3.branch, null);
    assert.equal(w3.base_sha, null);
    assert.ok(!w3.warnings.includes('success_without_changes'), 'a warning without a branch');
  });

  it('(12) the shape of a real session transcript: a model without [1m], a synthetic row at the end, the code from Exit code, window_percent from one turn', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const z = skeleton(f, { model: 'acme-small', ordered: 'haiku' });
    const ts = (s) => new Date(Date.parse('2026-11-14T22:00:00.000Z') + s * 1000).toISOString();
    const lines = [
      // turn 1: fill 100 000 (in 90 000 + cache 5 000 + out 5 000), tool_use A
      assistantLine(ts(1), 'acme-small', { input_tokens: 90000, output_tokens: 5000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 },
        [{ type: 'text', text: 'start of work' }, { type: 'tool_use', id: 'toolu-A', name: 'Bash', input: { command: 'echo x' } }]),
      resultLine(ts(2), [{ type: 'tool_result', tool_use_id: 'toolu-A', content: 'output' }]),
      // turn 2: fill 250 000 (in 200 000 + cache 30 000 + out 20 000), tool_use B
      assistantLine(ts(3), 'acme-small', { input_tokens: 200000, output_tokens: 20000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 20000 },
        [{ type: 'tool_use', id: 'toolu-B', name: 'Bash', input: { command: 'exit 2' } }]),
      resultLine(ts(4), [{ type: 'tool_result', tool_use_id: 'toolu-B', is_error: true, content: 'Exit code 2\nmore text' }]),
      // turn 3: fill 180 000 (in 150 000 + cache 25 000 + out 5 000), tool_use C and D
      assistantLine(ts(5), 'acme-small', { input_tokens: 150000, output_tokens: 5000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000 },
        [{ type: 'tool_use', id: 'toolu-C', name: 'Bash', input: { command: 'exit 127' } }, { type: 'tool_use', id: 'toolu-D', name: 'Bash', input: { command: 'echo x' } }]),
      resultLine(ts(6), [{ type: 'tool_result', tool_use_id: 'toolu-C', is_error: true, content: [{ type: 'text', text: 'Exit code 127\nsome text' }] }]),
      resultLine(ts(7), [{ type: 'tool_result', tool_use_id: 'toolu-D', is_error: true, content: 'PreToolUse:Bash hook error: denied' }]),
      // an API error row: skipped everywhere (not a turn, not the used model, not has_text, not tokens)
      assistantLine(ts(8), '<synthetic>', undefined, [{ type: 'text', text: 'API Error: Request rejected (429)' }]),
    ];
    writeFileSync(join(z.projectDir, `${z.sid}.jsonl`), lines.join('\n') + '\n');
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(w.model_used, 'acme-small', 'model_used (the synthetic row does not win)');
    assert.equal(w.turns, 3, 'turns without the synthetic row');
    assert.equal(w.window_percent, 25, 'window_percent = 250 000 from one turn at the 1M window (model of the profile)');
    assert.ok(!w.warnings.includes('model_mismatch'), 'model_mismatch with haiku -> the profile haiku model');
    assert.equal(w.bash_calls, 4, 'bash calls');
    assert.equal(w.bash_failures, 3, 'bash failures');
    assert.equal(w.bash_last_code, 1, 'code of the last bash (a hook denial without Exit code = 1)');
    assert.equal(w.tokens_in, 440000, 'sum of in tokens over turns');
    assert.equal(w.tokens_out, 30000, 'sum of out tokens over turns');
    assert.equal(w.tokens_cache, 60000, 'sum of cache tokens over turns');
    // A variant without the last result (a hook denial): the last code = 127 from the content in the block array.
    const z2 = skeleton(f, { model: 'acme-small', ordered: 'haiku' });
    const lines2 = [...lines.slice(0, 6), lines[7]]; // without the result of D (index 6), with the synthetic row
    writeFileSync(join(z2.projectDir, `${z2.sid}.jsonl`), lines2.join('\n') + '\n');
    const w2 = taskRow(z2.id, { env: f.env, git: false });
    assert.equal(w2.bash_last_code, 127, 'code of the last bash from the block array (Exit code 127)');
  });

  it('(13) window: a model outside the profile without [1m] gives 200 000; an ordered model with [1m] gives the window of the profile', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const fill = { input_tokens: 180000, output_tokens: 5000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 5000 };
    const ts = '2026-11-14T22:00:00.000Z';
    // a) used and ordered without [1m], the used one is not a model of the profile: the window 200 000
    const a = skeleton(f, { model: 'claude-sonnet-x', ordered: 'sonnet' });
    writeFileSync(join(a.projectDir, `${a.sid}.jsonl`), assistantLine(ts, 'claude-sonnet-x', fill, [{ type: 'text', text: 'answer' }]) + '\n');
    const wa = taskRow(a.id, { env: f.env, git: false });
    assert.equal(wa.window_percent, 100, 'window 200 000 for a model outside the profile without [1m]');
    // b) ordered with [1m]: the window 1 000 000 despite the used one without the suffix
    const b = skeleton(f, { model: 'claude-sonnet-x', ordered: 'acme-small[1m]' });
    writeFileSync(join(b.projectDir, `${b.sid}.jsonl`), assistantLine(ts, 'claude-sonnet-x', fill, [{ type: 'text', text: 'answer' }]) + '\n');
    const wb = taskRow(b.id, { env: f.env, git: false });
    assert.equal(wb.window_percent, 20, 'window 1 000 000 after [1m] in model_ordered');
  });

  it('(14) only a <synthetic> row: turns 0 (zero from the transcript), model null, empty_response present', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const z = skeleton(f, { model: 'acme-small', ordered: 'haiku' });
    const lines = [assistantLine('2026-11-14T22:00:10.000Z', '<synthetic>', undefined, [{ type: 'text', text: 'API Error: Request rejected (429)' }])];
    writeFileSync(join(z.projectDir, `${z.sid}.jsonl`), lines.join('\n') + '\n');
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(w.turns, 0, 'zero counted from an existing transcript stays zero');
    assert.equal(w.model_used, null, 'model_used with only a synthetic row');
    assert.equal(w.window_percent, null, 'window_percent with only a synthetic row');
    assert.ok(w.warnings.includes('empty_response'), 'no empty_response with only a synthetic row');
  });

  it('(15) zero from the transcript stays zero (bash_failures 0, header "failures 0"); without a transcript null and `?`', () => {
    const f = fixture();
    const { taskRow, resultHeader } = logModule();
    // (a) a transcript with one Bash without failures: calls 1, failures 0 (not null), header "failures 0".
    const a = skeleton(f);
    writeFileSync(join(a.projectDir, `${a.sid}.jsonl`), [
      assistantLine('2026-11-14T22:00:01.000Z', 'acme-small', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, [{ type: 'text', text: 'start' }, { type: 'tool_use', id: 'toolu-S', name: 'Bash', input: { command: 'echo x' } }]),
      resultLine('2026-11-14T22:00:02.000Z', [{ type: 'tool_result', tool_use_id: 'toolu-S', content: 'output' }]),
    ].join('\n') + '\n');
    const wa = taskRow(a.id, { env: f.env, git: false });
    assert.equal(wa.bash_calls, 1);
    assert.equal(wa.bash_failures, 0, 'zero counted from the transcript stays zero, not null');
    const ha = resultHeader(wa);
    assert.ok(ha.includes('failures 0'), ha);
    assert.ok(ha.includes('calls 1'), ha);
    // (b) no transcript: tokens/turns/Bash null (could not be determined), header `?`.
    const idB = randomUUID().replace(/-/g, '').slice(0, 8);
    const teamB = `ptask-${idB}`;
    mkdirSync(join(f.state, 'tasks'), { recursive: true });
    writeFileSync(join(f.state, 'tasks', `${idB}.json`), JSON.stringify({ id: idB, team: teamB, start: new Date().toISOString(), cwd: f.dir, verdict: { status: 'success' } }) + '\n');
    appendFileSync(join(f.state, 'workers.jsonl'), JSON.stringify({ ts: new Date().toISOString(), point: 'team-worker', role: 'executor', name: `${teamB}/executor`, team: teamB, session_id: randomUUID(), started_with: { model: 'haiku' } }) + '\n');
    const wb = taskRow(idB, { env: f.env, git: false });
    assert.equal(wb.tokens_in, null, 'no transcript: tokens null');
    assert.equal(wb.turns, null, 'no transcript: turns null');
    assert.equal(wb.bash_failures, null, 'no transcript: failures null');
    const hb = resultHeader(wb);
    assert.ok(hb.includes('failures ?'), hb);
    assert.ok(hb.includes('turns ?'), hb);
  });

  it('(16) deduplication by message.id: the same id once, a second id a second turn, Bash from the next row of an id counted', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const z = skeleton(f);
    const usageA = { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100 };
    const usageB = { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 2 };
    const lines = [
      assistantLine('2026-11-14T22:00:01.000Z', 'acme-small', usageA, [{ type: 'text', text: 'hello' }], 'msg-A'),
      assistantLine('2026-11-14T22:00:02.000Z', 'acme-small', usageA, [{ type: 'tool_use', id: 'toolu-A1', name: 'Bash', input: { command: 'echo x' } }], 'msg-A'),
      assistantLine('2026-11-14T22:00:03.000Z', 'acme-small', usageB, [{ type: 'text', text: 'done' }], 'msg-B'),
    ];
    writeFileSync(join(z.projectDir, `${z.sid}.jsonl`), lines.join('\n') + '\n');
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(w.turns, 2, 'turns = unique message.id (not rows)');
    assert.equal(w.tokens_in, 15, 'in = 10 + 5, without doubling id A');
    assert.equal(w.tokens_out, 16, 'out = 7 + 9, without doubling id A');
    assert.equal(w.tokens_cache, 102, 'cache = 100 + 2');
    assert.equal(w.window_percent, 0.01, 'window_percent from one turn (117 / 1M), usage of id A counted once');
    assert.equal(w.bash_calls, 1, 'Bash from the second row of the same id counted');
  });

  it('(17) an excerpt of a real session transcript: 10 rows = 3 turns, tokens from the first row of an id, without doubling', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const z = skeleton(f);
    const usage = (inTokens, cacheRead, outTokens) => ({ input_tokens: inTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: outTokens, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: '', iterations: [], speed: 'standard', fallback_credit: null });
    const row = (id, content, u) => ({ type: 'assistant', message: { id, model: 'acme-small', usage: u, content } });
    const excerpt = [
      row('msg_aaa', [{ type: 'thinking' }], usage(22554, 0, 46)),
      row('msg_aaa', [{ type: 'tool_use' }], usage(22554, 0, 46)),
      row('msg_bbb', [{ type: 'thinking' }], usage(18893, 22528, 2222)),
      row('msg_bbb', [{ type: 'text' }], usage(18893, 22528, 2222)),
      row('msg_bbb', [{ type: 'tool_use' }], usage(18893, 22528, 2222)),
      row('msg_bbb', [{ type: 'tool_use' }], usage(18893, 22528, 2222)),
      row('msg_ccc', [{ type: 'thinking' }], usage(24660, 41408, 595)),
      row('msg_ccc', [{ type: 'text' }], usage(24660, 41408, 595)),
      row('msg_ccc', [{ type: 'tool_use' }], usage(24660, 41408, 595)),
      row('msg_ccc', [{ type: 'tool_use' }], usage(24660, 41408, 595)),
    ];
    writeFileSync(join(z.projectDir, `${z.sid}.jsonl`), excerpt.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(w.turns, 3, 'turns = 3 unique message.id (10 rows)');
    assert.equal(w.tokens_in, 66107, 'in = 22554 + 18893 + 24660');
    assert.equal(w.tokens_out, 2863, 'out = 46 + 2222 + 595');
    assert.equal(w.tokens_cache, 63936, 'cache = 22528 + 41408');
    assert.equal(w.model_used, 'acme-small', 'model_used unchanged');
  });

  it('(18) rows without message.id: counted per row as before', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const z = buildTask(f, { turns: 2 });
    const w = taskRow(z.id, { env: f.env, git: false });
    assert.equal(w.turns, 2, 'turns per row');
    assert.equal(w.tokens_in, 2001, 'in 1000 + 1001 per row');
    assert.equal(w.tokens_out, 201, 'out 100 + 101 per row');
    assert.equal(w.tokens_cache, 1000, 'cache 500 + 500 per row');
    assert.equal(w.bash_calls, 1, 'Bash as before (the last turn without tool_use)');
  });

  it('(19) an integrity row of the worker gives the task class integrity: after a clean exit (no end row), after a failure class, and also when a later row of the same team carries another class', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const rowsOf = (z, extra) => appendFileSync(join(f.state, 'workers.jsonl'), extra.map((w) => JSON.stringify({ ts: new Date().toISOString(), point: 'team-worker', name: `${z.team}/executor`, team: z.team, ...w })).join('\n') + '\n');
    const clean = buildTask(f, {});
    rowsOf(clean, [{ result: 'integrity', git_change: 'hooks/pre-commit', launcher_exit: 0, class: 'integrity' }]);
    assert.equal(taskRow(clean.id, { env: f.env, git: false }).class, 'integrity', 'integrity after exit 0');
    const failed = buildTask(f, { status: 'failed' });
    rowsOf(failed, [{ result: 'integrity', git_change: 'config', launcher_exit: 1, class: 'integrity' }]);
    assert.equal(taskRow(failed.id, { env: f.env, git: false }).class, 'integrity', 'integrity after a failure class');
    const later = buildTask(f, {});
    rowsOf(later, [{ result: 'integrity', git_change: 'config', launcher_exit: 0, class: 'integrity' }, { result: 'end', exit_code: 1, class: 'throttle' }]);
    assert.equal(taskRow(later.id, { env: f.env, git: false }).class, 'integrity', 'a later class overwrote the integrity failure');
    const plain = buildTask(f, { status: 'failed' });
    assert.equal(taskRow(plain.id, { env: f.env, git: false }).class, 'other', 'without an integrity row the last class stays');
  });

  it('(20) a live change of .git against the baseline of a worker that its wrapper has not checked yet gives the class integrity (the result is read before claude exits); a checked baseline, an unchanged .git and a vanished directory give none', () => {
    const f = fixture();
    const { taskRow } = logModule();
    const { baselineFile, gitDigest, markBaselineChecked, writeBaseline } = require('../../../scripts/provider/lib/git-integrity.cjs');
    const repo = join(f.dir, 'repo');
    spawnSync('git', ['init', repo], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'p'], { encoding: 'utf8' });
    const z = buildTask(f, {});
    const file = baselineFile(f.state, z.team, 'executor');
    assert.ok(writeBaseline(file, repo, gitDigest(repo)), 'baseline written');
    assert.equal(taskRow(z.id, { env: f.env, git: false }).class, null, 'unchanged .git');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    assert.equal(taskRow(z.id, { env: f.env, git: false }).class, 'integrity', 'a hook added after the baseline');
    markBaselineChecked(file);
    assert.equal(taskRow(z.id, { env: f.env, git: false }).class, null, 'a checked baseline is not compared again');
    const gone = buildTask(f, {});
    assert.ok(writeBaseline(baselineFile(f.state, gone.team, 'executor'), join(f.dir, 'no-such-dir'), gitDigest(repo)), 'baseline of a vanished directory');
    assert.equal(taskRow(gone.id, { env: f.env, git: false }).class, null, 'no data is not a violation');
  });
});
