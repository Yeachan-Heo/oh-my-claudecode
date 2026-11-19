// Tests for the ask probe: the first and last human ask after a compaction.
// Synthetic data in a temporary directory; the script runs with python3 -I through spawnSync.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'tools', 'diagnostics', 'compaction_ask_probe.py');
const Z = 1.959963984540054;

function wilsonUpper(k, n) {
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const radius = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.min(1, center + radius);
}

function wilsonLower(k, n) {
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const radius = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, center - radius);
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((w) => JSON.stringify(w)).join('\n') + '\n');
}

function ask(sid, ts, text, extra = {}) {
  return { type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: text }, ...extra };
}

function blockUser(sid, ts, blocks, extra = {}) {
  return { type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: blocks }, ...extra };
}

function assistant(sid, ts, id, model, blocks) {
  return { type: 'assistant', sessionId: sid, timestamp: ts, message: { id, role: 'assistant', model, content: blocks } };
}

function boundary(uuid, ts, trigger = 'manual') {
  return { type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, compactMetadata: { trigger, preTokens: 1000, postTokens: 100 } };
}

function stateRow(sid, ts, text) {
  return blockUser(sid, ts, [{ type: 'text', text }]);
}

function apiRequest(sid, ts) {
  return { type: 'api-request', sessionId: sid, timestamp: ts };
}

function compactRow(ts, sid, agentId, trigger, result) {
  return { event: 'compact', ts, session_id: sid, agent_id: agentId, trigger, result };
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'test-ask-probe-'));
  const projects = join(dir, 'projects');
  mkdirSync(join(projects, '-test'), { recursive: true });
  return { dir, projects, compactFile: join(dir, 'compaction.jsonl') };
}

function run(env, extra = []) {
  return spawnSync('python3', ['-I', SCRIPT, '--projects', env.projects, '--compact', env.compactFile,
    '--to', '2026-11-15T00:00:00Z', '--days', '7', ...extra], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

function resultJson(env, extra = []) {
  const p = run(env, [...extra, '--json']);
  expect(p.status, `exit code ${p.status}: ${p.stderr}`).toBe(0);
  return JSON.parse(p.stdout);
}

function writeCompact(compactFile, rows) {
  writeFileSync(compactFile, rows.map((w) => JSON.stringify(w)).join('\n') + '\n');
}

function scenarioA() {
  const env = makeEnv();
  const dir = join(env.projects, '-test');
  const T = '2026-11-14T';
  const compactRows = [];
  // s1: jev, both asks full
  writeJsonl(join(dir, 's1.jsonl'), [
    ask('s1', T + '12:00:00Z', 'First request for report A about numeric-analysis Sample-Request-Marker-X7Q'),
    assistant('s1', T + '12:00:01Z', 'm1', 'claude-opus-5-5', [{ type: 'text', text: 'ok' }]),
    ask('s1', T + '12:00:02Z', 'Last request for fix B in the test-module'),
    boundary('U1', T + '12:00:03Z'),
    stateRow('s1', T + '12:00:04Z', 'State: First request for report A about numeric-analysis Sample-Request-Marker-X7Q and Last request for fix B in the test-module'),
    apiRequest('s1', T + '12:00:05Z'),
    assistant('s1', T + '12:00:06Z', 'm2', 'test-model-b', [{ type: 'thinking', thinking: 'thinking' }]),
    assistant('s1', T + '12:00:07Z', 'm2', 'test-model-b', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
  ]);
  compactRows.push(compactRow(T + '12:00:03Z', 's1', null, 'manual', 'jev'));
  compactRows.push({ event: 'after', ts: T + '12:00:04Z', compact_ts: T + '12:00:03Z' });
  // s2: the module trace: ask level trace
  writeJsonl(join(dir, 's2.jsonl'), [
    ask('s2', T + '12:01:00Z', 'First request for report A2 for the input-directory'),
    ask('s2', T + '12:01:01Z', 'Last request for fix B2 in the application configuration file and for summing the costs in the test spreadsheet for the logistics department'),
    boundary('U2', T + '12:01:02Z'),
    stateRow('s2', T + '12:01:03Z', 'Continuation of the session. First request for report A2 for the input-directory. [work state excerpt "Last request for fix B2 in the application configuration f", 223 chars in b/x.md]'),
    apiRequest('s2', T + '12:01:04Z'),
    assistant('s2', T + '12:01:05Z', 'm2b', 'test-model-b', [{ type: 'text', text: 'present' }]),
  ]);
  compactRows.push(compactRow(T + '12:01:02Z', 's2', null, 'manual', 'jev'));
  // s3: host, paraphrase: paraphrased
  writeJsonl(join(dir, 's3.jsonl'), [
    ask('s3', T + '12:02:00Z', 'Set the schedule of the city transport department for April'),
    ask('s3', T + '12:02:01Z', 'fix the logging of the production server today'),
    boundary('U3', T + '12:02:02Z'),
    stateRow('s3', T + '12:02:03Z', 'Today: production server logging, fix it quickly. Set the schedule of the city transport department for April'),
    apiRequest('s3', T + '12:02:04Z'),
    assistant('s3', T + '12:02:05Z', 'm3', 'claude-opus-5-5', [{ type: 'text', text: 'fine' }]),
  ]);
  // s4: a state without asks: lost
  writeJsonl(join(dir, 's4.jsonl'), [
    ask('s4', T + '12:03:00Z', 'Check the logistics department statistics for October'),
    ask('s4', T + '12:03:01Z', 'Send the autumn campaigns summary to the marketing department'),
    boundary('U4', T + '12:03:02Z'),
    stateRow('s4', T + '12:03:03Z', 'New continuation of the working session going on'),
    apiRequest('s4', T + '12:03:04Z'),
    assistant('s4', T + '12:03:05Z', 'm4', 'test-model-b', [{ type: 'text', text: 'ok' }]),
  ]);
  compactRows.push(compactRow(T + '12:03:02Z', 's4', null, 'manual', 'jev'));
  // s5: rows excluded from asks
  writeJsonl(join(dir, 's5.jsonl'), [
    blockUser('s5', T + '12:04:00Z', [{ type: 'text', text: 'Output token limit hit' }], { isMeta: true }),
    blockUser('s5', T + '12:04:01Z', [{ type: 'text', text: '<command-name>/cost</command-name><command-message>cost</command-message>' }]),
    blockUser('s5', T + '12:04:02Z', [{ type: 'text', text: '<task-notification>task finished</task-notification>' }]),
    blockUser('s5', T + '12:04:03Z', [{ type: 'tool_result', tool_use_id: 't5', content: 'tool result' }], { toolUseResult: { stdout: 'result' } }),
    blockUser('s5', T + '12:04:04Z', [{ type: 'text', text: '<system-reminder>context background</system-reminder>' }]),
    blockUser('s5', T + '12:04:05Z', [{ type: 'text', text: '[Request interrupted by user for the test]' }]),
    blockUser('s5', T + '12:04:06Z', [{ type: 'text', text: 'Caveat: a warning note' }]),
    blockUser('s5', T + '12:04:07Z', [{ type: 'text', text: '<local-command-stdout>result</local-command-stdout>' }]),
    blockUser('s5', T + '12:04:08Z', [{ type: 'text', text: '<cross-session>a message of another session</cross-session>' }]),
    ask('s5', T + '12:04:09Z', 'First and last request for a cleanup script in the test-directory'),
    boundary('U5', T + '12:04:10Z'),
    stateRow('s5', T + '12:04:11Z', 'Session state: First and last request for a cleanup script in the test-directory'),
    apiRequest('s5', T + '12:04:12Z'),
    assistant('s5', T + '12:04:13Z', 'm5', 'test-model-b', [{ type: 'text', text: 'done' }]),
  ]);
  compactRows.push(compactRow(T + '12:04:10Z', 's5', null, 'manual', 'jev'));
  // s6: a boundary without an api-request after it: the gap boundaries_without_api_request
  writeJsonl(join(dir, 's6.jsonl'), [
    ask('s6', T + '12:05:00Z', 'First request s6 for a backup diagnosis'),
    ask('s6', T + '12:05:01Z', 'Last request s6 for a log recovery'),
    boundary('U6', T + '12:05:02Z'),
    stateRow('s6', T + '12:05:03Z', 'State s6: First request s6 for a backup diagnosis and Last request s6 for a log recovery'),
  ]);
  compactRows.push(compactRow(T + '12:05:02Z', 's6', null, 'manual', 'jev'));
  // s7: empty calls: m10 empty, m11 with text, m12-m14 empty (the first 5), m15 the sixth is skipped
  writeJsonl(join(dir, 's7.jsonl'), [
    ask('s7', T + '12:06:00Z', 'First request s7 for repo cleaning'),
    ask('s7', T + '12:06:01Z', 'Last request s7 for a change report'),
    boundary('U7', T + '12:06:02Z', 'auto'),
    stateRow('s7', T + '12:06:03Z', 'State s7: First request s7 for repo cleaning and Last request s7 for a change report'),
    apiRequest('s7', T + '12:06:04Z'),
    assistant('s7', T + '12:06:05Z', 'm10', 'test-model-b', [{ type: 'thinking', thinking: 'a' }]),
    assistant('s7', T + '12:06:06Z', 'm11', 'test-model-b', [{ type: 'text', text: 'working' }]),
    assistant('s7', T + '12:06:07Z', 'm12', 'test-model-b', [{ type: 'thinking', thinking: 'b' }]),
    assistant('s7', T + '12:06:08Z', 'm13', 'test-model-b', [{ type: 'thinking', thinking: 'c' }]),
    assistant('s7', T + '12:06:09Z', 'm14', 'test-model-b', [{ type: 'thinking', thinking: 'd' }]),
    assistant('s7', T + '12:06:10Z', 'm15', 'test-model-b', [{ type: 'thinking', thinking: 'e' }]),
  ]);
  compactRows.push(compactRow(T + '12:06:02Z', 's7', null, 'auto', 'jev'));
  // s8: a canary lost
  writeJsonl(join(dir, 's8.jsonl'), [
    ask('s8', T + '12:07:00Z', 'First request s8 for an application deploy'),
    ask('s8', T + '12:07:01Z', 'Last request s8 for a log check'),
    blockUser('s8', T + '12:07:02Z', [{ type: 'tool_result', tool_use_id: 't8', content: 'I read the file /opt/x/y.txt; record saved' }], { toolUseResult: { stdout: '/opt/x/y.txt' } }),
    assistant('s8', T + '12:07:03Z', 'm7', 'test-model-b', [{ type: 'text', text: 'Task in progress, waiting' }]),
    boundary('U8', T + '12:07:04Z'),
    stateRow('s8', T + '12:07:05Z', 'State s8: First request s8 for an application deploy and Last request s8 for a log check'),
    apiRequest('s8', T + '12:07:06Z'),
    assistant('s8', T + '12:07:07Z', 'm8', 'test-model-b', [{ type: 'tool_use', id: 'tu8', name: 'Read', input: { file_path: '/opt/x/y.txt' } }]),
  ]);
  compactRows.push(compactRow(T + '12:07:04Z', 's8', null, 'auto', 'jev'));
  // s8b: a path mentioned by the assistant before the boundary is not a canary
  writeJsonl(join(dir, 's8b.jsonl'), [
    ask('s8b', T + '12:08:00Z', 'First request s8b for an application deploy'),
    ask('s8b', T + '12:08:01Z', 'Last request s8b for a log check'),
    assistant('s8b', T + '12:08:02Z', 'm7b', 'test-model-b', [{ type: 'text', text: 'I saw /opt/z/w.txt in the results' }]),
    blockUser('s8b', T + '12:08:03Z', [{ type: 'tool_result', tool_use_id: 't8b', content: 'I read the file /opt/z/w.txt; record saved' }], { toolUseResult: { stdout: '/opt/z/w.txt' } }),
    boundary('U8b', T + '12:08:04Z'),
    stateRow('s8b', T + '12:08:05Z', 'State s8b: First request s8b for an application deploy and Last request s8b for a log check'),
    apiRequest('s8b', T + '12:08:06Z'),
    assistant('s8b', T + '12:08:07Z', 'm8b', 'test-model-b', [{ type: 'tool_use', id: 'tu8b', name: 'Read', input: { file_path: '/opt/z/w.txt' } }]),
  ]);
  compactRows.push(compactRow(T + '12:08:04Z', 's8b', null, 'manual', 'jev'));
  // s9: a subagent, fallback
  mkdirSync(join(dir, 's9', 'subagents'), { recursive: true });
  writeJsonl(join(dir, 's9', 'subagents', 'agent-aQ1.jsonl'), [
    ask('s9', T + '12:10:00Z', 'First request of the subagent for a turnover chart'),
    ask('s9', T + '12:10:01Z', 'Last request of the subagent for a sales table'),
    boundary('U9', T + '12:10:02Z', 'auto'),
    stateRow('s9', T + '12:10:03Z', 'Subagent state: First request of the subagent for a turnover chart and Last request of the subagent for a sales table'),
    apiRequest('s9', T + '12:10:04Z'),
    assistant('s9', T + '12:10:05Z', 'm10s', 'test-model-b', [{ type: 'text', text: 'ready' }]),
  ]);
  compactRows.push(compactRow(T + '12:10:02Z', 's9', 'aQ1', 'manual', 'fallback'));
  // s10a/s10b: the same boundary uuid in two files
  for (const name of ['s10a', 's10b']) {
    writeJsonl(join(dir, `${name}.jsonl`), [
      ask(name, T + '12:11:00Z', `First request ${name} for cache cleaning`),
      ask(name, T + '12:11:01Z', `Last request ${name} for cost summing`),
      boundary('U10', T + '12:11:02Z'),
      stateRow(name, T + '12:11:03Z', `State ${name}: First request ${name} for cache cleaning and Last request ${name} for cost summing`),
      apiRequest(name, T + '12:11:04Z'),
      assistant(name, T + '12:11:05Z', `m-${name}`, 'test-model-b', [{ type: 'text', text: 'ok' }]),
    ]);
  }
  // s12: a boundary without an ask before it (the first ask comes after the boundary)
  writeJsonl(join(dir, 's12.jsonl'), [
    boundary('U12', T + '12:12:00Z'),
    stateRow('s12', T + '12:12:01Z', 'State of a fresh session without earlier human asks'),
    apiRequest('s12', T + '12:12:02Z'),
    assistant('s12', T + '12:12:03Z', 'm12x', 'test-model-b', [{ type: 'text', text: 'start' }]),
  ]);
  // s11: a boundary outside the period (skipped)
  writeJsonl(join(dir, 's11.jsonl'), [
    ask('s11', '2026-11-01T12:00:00Z', 'First request s11 outside the period for archiving'),
    ask('s11', '2026-11-01T12:00:01Z', 'Last request s11 outside the period for a database dump'),
    boundary('U11', '2026-11-01T12:00:02Z'),
    stateRow('s11', '2026-11-01T12:00:03Z', 'State s11: First request s11 outside the period for archiving and Last request s11 outside the period for a database dump'),
    apiRequest('s11', '2026-11-01T12:00:04Z'),
    assistant('s11', '2026-11-01T12:00:05Z', 'm11x', 'test-model-b', [{ type: 'text', text: 'ok' }]),
  ]);
  compactRows.push(compactRow('2026-11-01T12:00:02Z', 's11', null, 'manual', 'jev'));
  compactRows.push('not-json');
  writeCompact(env.compactFile, compactRows);
  return env;
}

describe('compaction_ask_probe', () => {
  it('scenarios 1-10, 13: levels, groups, canaries, empty calls, duplicate, period and gaps', () => {
    const env = scenarioA();
    try {
      const pj = run(env, ['--json', '--details']);
      expect(pj.status, `exit code ${pj.status}: ${pj.stderr}`).toBe(0);
      const r = JSON.parse(pj.stdout);
      expect(r.metric).toBe('ask-probe');
      expect(r.n.value).toBe(12);
      expect(r.period).toEqual({ from: '2026-11-08T00:00:00Z', to: '2026-11-15T00:00:00Z' });
      expect(r.data_range).toEqual({ from: '2026-11-14T12:00:03Z', to: '2026-11-14T12:12:00Z' });
      expect(r.model).toEqual({ 'test-model-b': 10, 'claude-opus-5-5': 1 });
      expect(r.trigger).toEqual({ manual: 10, auto: 2 });
      expect(r.journal_trigger).toEqual({ manual: 7, auto: 2 });
      expect(r.control_arm.n).toBe(3);
      const j = Object.fromEntries(r.units.map((x) => [x.uuid, x]));
      // 1: jev, both asks full
      expect(j.U1.group).toBe('jev/main');
      expect(j.U1.head_level).toBe('full');
      expect(j.U1.ask_level).toBe('full');
      // 2: the module trace
      expect(j.U2.head_level).toBe('full');
      expect(j.U2.ask_level).toBe('trace');
      // 3: host with a paraphrase: paraphrased
      expect(j.U3.group).toBe('host/main');
      expect(j.U3.ask_level).toBe('paraphrased');
      // 4: a state without asks: lost
      expect(j.U4.head_level).toBe('lost');
      expect(j.U4.ask_level).toBe('lost');
      // 5: excluded rows; the only ask is head and ask
      expect(j.U5.head_level).toBe('full');
      expect(j.U5.ask_level).toBe('full');
      // 6: a boundary without an api-request: outside the denominator
      expect(j.U6.head_level).toBe('unavailable');
      expect(j.U6.ask_level).toBe('unavailable');
      // 7: empty calls: 4 of the first 5; the sixth is skipped
      expect(j.U7.calls_count).toBe(5);
      expect(j.U7.empty_calls).toBe(4);
      // 8: a canary lost and one rejected
      expect(j.U8.canaries).toBe(1);
      expect(j.U8.kept).toBe(0);
      expect(j.U8b.canaries).toBe(0);
      // 9: subagent fallback
      expect(j.U9.group).toBe('fallback/subagent');
      expect(j.U9.head_level).toBe('full');
      expect(j.U9.ask_level).toBe('full');
      // 10: the duplicate counted once, from the first file
      expect(r.units.filter((x) => x.uuid === 'U10').length).toBe(1);
      expect(j.U10.group).toBe('host/main');
      // 12 part A: a boundary without an ask
      expect(j.U12.head_level).toBe('no ask');
      expect(j.U12.ask_level).toBe('no ask');
      // 13: a boundary outside the period is skipped
      expect(r.units.filter((x) => x.uuid === 'U11').length).toBe(0);
      // results
      const w = Object.fromEntries(r.results.map((x) => [x.name, x]));
      const pair = (name) => [w[name].numerator, w[name].denominator];
      expect(pair('jev/main: empty calls in the 5 after compaction')).toEqual([4, 11]);
      expect(pair('jev/main: compactions with an empty call')).toEqual([1, 7]);
      expect(pair('jev/main: canaries lost')).toEqual([1, 1]);
      expect(pair('jev/main: first ask lost or trace only')).toEqual([1, 7]);
      expect(pair('host/main: head_lost')).toEqual([0, 2]);
      expect(pair('fallback/subagent: head_lost')).toEqual([0, 1]);
      // gaps
      const lc = r.data_quality[0];
      expect(lc.rows).toBe(12);
      expect(lc.bad_lines).toBe(1);
      expect(lc.gaps).toEqual({ compact_without_after: 9, after_without_compact: 0, compact_without_boundary: 0 });
      const lt = r.data_quality[1];
      expect(lt.gaps.boundaries_without_api_request).toBe(1);
      expect(lt.gaps.without_ask).toBe(1);
      expect(lt.gaps.boundaries_duplicated_from_copies).toBe(1);
      expect(lt.gaps.boundaries_without_timestamp).toBe(0);
      // no ask contents in the JSON output
      expect(pj.stdout.includes('X7Q'), 'ask content leaked to stdout').toBe(false);
      // the text mode has no contents either
      const pt = run(env);
      expect(pt.status).toBe(0);
      expect(pt.stdout.includes('X7Q'), 'ask content leaked to stdout (text mode)').toBe(false);
      // 13: --out to an existing file: exit 1
      const existing = join(env.dir, 'result.target');
      writeFileSync(existing, 'x\n');
      const pw = run(env, ['--json', '--out', existing]);
      expect(pw.status).toBe(1);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  function scenarioVerdicts(prefix, fileCount, lostAskCount) {
    const env = makeEnv();
    const dir = join(env.projects, '-test');
    const compactRows = [];
    for (let i = 1; i <= fileCount; i += 1) {
      const sid = `${prefix}${String(i).padStart(2, '0')}`;
      const hh = String(10 + Math.floor(i / 60)).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      const ts = (s) => `2026-11-13T${hh}:${mm}:${String(s).padStart(2, '0')}Z`;
      const lost = i <= lostAskCount;
      const head = `First request ${sid} for a monthly turnover chart`;
      const askText = `Last request ${sid} for a refactor of the counting module`;
      const stateText = lost
        ? 'Continuation of a stripped session without conclusions from the run'
        : `State ${sid}: ${head} and ${askText}`;
      writeJsonl(join(dir, `${sid}.jsonl`), [
        ask(sid, ts(0), head),
        assistant(sid, ts(5), `w-${sid}`, 'test-model-b', [{ type: 'text', text: 'note' }]),
        ask(sid, ts(10), askText),
        boundary(`W${sid}`, ts(20)),
        stateRow(sid, ts(30), stateText),
        apiRequest(sid, ts(40)),
        assistant(sid, ts(50), `n-${sid}`, 'test-model-b', [{ type: 'text', text: 'continuing' }]),
      ]);
      compactRows.push(compactRow(ts(20), sid, null, 'auto', 'jev'));
    }
    writeCompact(env.compactFile, compactRows);
    return env;
  }

  const VERDICT_OK = 'meets the ask-loss threshold';
  const VERDICT_NOT_OK = 'does not meet the ask-loss threshold';

  it('80 units without a loss: the verdict meets the threshold, upper bound for 0/80', () => {
    const env = scenarioVerdicts('b', 80, 0);
    try {
      const r = resultJson(env);
      expect(r.n.value).toBe(80);
      const wd = r.verdicts['jev/main'];
      expect(wd.head_lost).toBe(VERDICT_OK);
      expect(wd.ask_lost).toBe(VERDICT_OK);
      const expected = wilsonUpper(0, 80);
      expect(Math.abs(wd.head_upper_bound - expected)).toBeLessThan(1e-4);
      expect(expected).toBeLessThanOrEqual(0.05);
      const w = Object.fromEntries(r.results.map((x) => [x.name, x]));
      expect(w['jev/main: head_lost'].share).toBe(0);
      expect(w['jev/main: head_lost'].wilson_lower_95).toBe(0);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('30 units without a loss: the upper bound for 0/30 (11.35 %) does not meet the threshold', () => {
    const env = scenarioVerdicts('b30', 30, 0);
    try {
      const r = resultJson(env);
      expect(r.n.value).toBe(30);
      const wd = r.verdicts['jev/main'];
      expect(wd.head_lost).toBe(VERDICT_NOT_OK);
      expect(wd.ask_lost).toBe(VERDICT_NOT_OK);
      const expected = wilsonUpper(0, 30);
      expect(Math.abs(wd.head_upper_bound - expected)).toBeLessThan(1e-4);
      expect(expected).toBeGreaterThan(0.05);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('30 units with 3 lost asks: does not meet the threshold; Wilson matches the formula', () => {
    const env = scenarioVerdicts('c', 30, 3);
    try {
      const r = resultJson(env);
      const wd = r.verdicts['jev/main'];
      expect(wd.head_lost).toBe(VERDICT_NOT_OK);
      expect(wd.ask_lost).toBe(VERDICT_NOT_OK);
      const expectedUpper = wilsonUpper(3, 30);
      expect(Math.abs(wd.ask_upper_bound - expectedUpper)).toBeLessThan(1e-4);
      expect(wd.ask_upper_bound).toBeGreaterThan(0.05);
      const w = Object.fromEntries(r.results.map((x) => [x.name, x]));
      expect([w['jev/main: ask_lost'].numerator, w['jev/main: ask_lost'].denominator]).toEqual([3, 30]);
      expect(w['jev/main: ask_lost'].share).toBe(0.1);
      expect(Math.abs(w['jev/main: ask_lost'].wilson_lower_95 - wilsonLower(3, 30))).toBeLessThan(1e-4);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('10 units: insufficient data', () => {
    const env = scenarioVerdicts('d', 10, 0);
    try {
      const r = resultJson(env);
      const wd = r.verdicts['jev/main'];
      expect(wd.head_lost).toBe('insufficient data');
      expect(wd.ask_lost).toBe('insufficient data');
      const w = Object.fromEntries(r.results.map((x) => [x.name, x]));
      expect(w['jev/main: head_lost'].share).toBe('insufficient data');
      expect(w['jev/main: head_lost'].wilson_lower_95).toBe('insufficient data');
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  function assertNoNull(x, path) {
    if (x === null || x === undefined) {
      throw new Error(`null or undefined in the field ${path}`);
    }
    if (Array.isArray(x)) {
      x.forEach((v, i) => assertNoNull(v, `${path}[${i}]`));
    } else if (typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) assertNoNull(v, `${path}.${k}`);
    }
  }

  it('the template fields are complete and without null', () => {
    const env = scenarioVerdicts('e', 30, 0);
    try {
      const r = resultJson(env);
      for (const field of ['template', 'metric', 'script', 'generated_at', 'rule', 'period', 'n', 'model',
        'trigger', 'control_arm', 'data_quality', 'results', 'min_support', 'caveats']) {
        expect(field in r, `missing field ${field}`).toBe(true);
      }
      expect(r.template).toBe('compaction-report/1');
      expect(r.period.from && r.period.to).toBeTruthy();
      expect(r.data_quality.length).toBeGreaterThanOrEqual(1);
      assertNoNull(r, 'report');
      expect(r.rule.includes('Wilson')).toBe(true);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('2 usage errors: a missing compact file and a bad date', () => {
    const env = makeEnv();
    try {
      const p = spawnSync('python3', ['-I', SCRIPT, '--projects', env.projects, '--compact', join(env.dir, 'missing.jsonl'), '--json']);
      expect(p.status).toBe(2);
      const p2 = spawnSync('python3', ['-I', SCRIPT, '--projects', env.projects, '--compact', env.compactFile, '--to', 'not-a-date', '--json']);
      expect(p2.status).toBe(2);
      const p3 = spawnSync('python3', ['-I', SCRIPT, '--bad-option', 'x']);
      expect(p3.status).toBe(2);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  function compactAt(ts) {
    return { event: 'compact', ts, session_id: 'S', agent_id: null, trigger: 'manual', result: 'jev' };
  }

  it('a copy sorting first does not take the jev group (the pair rule with consumption)', () => {
    const env = makeEnv();
    try {
      const dirA = join(env.projects, '-aaa-copy');
      const dirB = join(env.projects, '-bbb-original');
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      const T0 = '2026-11-14T12:00:00Z';
      const ts = (s) => `2026-11-14T12:00:${String(s).padStart(2, '0')}Z`;
      writeJsonl(join(dirA, 'copy.jsonl'), [
        ask('S2', T0, 'First request of the copy for a report'),
        ask('S2', ts(1), 'Last request of the copy for a summing'),
        boundary('UA2', ts(2)),
        stateRow('S2', ts(3), 'State of the copy: First request of the copy for a report and Last request of the copy for a summing'),
        apiRequest('S2', ts(4)),
        assistant('S2', ts(5), 'm-k', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeJsonl(join(dirB, 'original.jsonl'), [
        ask('S1', T0, 'First request of the original for a report'),
        ask('S1', ts(1), 'Last request of the original for a summing'),
        boundary('UA2', ts(2)),
        stateRow('S1', ts(3), 'State of the original: First request of the original for a report and Last request of the original for a summing'),
        apiRequest('S1', ts(4)),
        assistant('S1', ts(5), 'm-o', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeCompact(env.compactFile, [compactRow(ts(30), 'S1', null, 'manual', 'jev')]);
      const r = resultJson(env, ['--details']);
      expect(r.n.value).toBe(1);
      const j = r.units[0];
      expect(j.uuid).toBe('UA2');
      expect(j.group).toBe('jev/main');
      expect(j.file.includes('original'), `unit file: ${j.file}`).toBe(true);
      expect(r.data_quality[1].gaps.boundaries_duplicated_from_copies).toBe(1);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('two boundaries at one fallback row: only the closer one gets the group', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      writeJsonl(join(dir, 'sB.jsonl'), [
        ask('SB', '2026-11-14T11:58:40Z', 'First request B for a report'),
        ask('SB', '2026-11-14T11:58:41Z', 'Last request B for a summing'),
        boundary('UB1', '2026-11-14T11:58:50Z'),
        stateRow('SB', '2026-11-14T11:58:51Z', 'State B1: First request B for a report and Last request B for a summing'),
        apiRequest('SB', '2026-11-14T11:58:52Z'),
        assistant('SB', '2026-11-14T11:58:53Z', 'mb1', 'test-model-b', [{ type: 'text', text: 'ok' }]),
        boundary('UB2', '2026-11-14T12:00:30Z'),
        stateRow('SB', '2026-11-14T12:00:31Z', 'State B2: First request B for a report and Last request B for a summing'),
        apiRequest('SB', '2026-11-14T12:00:32Z'),
        assistant('SB', '2026-11-14T12:00:33Z', 'mb2', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeCompact(env.compactFile, [{ event: 'compact', ts: '2026-11-14T12:00:00Z', session_id: 'SB', agent_id: null, trigger: 'manual', result: 'fallback' }]);
      const r = resultJson(env, ['--details']);
      expect(r.n.value).toBe(2);
      const j = Object.fromEntries(r.units.map((x) => [x.uuid, x]));
      expect(j.UB1.group).toBe('host/main');
      expect(j.UB2.group).toBe('fallback/main');
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('a skipped row does not displace the closer jev row', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      writeJsonl(join(dir, 'sE.jsonl'), [
        ask('SE', '2026-11-14T12:00:00Z', 'First request E for a report'),
        ask('SE', '2026-11-14T12:00:01Z', 'Last request E for a summing'),
        boundary('UE', '2026-11-14T12:00:02Z'),
        stateRow('SE', '2026-11-14T12:00:03Z', 'State E: First request E for a report and Last request E for a summing'),
        apiRequest('SE', '2026-11-14T12:00:04Z'),
        assistant('SE', '2026-11-14T12:00:05Z', 'me', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeCompact(env.compactFile, [
        { event: 'compact', ts: '2026-11-14T12:00:02Z', session_id: 'SE', agent_id: null, trigger: 'manual', result: 'skipped' },
        { event: 'compact', ts: '2026-11-14T12:00:32Z', session_id: 'SE', agent_id: null, trigger: 'manual', result: 'jev' },
      ]);
      const r = resultJson(env, ['--details']);
      expect(r.n.value).toBe(1);
      expect(r.units[0].group).toBe('jev/main');
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('boundaries without a uuid have the fallback key file:timestamp', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      for (const name of ['sD1', 'sD2']) {
        writeJsonl(join(dir, `${name}.jsonl`), [
          ask(name, '2026-11-14T12:00:00Z', `First request ${name} for a report`),
          ask(name, '2026-11-14T12:00:01Z', `Last request ${name} for a summing`),
          { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-14T12:00:02Z', compactMetadata: { trigger: 'manual', preTokens: 1, postTokens: 1 } },
          stateRow(name, '2026-11-14T12:00:03Z', `State ${name}: First request ${name} for a report and Last request ${name} for a summing`),
          apiRequest(name, '2026-11-14T12:00:04Z'),
          assistant(name, '2026-11-14T12:00:05Z', `m-${name}`, 'test-model-b', [{ type: 'text', text: 'ok' }]),
        ]);
      }
      writeCompact(env.compactFile, [compactAt('2026-11-14T12:00:02Z')]);
      const r = resultJson(env, ['--details']);
      expect(r.n.value).toBe(2);
      expect(r.data_quality[1].gaps.boundaries_duplicated_from_copies).toBe(0);
      const keys = r.units.map((x) => x.uuid).sort();
      expect(keys.some((k) => k.endsWith(':2026-11-14T12:00:02Z') && k.includes('sD1.jsonl'))).toBe(true);
      expect(keys.some((k) => k.endsWith(':2026-11-14T12:00:02Z') && k.includes('sD2.jsonl'))).toBe(true);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('n=0 has the requested window as the period and one results row', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      writeJsonl(join(dir, 'sOut.jsonl'), [
        ask('SP', '2026-11-01T12:00:00Z', 'First request outside the period for a report'),
        ask('SP', '2026-11-01T12:00:01Z', 'Last request outside the period for a summing'),
        boundary('UP', '2026-11-01T12:00:02Z'),
        stateRow('SP', '2026-11-01T12:00:03Z', 'State outside: First request outside the period for a report and Last request outside the period for a summing'),
        apiRequest('SP', '2026-11-01T12:00:04Z'),
        assistant('SP', '2026-11-01T12:00:05Z', 'mp', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeCompact(env.compactFile, [compactAt('2026-11-01T12:00:02Z')]);
      const resultFile = join(env.dir, 'result-empty-period.json');
      const pw = run(env, ['--json', '--details', '--out', resultFile]);
      expect(pw.status).toBe(0);
      const r = JSON.parse(readFileSync(resultFile, 'utf8'));
      expect(r.n.value).toBe(0);
      expect(r.period).toEqual({ from: '2026-11-08T00:00:00Z', to: '2026-11-15T00:00:00Z' });
      expect(r.data_range).toBe('unavailable');
      expect(r.results.length).toBe(1);
      expect(r.results[0].name).toBe('compactions in period');
      expect([r.results[0].numerator, r.results[0].denominator]).toEqual([0, 0]);
      expect(r.verdicts).toEqual({});
      expect(r.units).toEqual([]);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('a call first seen in the window of one boundary and replayed after the next boundary is not a new call', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      const ts = (s) => `2026-11-14T12:00:${String(s).padStart(2, '0')}Z`;
      writeJsonl(join(dir, 'sR.jsonl'), [
        ask('SR', ts(0), 'First request R for a report'),
        ask('SR', ts(1), 'Last request R for a summing'),
        boundary('UR1', ts(2)),
        stateRow('SR', ts(3), 'State R1: First request R for a report and Last request R for a summing'),
        apiRequest('SR', ts(4)),
        assistant('SR', ts(5), 'm-old', 'test-model-b', [{ type: 'text', text: 'worked' }]),
        boundary('UR2', ts(10)),
        stateRow('SR', ts(11), 'State R2: First request R for a report and Last request R for a summing'),
        apiRequest('SR', ts(12)),
        assistant('SR', ts(13), 'm-old', 'test-model-b', [{ type: 'text', text: 'worked' }]),
        assistant('SR', ts(14), 'm-new', 'test-model-b', [{ type: 'thinking', thinking: 'x' }]),
      ]);
      writeCompact(env.compactFile, [compactAt(ts(2)), compactAt(ts(10))]);
      const r = resultJson(env, ['--details']);
      const j = Object.fromEntries(r.units.map((x) => [x.uuid, x]));
      expect(j.UR1.calls_count).toBe(1);
      expect(j.UR1.empty_calls).toBe(0);
      // the replayed m-old is a prior call; only m-new belongs to the second window, and it is empty
      expect(j.UR2.calls_count).toBe(1);
      expect(j.UR2.empty_calls).toBe(1);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('a state ending at the next boundary goes to a separate gap', () => {
    const env = makeEnv();
    try {
      const dir = join(env.projects, '-test');
      writeJsonl(join(dir, 'sL.jsonl'), [
        ask('SL', '2026-11-14T12:00:00Z', 'First request L for a report'),
        ask('SL', '2026-11-14T12:00:01Z', 'Last request L for a summing'),
        boundary('UL1', '2026-11-14T12:00:02Z'),
        stateRow('SL', '2026-11-14T12:00:03Z', 'State L1: First request L for a report and Last request L for a summing'),
        boundary('UL2', '2026-11-14T12:00:10Z'),
        stateRow('SL', '2026-11-14T12:00:11Z', 'State L2: First request L for a report and Last request L for a summing'),
        apiRequest('SL', '2026-11-14T12:00:12Z'),
        assistant('SL', '2026-11-14T12:00:13Z', 'ml', 'test-model-b', [{ type: 'text', text: 'ok' }]),
      ]);
      writeCompact(env.compactFile, [
        compactAt('2026-11-14T12:00:02Z'),
        compactAt('2026-11-14T12:00:10Z'),
      ]);
      const r = resultJson(env, ['--details']);
      expect(r.n.value).toBe(2);
      const lt = r.data_quality[1].gaps;
      expect(lt.boundaries_next_before_request).toBe(1);
      expect(lt.boundaries_without_api_request).toBe(0);
      const j = Object.fromEntries(r.units.map((x) => [x.uuid, x]));
      expect(j.UL1.head_level).toBe('unavailable');
      expect(j.UL2.head_level).toBe('full');
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('--out always writes JSON, also without --json', () => {
    const env = scenarioA();
    try {
      const file = join(env.dir, 'result-w.json');
      const pw = run(env, ['--out', file]);
      expect(pw.status).toBe(0);
      const r = JSON.parse(readFileSync(file, 'utf8'));
      expect(r.metric).toBe('ask-probe');
      expect(r.template).toBe('compaction-report/1');
      expect(pw.stdout.includes('X7Q')).toBe(false);
      expect(pw.stderr.includes('result saved')).toBe(true);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

describe('default journal path', () => {
  const journalRow = JSON.stringify({ ts: '2026-11-14T09:05:00Z', event: 'compact', session_id: 'S', agent_id: null, trigger: 'plugin', result: 'jev' });

  function runDefault(cwd, extraEnv) {
    const env = { ...process.env, ...extraEnv };
    if (!extraEnv.OMC_JEV_LOG_DIR) delete env.OMC_JEV_LOG_DIR;
    const transcript = join(cwd, 'transcript.jsonl');
    writeFileSync(transcript, '');
    return spawnSync('python3', ['-I', SCRIPT, '--transcript', transcript, '--to', '2026-11-15T00:00:00Z', '--json'], { encoding: 'utf8', cwd, env });
  }

  function projectWithJournal(root, name) {
    const cwd = join(root, name);
    const logDir = join(cwd, '.omc', 'state', 'jev');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'compaction.jsonl'), journalRow + '\n');
    return { cwd, journal: join(logDir, 'compaction.jsonl') };
  }

  it('without OMC_JEV_LOG_DIR reads .omc/state/jev/compaction.jsonl under the current directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const { cwd, journal } = projectWithJournal(root, 'proj');
      const proc = runDefault(cwd, {});
      expect(proc.status, proc.stderr).toBe(0);
      expect(JSON.stringify(JSON.parse(proc.stdout))).toContain(JSON.stringify(journal).slice(1, -1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('OMC_JEV_LOG_DIR wins over .omc/state/jev under the current directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const { cwd, journal } = projectWithJournal(root, 'proj');
      const envDir = join(root, 'env-dir');
      mkdirSync(envDir);
      const envJournal = join(envDir, 'compaction.jsonl');
      writeFileSync(envJournal, journalRow + '\n');
      const proc = runDefault(cwd, { OMC_JEV_LOG_DIR: envDir });
      expect(proc.status, proc.stderr).toBe(0);
      const text = JSON.stringify(JSON.parse(proc.stdout));
      expect(text).toContain(JSON.stringify(envJournal).slice(1, -1));
      expect(text).not.toContain(JSON.stringify(journal).slice(1, -1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('without OMC_JEV_LOG_DIR and without a journal under the current directory exits 2', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const proc = runDefault(root, {});
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain(join(root, '.omc', 'state', 'jev', 'compaction.jsonl'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--help names the default journal and the OMC_STATE_DIR case', () => {
    const proc = spawnSync('python3', ['-I', SCRIPT, '--help'], { encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout.replace(/\s+/g, ' ')).toContain('OMC_STATE_DIR');
  });
});
