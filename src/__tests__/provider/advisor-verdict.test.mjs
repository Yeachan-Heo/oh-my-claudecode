/* global process */
// The advisor verdict module (scripts/provider/lib/advisor-verdict.cjs): the three-state parser, the citation validator, the protective cap,
// the resolutions, the role profiles file and the token of the input (advisor-input.cjs), plus the integration in provider-advisor.cjs
// (the shaped input mode with a protocol): on a fake claude, no network, no real key.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADVISOR, ROLE_TEMPLATE, fakeAdvisorClaude, readRows, runAdvisor } from './_advisor-helpers.mjs';
import { makeTmp } from './_helpers.mjs';

// Each case starts several node processes; on a loaded machine that takes longer than the default limit.
vi.setConfig({ testTimeout: 180000 });

const require = createRequire(import.meta.url);
const w = require('../../../scripts/provider/lib/advisor-verdict.cjs');
const inputLib = require('../../../scripts/provider/lib/advisor-input.cjs');

const js = JSON.stringify;
const check = (condition, message) => expect(Boolean(condition), typeof message === 'function' ? message() : message).toBe(true);
const TOKEN = w.controlToken();
const GO_FULL = (tok) => [
  `TOKEN: ${tok}`,
  'VERDICT: GO',
  'One problem: the loop is not closed.',
  'SOURCE: a.go:3',
  'SUMMARY: after closing the loop a pass.',
].join('\n');
const TEMPLATE_QUESTION = ['DECISION: whether the fix is good; if so, I finish, if not, I correct it', 'TRIED: closing the loop', 'TEST TAIL: FAIL a_test.go:12', 'HYPOTHESIS: the loop', 'EVIDENCE: rg loop a.go:3', 'FILES: a.go'].join('\n');

describe.skipIf(process.platform === 'win32')('advisor verdict', () => {
  let tmp; let TMP; let FAKE; let JOURNAL; let n = 0; let wtCount = 0;
  const base = () => ({ PATH: process.env.PATH, HOME: TMP, OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL });
  const advisor = (env = {}, argv = [TEMPLATE_QUESTION]) => runAdvisor({ env: { ...base(), ...env }, argv, fakeOut: join(TMP, `w${++n}`) });
  const lastRow = () => readRows(JOURNAL).at(-1);
  const template = (name, text) => { const file = join(TMP, name); writeFileSync(file, text); return file; };
  const worktree = () => {
    const wt = join(TMP, `wt-${++wtCount}`);
    mkdirSync(wt, { recursive: true });
    const g = (args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    writeFileSync(join(wt, 'a.go'), ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n') + '\n');
    writeFileSync(join(wt, 'b.go'), 'const x = 1;\n');
    g(['add', '.']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start']);
    writeFileSync(join(wt, 'b.go'), 'const x = 2;\nconst y = 3;\n');
    return wt;
  };
  const mode = (wt, protocol, extra = {}) => ({ OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_PROVIDER_ADVISOR_PROTOCOL: protocol, OMC_TEAM_WORKTREE_PATH: wt, ...extra });

  beforeAll(() => {
    tmp = makeTmp('provider-advisor-verdict-');
    TMP = tmp.dir;
    FAKE = fakeAdvisorClaude(TMP);
    JOURNAL = join(TMP, 'data', 'advisor.jsonl');
  });
  afterAll(() => tmp.cleanup());

  // ===== W0-W8: the verdict module and the token in the input module =====
  it('(W0) advisor-input.cjs: the token appended as INPUT TOKEN before the hash (the hash covers it), meta.token; without a token no line and no field (the input behaviour unchanged)', () => {
    const wtW0 = join(TMP, 'w0-wt'); mkdirSync(wtW0, { recursive: true });
    spawnSync('git', ['-C', wtW0, 'init', '-q', '-b', 'main'], { encoding: 'utf8' }); // an own repository: git diff reaches here, not the upper repository (TMP may lie in a repository worktree)
    const env = { OMC_TEAM_WORKTREE_PATH: wtW0 };
    const question = 'DECISION: token test';
    const a = inputLib.buildInput({ env, question, planSection: 'TASK PLAN FROM THE LEAD:\nplan\n', context: '', token: 'abc123' });
    check(a.prompt.includes('\nINPUT TOKEN: abc123\n') && a.meta.token === 'abc123', js({ hasLine: a.prompt.includes('INPUT TOKEN: abc123'), token: a.meta.token }));
    check(a.meta.input_hash === createHash('sha256').update(a.prompt).digest('hex'), 'the hash does not cover the token');
    const b = inputLib.buildInput({ env, question, planSection: 'TASK PLAN FROM THE LEAD:\nplan\n', context: '' });
    check(!b.prompt.includes('INPUT TOKEN') && b.meta.token === null, js({ token: b.meta.token, hasLine: b.prompt.includes('INPUT TOKEN') }));
  });
  it('(W1) parser: a full final GO answer: the control line, the verdict, citations, the summary; state ok', () => {
    const p = w.parse(GO_FULL(TOKEN), { protocol: 'final', token: TOKEN });
    check(p.state === 'ok' && p.verdict === 'GO' && p.controlLine === true, js({ state: p.state, verdict: p.verdict, reason: p.reason }));
    check(p.citations.length === 1 && p.citations[0].file === 'a.go' && p.citations[0].line === 3, js(p.citations));
    check(p.summary === 'after closing the loop a pass.', js(p.summary));
    check(p.concerns.length === 0 && p.criteria === null, js({ concerns: p.concerns, criteria: p.criteria }));
  });
  it('(W2) parser no advice (8 of 8): empty, a mere announcement, short, no control line, a wrong token, no VERDICT, outside the dictionary, no SUMMARY', () => {
    const cases = [
      ['', 'empty'],
      ['Right away I will answer, I will analyse and come back with advice.', 'announcement'],
      ['Briefly.', 'announcement'],
      ['This is an assessment without a control line, a longer analysis text of several files of the project of the worker and its unit tests.\nVERDICT: GO\nSUMMARY: x', 'no-control-line'],
      [GO_FULL(TOKEN).replace(TOKEN, 'other-token'), 'wrong-token'],
      [`TOKEN: ${TOKEN}\nAssessment: good, GO.`, 'no-verdict'],
      [`TOKEN: ${TOKEN}\nVERDICT: OK\nSUMMARY: x`, 'verdict-outside-dictionary'],
      [`TOKEN: ${TOKEN}\nVERDICT: GO\nSome content without a summary.`, 'no-summary'],
    ];
    for (const [i, [text, expected]] of cases.entries()) {
      const p = w.parse(text, { protocol: 'final', token: TOKEN });
      check(p.state === 'none' && p.reason === expected, `case ${i + 1}: ${js({ state: p.state, reason: p.reason, expected })}`);
    }
  });
  it('(W3) the plan profile: LGTM with concerns = no advice; CONCERNS with 0 or 6 concerns = no advice; CONCERNS with 3 concerns = ok; the acceptance criteria parsed', () => {
    const t = (answer) => w.parse(answer, { protocol: 'plan', token: TOKEN });
    const bad = (verdict, concerns) => [`TOKEN: ${TOKEN}`, `VERDICT: ${verdict}`, ...concerns, 'SUMMARY: x'].join('\n');
    check(t(bad('LGTM', ['CONCERN 1: a'])).reason === 'concerns-with-lgtm', 'concerns with LGTM pass');
    check(t(bad('CONCERNS', [])).reason === 'wrong-concern-count', 'CONCERNS without concerns pass');
    check(t(bad('CONCERNS', ['CONCERN 1: a', 'CONCERN 2: b', 'CONCERN 3: c', 'CONCERN 4: d', 'CONCERN 5: e', 'CONCERN 6: f'])).reason === 'wrong-concern-count', '6 concerns pass');
    const ok3 = t(bad('CONCERNS', ['CONCERN 1: import', 'CONCERN 2: test', 'CONCERN 5: style', 'ACCEPTANCE CRITERIA:\nthe first passes', 'SUMMARY: x']));
    check(ok3.state === 'ok' && ok3.concerns.length === 3 && ok3.criteria === 'the first passes', js({ state: ok3.state, concerns: ok3.concerns.length, criteria: ok3.criteria }));
    const lgtm = t([`TOKEN: ${TOKEN}`, 'VERDICT: LGTM', 'SUMMARY: clean.'].join('\n'));
    check(lgtm.state === 'ok' && lgtm.verdict === 'LGTM' && lgtm.criteria === null, js({ state: lgtm.state, criteria: lgtm.criteria }));
  });
  it('(W4) the rescue profile: proceed/proceed-with-changes/reconsider = ok; GO from the final profile = outside the dictionary', () => {
    const t = (verdict) => w.parse([`TOKEN: ${TOKEN}`, `VERDICT: ${verdict}`, 'SUMMARY: x'].join('\n'), { protocol: 'rescue', token: TOKEN });
    check(['proceed', 'proceed-with-changes', 'reconsider'].every((x) => t(x).state === 'ok'), 'the rescue dictionary is incomplete');
    check(t('GO').reason === 'verdict-outside-dictionary', 'GO passes in the rescue profile');
  });
  it('(W5) the validator (acceptance measure, 6 of 6): a missing file, a file outside the shown ones, a line over the length, an omitted middle, an unparsed one, a correct one = 5 rejections + 1 acceptance', () => {
    const shown = { 'existing.txt': [[1, 5]], 'gap.txt': [[1, 4], [22, 28]] };
    const citations = w.parse([
      `TOKEN: ${TOKEN}`, 'VERDICT: STOP',
      'SOURCE: missing.txt:1', // a missing/not shown file
      'SOURCE: foreign.txt:2', // a file outside the shown ones
      'SOURCE: existing.txt:9', // a line over the length of the shown file
      'SOURCE: gap.txt:10', // a line in the omitted range (the gap 5-21)
      'SOURCE: bad:abc', // unparsed
      'SOURCE: existing.txt:3', // correct
      'SUMMARY: x',
    ].join('\n'), { protocol: 'final', token: TOKEN }).citations;
    const v = w.validateCitations(citations, shown);
    check(v.total === 6 && v.valid.length === 1 && v.invalid.length === 5, js({ total: v.total, valid: v.valid.length, invalid: v.invalid.length }));
    check(js(v.invalid.map((c) => c.reason)) === js(['file-not-shown', 'file-not-shown', 'line-outside-shown', 'line-outside-shown', 'unparsed']), 'reasons');
  });
  it('(W5b) the validator: empty shown (no metadata): all citations invalid; no citations = 0 of 0', () => {
    const a = w.validateCitations([{ file: 'a.go', line: 1, raw: 'a.go:1' }], null);
    check(a.invalid.length === 1 && a.invalid[0].reason === 'file-not-shown', js(a));
    const b = w.validateCitations([], { 'a.go': [[1, 1]] });
    check(b.total === 0 && b.message === 'citation validation: 0 of 0 valid', js(b));
  });
  it('(W6) the protective cap: the TOKEN and VERDICT lines untrimmed, the rest with a marker, the printout not over the cap; a small cap = a short marker; no trimming when it fits', () => {
    const answer = [
      `TOKEN: ${TOKEN}`, 'VERDICT: GO',
      'line-three ' + 'x'.repeat(70),
      'line-four ' + 'y'.repeat(70),
      'SUMMARY: end',
    ].join('\n');
    const cap = 200;
    const a = w.capAdvice(answer, cap);
    check(a.trimmed === true && a.text.startsWith(`TOKEN: ${TOKEN}\nVERDICT: GO`) && a.text.includes('[TRIMMED:'), js(a.text));
    check(a.text.length <= cap, `the printout ${a.text.length} is over the cap ${cap}`);
    const b = w.capAdvice(answer, 80); // an extremely small cap: the head alone + a short marker
    check(b.trimmed === true && b.text.includes('[TRIMMED: cap 80'), js(b.text));
    const c = w.capAdvice(answer, 10_000);
    check(c.trimmed === false && c.text === answer, 'no trimming when it fits');
  });
  it('(W7) resolutions: GO+STALE does not pass (code 3), GO with an unknown state (stale null) like STALE (code 3), GO without a valid citation or with an invalid one = invalid-citations (code 3), GO with a valid citation = ok, STOP = status stop code 3 (advice issued, the gate failed) with a warning without valid citations, no advice in the final profile = code 3', () => {
    const go = w.parse(GO_FULL(TOKEN), { protocol: 'final', token: TOKEN });
    const goValidation = w.validateCitations(go.citations, { 'a.go': [[1, 5]] });
    const goStale = w.decide({ protocol: 'final', parsed: go, validation: goValidation, stale: true });
    check(goStale.status === 'stale' && goStale.code === 3, js(goStale));
    const goInvalid = w.decide({ protocol: 'final', parsed: go, validation: w.validateCitations(go.citations, { 'a.go': [[1, 2]] }), stale: false });
    check(goInvalid.status === 'invalid-citations' && goInvalid.code === 3, js(goInvalid));
    const goNone = w.decide({ protocol: 'final', parsed: go, validation: w.validateCitations([], { 'a.go': [[1, 5]] }), stale: false });
    check(goNone.status === 'invalid-citations' && goNone.code === 3, js(goNone));
    check(w.decide({ protocol: 'final', parsed: go, validation: goValidation, stale: false }).status === 'ok', 'a correct GO does not pass');
    const stop = w.parse([`TOKEN: ${TOKEN}`, 'VERDICT: STOP', 'SOURCE: a.go:2', 'SUMMARY: stop'].join('\n'), { protocol: 'final', token: TOKEN });
    const stopResult = w.decide({ protocol: 'final', parsed: stop, validation: w.validateCitations(stop.citations, { 'a.go': [[1, 5]] }), stale: false });
    check(stopResult.status === 'stop' && stopResult.code === 3 && stopResult.advisory === true && /failed/.test(stopResult.warning || ''), `STOP status/code: ${js(stopResult)}`);
    const stopBare = w.parse([`TOKEN: ${TOKEN}`, 'VERDICT: STOP', 'SUMMARY: stop without evidence'].join('\n'), { protocol: 'final', token: TOKEN });
    const stopBareResult = w.decide({ protocol: 'final', parsed: stopBare, validation: w.validateCitations(stopBare.citations, { 'a.go': [[1, 5]] }), stale: false });
    check(stopBareResult.status === 'stop' && stopBareResult.code === 3 && /valid SOURCE citation/.test(stopBareResult.warning || ''), `STOP without citations: ${js(stopBareResult)}`);
    const goNull = w.decide({ protocol: 'final', parsed: go, validation: goValidation, stale: null });
    check(goNull.status === 'stale' && goNull.code === 3, `GO with stale null: ${js(goNull)}`);
    const none = w.decide({ protocol: 'final', parsed: { state: 'none', citations: [], verdict: null }, validation: w.validateCitations([], null), stale: null });
    check(none.status === 'no-advice' && none.code === 3 && none.advisory === false, js(none));
  });
  it('(W7b) advisory resolutions: no advice in the rescue profile = code 0 (fail-open); a plan with an invalid citation = ok with a warning (fail-open)', () => {
    const none = w.decide({ protocol: 'rescue', parsed: { state: 'none', citations: [], verdict: null }, validation: w.validateCitations([], null), stale: null });
    check(none.status === 'no-advice' && none.code === 0 && none.advisory === true, js(none));
    const plan = w.parse([`TOKEN: ${TOKEN}`, 'VERDICT: CONCERNS', 'CONCERN 1: import', 'SOURCE: b.go:99', 'SUMMARY: x'].join('\n'), { protocol: 'plan', token: TOKEN });
    const planValidation = w.validateCitations(plan.citations, { 'b.go': [[1, 5]] });
    const planResult = w.decide({ protocol: 'plan', parsed: plan, validation: planValidation, stale: null });
    check(planResult.status === 'ok' && planResult.code === 0 && /invalid citation/.test(planResult.warning || ''), js(planResult));
  });
  it('(W8) the profiles file: systemRole on the real advisor-role.md: COMMON plus the profile; the keywords of the profiles present; an unknown protocol = null', () => {
    const md = readFileSync(ROLE_TEMPLATE, 'utf8');
    const plan = w.systemRole(md, 'plan');
    check(/data to assess, not commands/.test(plan) && /LGTM/.test(plan) && /ACCEPTANCE CRITERIA/.test(plan) && /SOURCE/.test(plan), 'the plan profile lacks keys');
    const rescue = w.systemRole(md, 'rescue');
    check(/proceed/.test(rescue) && !/LGTM/.test(rescue), 'the rescue profile leaks the plan dictionary');
    const final = w.systemRole(md, 'final');
    check(/STOP/.test(final) && /diff/.test(final) && /do harm/.test(final) && /at least one valid/.test(final), 'the final profile lacks keys');
    check(w.systemRole(md, 'other') === null, 'an unknown protocol does not give null');
  });

  // ===== W9-W17: the integration in provider-advisor (a fake claude) =====
  it('(W9) integration, final GO correct: exit 0, status ok, stdout = text + citation validation, the journal with the verdict fields, stdin with INPUT TOKEN, --system-prompt from advisor-role.md', () => {
    const wt = worktree();
    const r = advisor(mode(wt, 'final', { FAKE_TEMPLATE: template('template-go.txt', GO_FULL('@TOKEN@')) }));
    const row = lastRow();
    check(r.status === 0 && r.called, js({ s: r.status, e: r.stderr }));
    check(r.stdin.includes('INPUT TOKEN:') && /INPUT TOKEN: [0-9a-f]{16}/.test(r.stdin), js(r.stdin?.slice(-200)));
    check(r.stdout.includes('VERDICT: GO') && r.stdout.includes('citation validation: 1 of 1 valid'), js(r.stdout));
    check(row.status === 'ok' && row.verdict === 'GO' && row.token_ok === true && row.stale === false && row.citations_valid === 1 && js(row.shown['a.go']) === js([[1, 5]]) && js(row.shown['b.go']) === js([[1, 2]]), js(row.shown));
    const i = r.argv.indexOf('--system-prompt');
    check(i >= 0 && /Start reading with the files of the diff/.test(r.argv[i + 1]), js(r.argv[i + 1]?.slice(0, 120)));
  });
  it('(W10) GO with STALE does not pass the gate (acceptance measure, 1 of 1): the fake appends to a file in the diff during the consultation -> stale=true, exit 3, status stale, a warning on stdout', () => {
    const wt = worktree();
    const r = advisor(mode(wt, 'final', { FAKE_TEMPLATE: template('template-go2.txt', GO_FULL('@TOKEN@')), FAKE_TOUCH: join(wt, 'a.go') }));
    const row = lastRow();
    check(r.status === 3 && row.status === 'stale' && row.stale === true, js({ s: r.status, row: { status: row.status, stale: row.stale } }));
    check(/STALE/.test(r.stdout) && r.stdout.includes('VERDICT: GO'), js(r.stdout));
  });
  it('(W11) rescue, an answer outside the format: exit 0 (fail-open), stdout ADVICE UNAVAILABLE, status no-advice in the journal, no cap_trimmed field', () => {
    const wt = worktree();
    const r = advisor(mode(wt, 'rescue', { FAKE_TEMPLATE: template('template-announcement.txt', 'Right away I will answer.\n') }));
    const row = lastRow();
    check(r.status === 0 && /ADVICE UNAVAILABLE \(announcement\): continue or report to the lead/.test(r.stdout), js({ s: r.status, o: r.stdout }));
    check(row.status === 'no-advice' && row.parser_reason === 'announcement' && !('cap_trimmed' in row), js(row));
    check(!r.stdout.includes('TOKEN:'), 'the raw text without the format went to stdout');
  });
  it('(W12) final no advice: exit 3, stdout GATE: no advice, status no-advice', () => {
    const wt = worktree();
    const r = advisor(mode(wt, 'final', { FAKE_TEMPLATE: template('template-announcement2.txt', 'Right away I will answer.\n') }));
    const row = lastRow();
    check(r.status === 3 && /GATE: no advice \(announcement\)/.test(r.stdout) && row.status === 'no-advice', js({ s: r.status, o: r.stdout, st: row.status }));
  });
  it('(W13) plan: LGTM + ACCEPTANCE CRITERIA -> criteria_chars > 0; CONCERNS with an invalid citation = exit 0 with a warning (fail-open)', () => {
    const wt = worktree();
    const lgtm = ['TOKEN: @TOKEN@', 'VERDICT: LGTM', 'ACCEPTANCE CRITERIA:', '- the test passes', '- the diff has no lint', 'SUMMARY: clean'].join('\n');
    const a = advisor(mode(wt, 'plan', { FAKE_TEMPLATE: template('template-lgtm.txt', lgtm) }));
    const ra = lastRow();
    check(a.status === 0 && ra.status === 'ok' && ra.verdict === 'LGTM' && ra.criteria_chars > 0 && 'citations_invalid' in ra && ra.citations_invalid === 0, js(ra));
    const concerns = ['TOKEN: @TOKEN@', 'VERDICT: CONCERNS', 'CONCERN 1: bad import', 'SOURCE: b.go:99', 'ACCEPTANCE CRITERIA:', '- test', 'SUMMARY: x'].join('\n');
    const b = advisor(mode(wt, 'plan', { FAKE_TEMPLATE: template('template-concerns.txt', concerns) }));
    const rb = lastRow();
    check(b.status === 0 && rb.status === 'ok' && rb.verdict === 'CONCERNS' && rb.citations_invalid === 1 && /invalid citation/.test(b.stdout), js({ o: b.stdout, w: rb }));
  });
  it('(W14) the protective cap of the advice (OMC_PROVIDER_ADVISOR_CAP_ADVICE=200): a long answer -> a [TRIMMED] marker on stdout, cap_trimmed=true in the journal, the VERDICT line untrimmed', () => {
    const wt = worktree();
    const long = ['TOKEN: @TOKEN@', 'VERDICT: GO', 'SOURCE: a.go:3', ...Array.from({ length: 12 }, (_, i) => `row ${i} ${'z'.repeat(60)}`), 'SUMMARY: end'].join('\n');
    const r = advisor(mode(wt, 'final', { FAKE_TEMPLATE: template('template-long.txt', long), OMC_PROVIDER_ADVISOR_CAP_ADVICE: '200' }));
    const row = lastRow();
    check(r.status === 0 && row.status === 'ok' && row.cap_trimmed === true, js({ s: r.status, st: row.status, c: row.cap_trimmed }));
    check(r.stdout.includes('[TRIMMED:') && r.stdout.includes('VERDICT: GO') && r.stdout.length <= 400, js(r.stdout.length));
  });
  it('(W15) without the mode (no OMC_PROVIDER_ADVISOR_INPUT) and with OMC_PROVIDER_ADVISOR_PROTOCOL=final: the old behaviour: the raw answer on stdout (exit 0), a journal row without the verdict fields, no INPUT TOKEN in stdin', () => {
    const wt = worktree();
    const r = advisor({ OMC_PROVIDER_ADVISOR_PROTOCOL: 'final', OMC_TEAM_WORKTREE_PATH: wt, FAKE_TEMPLATE: template('template-go3.txt', GO_FULL('@TOKEN@')) });
    const row = lastRow();
    check(r.status === 0 && r.stdout.includes('VERDICT: GO') && !r.stdout.includes('citation validation'), js({ s: r.status, o: r.stdout.slice(0, 80) }));
    check(!('verdict' in row) && !('token_ok' in row) && !('input_hash' in row), js(Object.keys(row)));
    check(r.stdin && !r.stdin.includes('INPUT TOKEN'), 'a token in stdin without the mode');
  });
  it('(W16) the mode without a protocol (like K1 of the advisor cases): the old output path, metadata without a token, a journal row without the verdict fields', () => {
    const wt = worktree();
    const r = advisor({ OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_TEAM_WORKTREE_PATH: wt, FAKE_TEMPLATE: template('template-go4.txt', GO_FULL('@TOKEN@')) });
    const row = lastRow();
    check(r.status === 0 && r.stdout.includes('VERDICT: GO') && !r.stdout.includes('citation validation'), js({ s: r.status, o: r.stdout.slice(0, 80) }));
    check(r.stdin.includes('INPUT TOKEN') === false, 'a token appended without a protocol');
    check(!('verdict' in row) && !('token' in row) && !('token_ok' in row), js(Object.keys(row)));
  });
  it('(W17) static limits of the verdict module: no URL, no provider key, no model hard-coded, no spawns', () => {
    const code = readFileSync(require.resolve('../../../scripts/provider/lib/advisor-verdict.cjs'), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    check(!/https?:\/\//.test(code), 'a URL in the verdict module');
    check(!/readKey|keyHelper|key-helper|apiKey|baseUrl/.test(code), 'a provider key in the verdict module');
    check(!/spawn/.test(code), 'a spawn in the verdict module (a pure module, no processes)');
    check(!/(opus|sonnet|fable)['"`]/i.test(code) || js(w.VERDICTS).includes('proceed'), 'a model hard-coded in the verdict module');
    check(ADVISOR.endsWith('provider-advisor.cjs'), 'the script path');
  });
});
