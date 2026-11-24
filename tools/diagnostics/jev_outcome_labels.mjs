#!/usr/bin/env node
// Outcome labels for Jev decisions, joined offline from the journal files and the session transcripts.
//
// Standalone diagnostic run by hand: it reads files only (no network, no keys, no calls to Jev). It does not
// change OMC behaviour and is not shipped in the npm package (tools/ is not in the "files" list of package.json).
//
//   node tools/diagnostics/jev_outcome_labels.mjs --journal <journal dir> --transcripts <transcript dir>
//        [--from <ISO>] [--to <ISO>] [--session <id>] [--tsv <file>] [--json]
//
// Goal: each learner-extraction hint row (point learner-extraction in applied.jsonl) and each denial of an agent
// type (a deny row in agent-type.jsonl) gets an outcome label (executed, ignored, undetermined), by joining the
// journal row with the transcript of the same session by session_id and the timestamp ts.
// "executed" is a reaction (the agent called the Skill tool with remember, or the owner typed /remember), not a verdict
// on whether the hint was right: "executed" does not mean "correct"; it measures behaviour.
// Inputs (paths only from arguments; a missing required option = usage, exit 2; there are no default paths):
//   <journal dir>       directory with applied.jsonl and agent-type.jsonl, plus rotated files named
//                       <name>-YYYYMMDD-HHmmss.jsonl or <name>-YYYYMMDD-HHmmss-<pid>.jsonl (UTC). Read together and sorted by ts.
//                       applied row: {ts, point, tool_use_id?, session_id?, agent_id?, agent_type?, prompt_id?, cwd?, applied};
//                       agent-type row: {ts, point: "agent-type", ..., tool_name, subagent_type, mode, decision: allow|would-deny|deny|unparsed}.
//                       A row that is not valid JSON is skipped and counted separately.
//   <transcript dir>    Claude Code directory: <dir>/<project>/<session_id>.jsonl (a session; a file with that name
//                       one directory level down is also accepted) and <dir>/<project>/<session_id>/subagents/agent-<id>.jsonl
//                       (a subagent; also one level deeper). One JSONL row per entry; read fields: type (user, assistant;
//                       others are skipped), timestamp (ISO), message.content (text or blocks).
// Turn and window: a turn is a user entry that is NOT only tool results (tool_result blocks), with all the assistant work
// after it, up to the next such turn. The window is the rest of the turn in which the row's ts falls, plus the next 3 turns
// (entries with timestamp > ts).
// Learner-extraction label:
//   executed     the window has a Skill tool call whose skill name contains "remember" (e.g. "oh-my-claudecode:remember"),
//                or a user entry with the /remember command (also /oh-my-claudecode:remember, also inside <command-name>;
//                the command is recognised only at the start of the trimmed entry text or inside <command-name>…</command-name>;
//                a path such as skills/remember/SKILL.md inside the text is not a command);
//   ignored      the transcript has entries after ts and the window has none of the above; a transcript that ends before the
//                third turn also gives ignored, with the counter "window_incomplete" (turns seen after ts < 3; a turn still
//                running when the file is read counts as seen);
//   undetermined no transcript for the session, no entries after ts, no session_id, or an unreadable ts. Counted OUTSIDE the
//                denominator of the executed share.
// Denial label of agent types: only rows with decision deny. The label comes from the next agent-type row of the same session
// (and the same agent_id, when the deny row has one): decision allow = executed (the agent changed its type),
// deny or would-deny = ignored, no next row = undetermined; a next row with decision unparsed (or any other value besides
// allow, deny, would-deny) does not decide = undetermined. would-deny rows (shadow mode) are unlabelled and counted separately.
// A deny row without session_id does not join other sessions: its label is undetermined.
// Fixed label vocabulary: executed, ignored, undetermined. "undetermined" is reported as a separate count, outside the executed share.
// Grouping: by spec_version and jev_model; when the fields are absent the group is "no field"; n is counted per group.
// Rows with mode breaker, limit or degraded (if any) are not a verdict: outside the denominator, counted separately.
// Summary per point and group: n rows, labelled (executed + ignored), undetermined, coverage = labelled / n (ratio and percent),
// executed k out of labelled n; sample-size thresholds: DEEP 20 and min_support 30; with fewer than 30 labels the text
// "too little data" replaces the ratio; among the last 10 hints of a point: how many had no effect (ignored) out of how many
// labelled; threshold (c) 70 %: an unapproved proposal, a number only.
// Period (smallest and largest ts) and the denominator are given with every number.
// No interval is computed here: the Wilson interval is computed by wilson_threshold.mjs from the --tsv file; this script
// does not write that file's logic and does not carry a copy of its functions.
// Mode --session <id>: the decision timeline of one session (all applied rows of all points and agent-type rows of that
// session) in ts order: ts, point, mode, label (for points without a label "-"). Summaries and the TSV count only that session's rows.
// Output: numbers, identifiers and timestamps only; never the text of a hint, a command or a message (the systemMessage field of an
// applied row is NOT printed). --json gives valid JSON with the same numbers. --tsv <file>: the contract with wilson_threshold.mjs:
// a TSV with a header, UTF-8, tab separated, one row per journal row that has a label (rows with mode shadow are NOT written,
// because wilson_threshold would count them as undetermined; allow and unparsed rows are only context for a label).
// Columns, exactly: result, confidence, mode, point, spec_version, jev_model, session, ts.
// result: executed|ignored|undetermined; confidence: the numeric noul value of the applied object of the row (or of applied.action,
// the shape dev writes for warning and reminder decisions), otherwise empty;
// mode: active for applied rows and deny rows, shadow for would-deny rows, or the mode value of the row when it is breaker/limit/degraded.
// Exit codes: 0 valid run; 2 argument or input error (missing required option, unknown argument, bad --from/--to format,
// missing --journal or --transcripts directory, no readable applied.jsonl in --journal).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEEP_THRESHOLD = 20;
const MIN_SUPPORT = 30;
const WINDOW_TURNS = 3;
const LAST_N = 10;
const C_THRESHOLD_PERCENT = 70;
// /remember only at the start of the trimmed entry text, or inside <command-name>…</command-name>;
// a path such as skills/remember/SKILL.md inside a message is not a command
const COMMAND_AT_START_RE = /^\/(?:oh-my-claudecode:)?remember(?![\w-])/;
const COMMAND_IN_TAG_RE = /<command-name>\s*\/(?:oh-my-claudecode:)?remember(?![\w-])/;
const ROTATED_NAME_RE = /^(.+)-(\d{8})-\d{6}(?:-\d+)?\.jsonl$/;
const MODES_OUTSIDE_VERDICT = new Set(['breaker', 'limit', 'degraded']);
const LABEL_NONE = '-';
const NO_FIELD = 'no field';

function parseOptions(argv) {
  const result = { journal: null, transcripts: null, from: null, to: null, session: null, tsv: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') result.json = true;
    else if (a === '--journal' && argv[i + 1]) result.journal = argv[++i];
    else if (a === '--transcripts' && argv[i + 1]) result.transcripts = argv[++i];
    else if (a === '--from' && argv[i + 1]) result.from = argv[++i];
    else if (a === '--to' && argv[i + 1]) result.to = argv[++i];
    else if (a === '--session' && argv[i + 1]) result.session = argv[++i];
    else if (a === '--tsv' && argv[i + 1]) result.tsv = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!result.journal || !result.transcripts) throw new Error('missing required options --journal and --transcripts');
  for (const [name, value] of [['--from', result.from], ['--to', result.to]]) {
    if (value !== null && !Number.isFinite(Date.parse(value))) throw new Error(`bad time format ${name} ${value}: ISO expected`);
  }
  return result;
}

const toMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const toIso = (t) => new Date(t).toISOString();
const round4 = (x, places = 4) => Math.round(x * 10 ** places) / 10 ** places;
const percentText = (k, n) => (n > 0 ? `${(100 * k / n).toLocaleString('en-US', { maximumFractionDigits: 1 })} %` : 'not counted');
const textOf = (x) => (x === undefined || x === null ? '' : String(x));

function usage() {
  console.error(
    'usage: node tools/diagnostics/jev_outcome_labels.mjs --journal <journal dir> --transcripts <transcript dir>\n' +
    '       [--from <ISO>] [--to <ISO>] [--session <id>] [--tsv <file>] [--json]\n' +
    'outcome labels for Jev decisions, offline: executed/ignored/undetermined; details in the header of jev_outcome_labels.mjs.',
  );
}

/** Journal files: the base file plus rotated <name>-YYYYMMDD-HHmmss.jsonl files (no process id), names ascending (rotated before the base). */
function journalFiles(dir, name) {
  const base = join(dir, name);
  if (!existsSync(base)) return [];
  const rotated = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = ROTATED_NAME_RE.exec(e.name);
    if (m && m[1] === name.replace(/\.jsonl$/, '')) rotated.push(e.name);
  }
  rotated.sort();
  const result = rotated.map((r) => join(dir, r));
  result.push(base);
  return result;
}

/** Rows of one JSONL file: good rows to the list, bad ones to the counter. */
function readJsonlFile(path, rows, unreadable) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const w = JSON.parse(line);
      if (w && typeof w === 'object' && !Array.isArray(w)) rows.push(w);
      else unreadable.count += 1;
    } catch { unreadable.count += 1; }
  }
}

/** Rows of a journal (base + rotated together), sorted by ts (ties: file order). Returns [{row, t}]. */
function readJournal(dir, name, unreadable, stats) {
  const files = journalFiles(dir, name);
  if (!files.length) return [];
  const rows = [];
  for (const p of files) readJsonlFile(p, rows, unreadable);
  const withSeq = rows.map((row, i) => ({ row, t: toMs(row.ts), seq: i }));
  withSeq.sort((a, b) => {
    if (a.t === null && b.t === null) return a.seq - b.seq;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return (a.t - b.t) || (a.seq - b.seq);
  });
  stats[name] = { files: files.length, rows: withSeq.length };
  return withSeq;
}

/** Transcript of a session as entries [{t, turn, skillRemember, commandRemember}] sorted by t; null when the file is missing or unreadable. */
const transcriptCache = new Map();
function transcriptEntries(path) {
  if (transcriptCache.has(path)) return transcriptCache.get(path);
  let result = null;
  try {
    const text = readFileSync(path, 'utf8');
    result = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let w;
      try { w = JSON.parse(line); } catch { continue; }
      if (!w || typeof w !== 'object') continue;
      // entries without a timestamp are skipped (they cannot be placed in time)
      const t = toMs(w.timestamp);
      if (t === null) continue;
      const type = w.type;
      if (type !== 'user' && type !== 'assistant') continue;
      const content = w.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      if (type === 'assistant') {
        let skillRemember = false;
        for (const b of blocks) {
          if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string' && b.input.skill.includes('remember')) skillRemember = true;
        }
        result.push({ t, turn: false, skillRemember, commandRemember: false });
      } else {
        // a user entry is a turn unless it consists only of tool results
        const onlyToolResults = blocks.length > 0 && blocks.every((b) => b?.type === 'tool_result');
        const turn = !(Array.isArray(content) && onlyToolResults);
        let commandRemember = false;
        if (turn) {
          const texts = typeof content === 'string' ? [content] : blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
          commandRemember = texts.some((x) => COMMAND_AT_START_RE.test(x.trim()) || COMMAND_IN_TAG_RE.test(x));
        }
        result.push({ t, turn, skillRemember: false, commandRemember });
      }
    }
    result.sort((a, b) => a.t - b.t);
  } catch { result = null; }
  transcriptCache.set(path, result);
  return result;
}

/** Transcript of a session <dir>/<project>/<session_id>.jsonl: a file with that name one directory level down; null when absent. */
function sessionTranscript(dir, session) {
  if (!session || typeof session !== 'string') return null;
  const name = `${session}.jsonl`;
  let subdirs = [];
  try { subdirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return null; }
  for (const sub of subdirs) {
    const p = join(dir, sub, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Transcript of a subagent <dir>/<project>/<session>/subagents/agent-<id>.jsonl (also one level deeper); null when absent. */
function subagentTranscript(dir, session, agentId) {
  if (!session || typeof session !== 'string' || !agentId || typeof agentId !== 'string') return null;
  const name = `agent-${agentId}.jsonl`;
  let dirs = [];
  try { dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return null; }
  for (const sub of dirs) {
    const sessionDir = join(dir, sub, session);
    if (!existsSync(sessionDir)) continue;
    const subagents = join(sessionDir, 'subagents');
    const levels = [subagents];
    try {
      for (const e of readdirSync(subagents, { withFileTypes: true })) {
        if (e.isDirectory()) levels.push(join(subagents, e.name));
      }
    } catch { levels.length = 1; }
    levels.sort();
    for (const level of levels) {
      const p = join(level, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Learner-extraction label from the 3-turn window in the session or subagent transcript. Returns {result, windowIncomplete}. */
function learnerLabel(row, t, transcriptsDir) {
  const session = typeof row.session_id === 'string' ? row.session_id : null;
  if (!session || t === null) return { result: 'undetermined', windowIncomplete: false };
  const path = row.agent_id ? subagentTranscript(transcriptsDir, session, row.agent_id) : sessionTranscript(transcriptsDir, session);
  if (!path) return { result: 'undetermined', windowIncomplete: false };
  const entries = transcriptEntries(path);
  if (!entries) return { result: 'undetermined', windowIncomplete: false };
  const after = entries.filter((e) => e.t > t);
  if (after.length === 0) return { result: 'undetermined', windowIncomplete: false };
  let turnNumber = 0;
  let turnsSeen = 0;
  let hit = false;
  for (const e of after) {
    if (e.turn) { turnsSeen += 1; turnNumber = turnsSeen; }
    if (turnNumber > WINDOW_TURNS) break;
    if (e.skillRemember || e.commandRemember) { hit = true; break; }
  }
  if (hit) return { result: 'executed', windowIncomplete: false };
  return { result: 'ignored', windowIncomplete: turnsSeen < WINDOW_TURNS };
}

/** Grouping key: a field that is not a non-empty string is "no field". */
function rowGroup(row) {
  const field = (x) => (typeof x === 'string' && x !== '' ? x : NO_FIELD);
  return { spec_version: field(row.spec_version), jev_model: field(row.jev_model) };
}

/**
 * Confidence of a row: the numeric noul of the applied object (the shape of this port's own journal rows), otherwise the
 * numeric noul under applied.action (the shape dev writes for warning and reminder decisions); null when neither is numeric.
 */
function confidenceOf(row) {
  const isNumber = (x) => typeof x === 'number' && Number.isFinite(x);
  if (isNumber(row.applied?.noul)) return row.applied.noul;
  if (isNumber(row.applied?.action?.noul)) return row.applied.action.noul;
  return null;
}

/** Mode of a row: applied and deny are active, would-deny is shadow; a mode breaker/limit/degraded wins (outside verdict). */
function rowMode(row, source) {
  if (typeof row.mode === 'string' && MODES_OUTSIDE_VERDICT.has(row.mode)) return row.mode;
  if (source === 'applied') return 'active';
  return row.decision === 'deny' ? 'active' : 'shadow';
}

/** Whether a row enters the analysis and the TSV: applied learner-extraction, or agent-type deny/would-deny. */
function isAnalysedRow(row, source) {
  if (source === 'applied') return row.point === 'learner-extraction';
  return row.point === 'agent-type' && (row.decision === 'deny' || row.decision === 'would-deny');
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  for (const [name, path] of [['--journal', options.journal], ['--transcripts', options.transcripts]]) {
    if (!existsSync(path)) throw new Error(`directory ${name} does not exist: ${path}`);
  }
  const unreadable = { count: 0 };
  const stats = {};
  const applied = readJournal(options.journal, 'applied.jsonl', unreadable, stats);
  // no applied.jsonl (or an empty file) is an input error
  if (applied.length === 0) throw new Error(`no readable applied.jsonl in --journal: ${options.journal}`);
  const agentType = readJournal(options.journal, 'agent-type.jsonl', unreadable, stats);

  const fromT = options.from !== null ? toMs(options.from) : null;
  const toT = options.to !== null ? toMs(options.to) : null;
  const inPeriod = (t) => (fromT === null || t === null || t >= fromT) && (t === null || toT === null || t <= toT);
  const sessionMatches = (row) => (options.session === null || row.session_id === options.session);
  const journalRows = [
    ...applied.map(({ row, t }) => ({ row, source: 'applied', t })),
    ...agentType.map(({ row, t }) => ({ row, source: 'agent-type', t })),
  ].filter(({ row, t }) => inPeriod(t) && sessionMatches(row));

  // learner label from the transcript
  const learnerLabels = new Map();
  for (const { row, source, t } of journalRows) {
    if (source === 'applied' && row.point === 'learner-extraction') {
      learnerLabels.set(row, learnerLabel(row, t, options.transcripts));
    }
  }
  // agent-type deny label: the next row of the same session (and agent_id)
  const agentTypeRows = journalRows.filter((r) => r.source === 'agent-type');
  const agentTypeGroups = new Map();
  for (const r of agentTypeRows) {
    const key = `${textOf(r.row.session_id)}\u0000${textOf(r.row.agent_id)}`;
    if (!agentTypeGroups.has(key)) agentTypeGroups.set(key, []);
    agentTypeGroups.get(key).push(r);
  }
  const agentTypeLabels = new Map();
  for (const list of agentTypeGroups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const { row } = list[i];
      if (row.decision !== 'deny') continue;
      const next = list[i + 1];
      const nextDecision = next?.row.decision;
      // a deny without session_id joins nothing: its label is undetermined
      const result = !(typeof row.session_id === 'string' && row.session_id !== '') ? 'undetermined'
        : (next === undefined ? 'undetermined'
          : nextDecision === 'allow' ? 'executed'
            : nextDecision === 'deny' || nextDecision === 'would-deny' ? 'ignored'
              : 'undetermined');
      agentTypeLabels.set(row, { result, nextDecision: nextDecision ?? null });
    }
  }
  // analysis record per row
  const analysed = [];
  for (const { row, source, t } of journalRows) {
    if (!isAnalysedRow(row, source)) continue;
    const mode = rowMode(row, source);
    const outsideVerdict = MODES_OUTSIDE_VERDICT.has(mode);
    const label = source === 'applied' ? learnerLabels.get(row) : agentTypeLabels.get(row);
    // a row outside the verdict (mode breaker/limit/degraded) gets no label: empty result, outside the denominator
    const result = outsideVerdict ? null : label?.result ?? null;
    analysed.push({
      row, source, t,
      group: rowGroup(row),
      result,
      confidence: confidenceOf(row),
      mode,
      windowIncomplete: !outsideVerdict && label?.windowIncomplete === true,
      point: typeof row.point === 'string' ? row.point : '',
      session: textOf(row.session_id),
      ts: typeof row.ts === 'string' ? row.ts : (t !== null ? toIso(t) : ''),
    });
  }

  // summary per point and group
  const pointNames = [...new Set(analysed.map((r) => r.point))];
  const points = pointNames.map((name) => {
    const pointRows = analysed.filter((r) => r.point === name);
    const groupKeys = [...new Set(pointRows.map((r) => `${r.group.spec_version}\u0000${r.group.jev_model}`))];
    const groups = groupKeys.map((key) => {
      const w = pointRows.filter((r) => `${r.group.spec_version}\u0000${r.group.jev_model}` === key);
      const executed = w.filter((r) => r.result === 'executed').length;
      const ignored = w.filter((r) => r.result === 'ignored').length;
      const undetermined = w.filter((r) => r.result === 'undetermined').length;
      const labelled = executed + ignored;
      const n = w.length;
      const times = w.map((r) => r.t).filter((x) => x !== null);
      const last = w.slice(-LAST_N);
      const lastLabelled = last.filter((r) => r.result === 'executed' || r.result === 'ignored').length;
      const lastIgnored = last.filter((r) => r.result === 'ignored').length;
      return {
        spec_version: w[0].group.spec_version,
        jev_model: w[0].group.jev_model,
        n, labelled, executed, ignored, undetermined,
        window_incomplete: w.filter((r) => r.windowIncomplete === true).length,
        would_deny: w.filter((r) => r.mode === 'shadow').length,
        outside_verdict: w.filter((r) => MODES_OUTSIDE_VERDICT.has(r.mode)).length,
        period: { from: times.length ? toIso(Math.min(...times)) : null, to: times.length ? toIso(Math.max(...times)) : null },
        coverage: { k: labelled, n, share: n > 0 ? round4(labelled / n) : null },
        executed_share: { k: executed, n: labelled, share: labelled > 0 ? round4(executed / labelled) : null, assessment: labelled >= MIN_SUPPORT ? percentText(executed, labelled) : 'too little data' },
        thresholds: {
          deep20: labelled >= DEEP_THRESHOLD ? 'sufficient' : 'too little data',
          min_support: labelled >= MIN_SUPPORT ? 'sufficient' : 'too little data',
          last10: { ignored: lastIgnored, labelled: lastLabelled, of_last: last.length, c_percent: C_THRESHOLD_PERCENT, note: 'threshold (c) 70 %: unapproved proposal, a number only' },
        },
      };
    });
    const executedTotal = pointRows.filter((r) => r.result === 'executed').length;
    const ignoredTotal = pointRows.filter((r) => r.result === 'ignored').length;
    const undeterminedTotal = pointRows.filter((r) => r.result === 'undetermined').length;
    const labelledTotal = executedTotal + ignoredTotal;
    const pointTimes = pointRows.map((r) => r.t).filter((x) => x !== null);
    return {
      point: name,
      total: {
        n: pointRows.length,
        labelled: labelledTotal, executed: executedTotal, ignored: ignoredTotal, undetermined: undeterminedTotal,
        window_incomplete: pointRows.filter((r) => r.windowIncomplete === true).length,
        would_deny: pointRows.filter((r) => r.mode === 'shadow').length,
        outside_verdict: pointRows.filter((r) => MODES_OUTSIDE_VERDICT.has(r.mode)).length,
        coverage: { k: labelledTotal, n: pointRows.length, share: pointRows.length > 0 ? round4(labelledTotal / pointRows.length) : null },
        executed_share: { k: executedTotal, n: labelledTotal, share: labelledTotal > 0 ? round4(executedTotal / labelledTotal) : null },
        assessment: labelledTotal >= MIN_SUPPORT ? percentText(executedTotal, labelledTotal) : 'too little data',
      },
      groups,
      period: { from: pointTimes.length ? toIso(Math.min(...pointTimes)) : null, to: pointTimes.length ? toIso(Math.max(...pointTimes)) : null },
    };
  });

  const allTimes = journalRows.map(({ t }) => t).filter((x) => x !== null);
  const totalPeriod = { from: allTimes.length ? toIso(Math.min(...allTimes)) : null, to: allTimes.length ? toIso(Math.max(...allTimes)) : null };

  // decision timeline of one session (--session): all applied rows (all points) and agent-type rows of the session in ts order
  const timeline = options.session === null ? null : journalRows
    .slice()
    .sort((a, b) => (a.t === null ? 1 : b.t === null ? -1 : (a.t - b.t) || 0))
    .map(({ row, source, t }) => ({
      ts: typeof row.ts === 'string' ? row.ts : (t !== null ? toIso(t) : ''),
      point: typeof row.point === 'string' ? row.point : '',
      mode: rowMode(row, source),
      label: learnerLabels.get(row)?.result ?? agentTypeLabels.get(row)?.result ?? LABEL_NONE,
    }));

  // TSV (contract with wilson_threshold.mjs: column names and values are fixed)
  const tsvColumns = ['result', 'confidence', 'mode', 'point', 'spec_version', 'jev_model', 'session', 'ts'];
  const tsvLine = (r) => [
    textOf(r.result),
    r.confidence === null ? '' : String(r.confidence),
    r.mode,
    r.point,
    r.group.spec_version === NO_FIELD ? '' : r.group.spec_version,
    r.group.jev_model === NO_FIELD ? '' : r.group.jev_model,
    r.session,
    r.ts,
  ].join('\t');
  // would-deny rows (shadow mode) are kept out of the TSV: wilson_threshold would count them as undetermined;
  // they stay in the per-point summary (would_deny) and on the --session timeline
  const tsv = [tsvColumns.join('\t'), ...analysed.filter((r) => r.mode !== 'shadow').map(tsvLine)].join('\n') + '\n';
  if (options.tsv !== null) writeFileSync(options.tsv, tsv, 'utf8');

  const totalResult = {
    period: totalPeriod,
    journal_rows: {
      applied: stats['applied.jsonl']?.rows ?? 0,
      applied_files: stats['applied.jsonl']?.files ?? 0,
      agent_type: stats['agent-type.jsonl']?.rows ?? 0,
      agent_type_files: stats['agent-type.jsonl']?.files ?? 0,
    },
    unreadable_rows: unreadable.count,
    points,
    tsv_rows: analysed.length,
  };
  if (timeline !== null) {
    totalResult.session = options.session;
    totalResult.session_timeline = timeline;
  }

  if (options.json) console.log(JSON.stringify(totalResult));
  else console.log(summaryText(totalResult));
  process.exit(0);
}

/** Text output: numbers, identifiers and timestamps only, without the text of hints and messages. */
function summaryText(w) {
  const lines = [];
  lines.push(`jev_outcome_labels: period ${w.period.from ?? 'unknown'} to ${w.period.to ?? 'unknown'}, journal rows: applied ${w.journal_rows.applied} in ${w.journal_rows.applied_files} files, agent-type ${w.journal_rows.agent_type} in ${w.journal_rows.agent_type_files} files, unreadable rows: ${w.unreadable_rows}`);
  for (const p of w.points) {
    lines.push(`point ${p.point}: n=${p.total.n}, labelled ${p.total.labelled}/${p.total.n} (${p.total.labelled > 0 && p.total.n > 0 ? (100 * p.total.labelled / p.total.n).toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0'} %), undetermined ${p.total.undetermined} (outside the denominator), executed ${p.total.executed}, ignored ${p.total.ignored}, window incomplete ${p.total.window_incomplete}, would-deny (shadow) ${p.total.would_deny}, outside verdict ${p.total.outside_verdict}, period ${p.period.from ?? '?'} to ${p.period.to ?? '?'}`);
    lines.push(`  executed share on the point: ${p.total.assessment} (k=${p.total.executed_share.k}, n=${p.total.executed_share.n}; threshold ${p.total.assessment === 'too little data' ? '30 labels (min_support)' : ''})`);
    for (const g of p.groups) {
      lines.push(`  group spec_version=${g.spec_version} jev_model=${g.jev_model}: n=${g.n}, labelled ${g.labelled}/${g.n}, undetermined ${g.undetermined}, executed ${g.executed}, ignored ${g.ignored}, window incomplete ${g.window_incomplete}, would-deny ${g.would_deny}, outside verdict ${g.outside_verdict}, period ${g.period.from ?? '?'} to ${g.period.to ?? '?'}`);
      lines.push(`  label thresholds: DEEP 20: ${g.thresholds.deep20}, min_support 30: ${g.thresholds.min_support}`);
      lines.push(`  last 10: no effect (ignored) ${g.thresholds.last10.ignored} of ${g.thresholds.last10.labelled} labelled (of the last ${g.thresholds.last10.of_last}); threshold (c) 70 %: unapproved proposal, a number only`);
    }
  }
  if (w.session_timeline) {
    lines.push(`decision timeline of session ${w.session}: ${w.session_timeline.length} decisions`);
    for (const z of w.session_timeline) lines.push(`${z.ts}\t${z.point}\t${z.mode}\t${z.label}`);
  }
  return lines.join('\n');
}

try {
  main();
} catch (error) {
  console.error(`jev_outcome_labels: argument or input error: ${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exit(2);
}
