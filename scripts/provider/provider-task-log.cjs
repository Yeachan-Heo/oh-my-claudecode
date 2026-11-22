#!/usr/bin/env node
// Task journal of provider tasks, built from the team transcript. `provider-task-log.cjs <id>` prints a JSON row
// (no write); `provider-task-log.cjs write <id>` appends the row to <stateDir>/tasks.jsonl (at most once per id,
// rotation to .1 at 8 MiB, switch OMC_PROVIDER_TASK_LOG=off). The row holds metadata only: id, team, session,
// status (verdict.status from the task file), duration (from the task file to the last transcript timestamp or the
// `end` row of the worker event journal), the ordered model (started_with.model from the worker event journal, the
// fallback is the haiku model of the profile, which is the sonnet model without a haiku one) and the used model
// (message.model of the transcript, the last answer wins), tokens from usage (summed over unique message.id
// answers, from the first row of an id; a row without message.id is counted per row: in, out, cache =
// cache_creation + cache_read), the context window fill = the HIGHEST fill of ONE turn (in + cache_creation +
// cache_read + out) divided by the window (profile.contextWindow when the used or ordered model has [1m] or the
// used model is one of the profile models or starts with a profile model id prefix; otherwise 200 000; the
// transcript stores message.model without the suffix, e.g. the model of a session run on a [1m] variant), turns =
// the number of unique message.id answers (a row without message.id is a turn); assistant rows with model
// '<synthetic>' (API error, text 'API Error: ...') are skipped everywhere: not a turn, not the used model, not
// has_text (empty_response), not tokens or fill; only synthetic rows = empty_response.
// Bash calls (tool_use name=Bash) with failures (is_error in the paired tool_result) and the code of the last
// call (toolUseResult.returnCode when a number; otherwise with is_error the N of 'Exit code <N>' at the start of
// the tool_result content, the content a string or an array of {type:'text',text} blocks; is_error without the
// pattern (hook denial, interruption) = 1; without is_error 0), the number of advisor consultations (end rows of the
// advisor journal whose job_id starts with <team>/), warnings very_short_run (duration < 45 s), empty_response (no
// assistant row has non-empty text), success_without_changes (git diff base..branch empty with status success;
// without the branch or the repo the git fields stay null and there is no warning), model_mismatch. The failure
// class comes from the worker event journal (the class field). Extra fields: branch, base_sha (12 characters, so
// it survives the redaction of 40+ character blobs), files_changed/added/removed (numbers only, from git diff
// --shortstat, no file paths) and the options of taskRow(id, opts) and writeRow(id, opts): { env, profile,
// git: false (skips git), gitBin }; the git binary is opts.gitBin, then OMC_PROVIDER_TASK_GIT_BIN, then 'git'.
// Redaction (mask) is applied to every text field of the row and of the header: no task text, answers, paths or secrets.
// Zero counted from the transcript stays zero in the row and the header ("failures 0", "turns 0"), and null means
// only "could not be determined" (no transcript file): tokens_*, turns, bash_calls and bash_failures are null only
// without a transcript file; bash_last_code is unchanged (null = no Bash results in the transcript).
// With require the module exports { taskRow, writeRow, resultHeader } and does nothing else (main runs only with require.main === module).
'use strict';
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { loadProfile, statePath } = require('./lib/profile.cjs');
const { mask } = require('./lib/redact.cjs');
const { EXIT, TASK_WARNINGS, taskSubject } = require('./lib/vocab.cjs');

const ROTATE_BYTES = 8 * 1024 * 1024; // bytes; rotation threshold of tasks.jsonl (tests change it with OMC_PROVIDER_TASK_LOG_ROTATE_BYTES)
const SHORT_RUN_S = 45;
const DEFAULT_WINDOW = 200_000;
const has1m = (s) => typeof s === 'string' && s.includes('[1m]');
const without1m = (s) => String(s).replace(/\[1m\]$/, '');

// Model ids of the profile by alias: the haiku model is optional and falls back to the sonnet one.
const modelId = (profile, alias) => profile.models?.[alias]?.id ?? (alias === 'haiku' ? profile.models?.sonnet?.id : undefined);

// Context window of the used model: the window of the profile when the used or ordered model has the [1m]
// suffix, or the used model is a model of the profile or starts with one of its model id prefixes.
const windowFor = (profile, modelUsed, modelOrdered) => {
  const ids = ['opus', 'sonnet', 'haiku'].map((a) => modelId(profile, a)).filter(Boolean).map(without1m);
  const prefixes = profile.modelIdPrefixes ?? [];
  const known = typeof modelUsed === 'string' && (ids.includes(without1m(modelUsed)) || prefixes.some((p) => modelUsed.startsWith(p)));
  return has1m(modelUsed) || has1m(modelOrdered) || known ? profile.contextWindow : DEFAULT_WINDOW;
};

// JSONL rows: broken lines are skipped, a missing file is an empty array.
const readJsonlRows = (file) => {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a damaged line does not stop the reader */ }
  }
  return out;
};

// Rows point=team-worker and team=task team of the worker event journal: session_id, started_with and name from
// the newest row that has them (the `end` row carries no session_id), class and the end marker from the last row
// with a class field / result=end.
const sessionOfTask = (profile, env, team) => {
  const rows = readJsonlRows(statePath(profile, env, 'workers.jsonl')).filter((w) => w && w.point === 'team-worker' && w.team === team);
  if (!rows.length) return null;
  const fromEnd = [...rows].reverse();
  const withField = (field) => fromEnd.find((w) => w[field] != null);
  return {
    session_id: typeof withField('session_id')?.session_id === 'string' ? withField('session_id').session_id : null,
    started_with: withField('started_with')?.started_with && typeof withField('started_with').started_with === 'object' ? withField('started_with').started_with : null,
    name: typeof withField('name')?.name === 'string' ? withField('name').name : null,
    class: fromEnd.find((w) => w.class != null)?.class ?? null,
    end_ts: fromEnd.find((w) => w.result === 'end' && typeof w.ts === 'string')?.ts ?? null,
  };
};

// Transcript <session_id>.jsonl: searched in all subdirectories of <HOME>/.claude/projects/ (the directory name is not rebuilt from the cwd).
const findTranscript = (sid, env) => {
  if (!sid) return null;
  const projects = join(env.HOME || homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, `${sid}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
};

// Content of a tool_result: a string or an array of {type:'text', text} blocks.
const resultText = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
  return '';
};
// Code of the last Bash call: returnCode, when it is a number, wins; otherwise with is_error the N of 'Exit code <N>' at the start
// of the tool_result content; is_error without the pattern (hook denial, interruption) = 1; without is_error 0.
const bashCode = (toolResult, toolUseResult) => {
  const rc = toolUseResult && toolUseResult.returnCode;
  if (rc != null && Number.isFinite(Number(rc))) return Number(rc);
  if (!toolResult.is_error) return 0;
  const m = /^Exit code (\d+)/.exec(resultText(toolResult.content));
  return m ? Number(m[1]) : 1;
};

// Numbers from the transcript: turns (unique message.id), model, tokens (sum of usage over unique ids, from the
// first row), the highest fill of one turn, Bash (tool_use -> tool_result by tool_use_id), text (for
// empty_response), the last timestamp. Assistant rows with message.model '<synthetic>' (an API error row) are
// skipped in turns, the used model, has_text, the window fill and the token sums.
const analyzeTranscript = (file) => {
  const out = { turns: 0, synthetic_turns: 0, model_used: null, tokens_in: 0, tokens_out: 0, tokens_cache: 0, fill_max: 0, bash_calls: 0, bash_failures: 0, bash_last_code: null, has_text: false, last_ts: null };
  const bash = new Map(); // tool_use_id -> whether the last tool_result was an error
  const seenIds = new Set(); // message.id values already counted
  for (const w of readJsonlRows(file)) {
    if (typeof w.timestamp === 'string') out.last_ts = w.timestamp;
    const m = w.message;
    if (w.type === 'assistant') {
      if (m && m.model === '<synthetic>') { out.synthetic_turns++; continue; }
      // Deduplication by message.id: the transcript writes one assistant row per content block; rows of the same
      // answer share the message.id and have identical usage, so turns and tokens are counted once per id, from the
      // first row; a row without message.id is counted per row. Content blocks (text, tool_use) differ per row, so
      // text and Bash are counted from every row.
      const mid = m && typeof m.id === 'string' && m.id ? m.id : null;
      const newTurn = !mid || !seenIds.has(mid);
      if (mid && newTurn) seenIds.add(mid);
      if (newTurn) {
        out.turns++;
        if (m && typeof m.model === 'string' && m.model) out.model_used = m.model;
        const u = m && m.usage;
        if (u && typeof u === 'object') {
          const inTokens = Number(u.input_tokens) || 0;
          const outTokens = Number(u.output_tokens) || 0;
          const cache = (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
          out.tokens_in += inTokens;
          out.tokens_out += outTokens;
          out.tokens_cache += cache;
          // The window fill measures the context of ONE turn, not the sum over turns (the sum counts the context many times).
          out.fill_max = Math.max(out.fill_max, inTokens + outTokens + cache);
        }
      }
      const c = m && Array.isArray(m.content) ? m.content : [];
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.has_text = true;
        if (b && b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') { out.bash_calls++; bash.set(b.id, false); }
      }
    } else if (w.type === 'user') {
      const c = m && Array.isArray(m.content) ? m.content : [];
      for (const b of c) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && bash.has(b.tool_use_id)) {
          bash.set(b.tool_use_id, Boolean(b.is_error)); // the last tool result wins
          out.bash_last_code = bashCode(b, w.toolUseResult);
        }
      }
    }
  }
  for (const failed of bash.values()) if (failed) out.bash_failures++;
  return out;
};

// Consultations: job_id = OMC_TEAM_WORKER = <team>/<worker>, so the rows of the team are counted.
// Each consultation has a start row and an end row in the advisor journal (a cache hit has a cache row): only end rows count.
const countConsultations = (file, teamPrefix) => readJsonlRows(file)
  .filter((w) => w.type === 'end' && typeof w.job_id === 'string' && w.job_id.startsWith(teamPrefix))
  .length;

// Git binary: the test option gitBin, then OMC_PROVIDER_TASK_GIT_BIN, then 'git'.
const git = (args, cwd, env, opts) => {
  try {
    const r = spawnSync(opts?.gitBin || env.OMC_PROVIDER_TASK_GIT_BIN || 'git', args, { cwd, encoding: 'utf8', env });
    return { code: r.status, out: (r.stdout || '').trim() };
  } catch { return { code: null, out: '' }; }
};

// " 3 files changed, 120 insertions(+), 40 deletions(-)" -> numbers; no file paths.
const parseShortstat = (text) => {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(text || '');
  return m ? { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) } : null;
};
// Branch of a worker in named mode (omc-team/<team>/<worker>), the base (merge-base with HEAD of the lead repo)
// and the numeric diff statistics. Branch or repo missing: the fields stay null and there is no success_without_changes warning.
const gitPart = (team, worker, cwd, status, env, opts) => {
  const out = { branch: null, base_sha: null, files_changed: null, added: null, removed: null, success_without_changes: false };
  if (opts?.git === false || !worker || !cwd) return out;
  const branch = `omc-team/${team}/${worker}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, env, opts).code !== 0) return out;
  out.branch = branch;
  const base = git(['merge-base', branch, 'HEAD'], cwd, env, opts);
  let diff = { code: null, out: '' };
  if (base.code === 0 && /^[0-9a-f]{40,}$/.test(base.out)) {
    out.base_sha = base.out.slice(0, 12);
    diff = git(['diff', '--shortstat', `${base.out}..${branch}`], cwd, env, opts);
    const stat = parseShortstat(diff.out);
    if (stat) { out.files_changed = stat.files; out.added = stat.added; out.removed = stat.removed; }
  }
  // success_without_changes: status success and an empty base..branch diff (the diff worked and printed nothing)
  if (status === 'success' && diff.code === 0 && !diff.out) out.success_without_changes = true;
  return out;
};

// Redaction (mask) of every text field (also the elements of arrays).
const redactRow = (w) => {
  const out = {};
  for (const [k, v] of Object.entries(w)) {
    if (typeof v === 'string') out[k] = mask(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? mask(x) : x));
    else out[k] = v;
  }
  return out;
};

const profileOf = (opts, env) => opts.profile || loadProfile(env).profile;

// Journal row for an id (the facts for provider-task result); null when there is no task file.
const taskRow = (id, opts = {}) => {
  const env = opts.env || process.env;
  const profile = profileOf(opts, env);
  const taskFile = (() => {
    try { return JSON.parse(readFileSync(statePath(profile, env, 'tasks', `${id}.json`), 'utf8')); } catch { return null; }
  })();
  if (!taskFile || typeof taskFile !== 'object') return null;
  const taskId = typeof taskFile.id === 'string' && taskFile.id ? taskFile.id : id;
  const team = typeof taskFile.team === 'string' && taskFile.team ? taskFile.team : taskSubject(taskId);
  const session = sessionOfTask(profile, env, team);
  const worker = session?.name ? (session.name.split('/').slice(1).join('/') || null) : null;
  // The presence of a transcript separates "zero counted" (a transcript exists, the counters may be 0) from "could not be determined" (no transcript: null).
  const transcriptFile = findTranscript(session?.session_id, env);
  const analysis = analyzeTranscript(transcriptFile);
  const fromTranscript = Boolean(transcriptFile);
  const startMs = Date.parse(taskFile.start);
  const endMs = (() => {
    const ts = analysis.last_ts || session?.end_ts;
    if (!ts) return null;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
  })();
  const durationS = Number.isFinite(startMs) && endMs != null ? (endMs - startMs) / 1000 : null;
  const status = taskFile.verdict && typeof taskFile.verdict.status === 'string' ? taskFile.verdict.status : null;
  const modelOrdered = session?.started_with?.model || modelId(profile, 'haiku');
  const warnings = [];
  if (durationS != null && durationS < SHORT_RUN_S) warnings.push(TASK_WARNINGS.VERY_SHORT_RUN);
  // A synthetic row alone (synthetic_turns > 0) is also a run without an answer: without it an API error at the end would not give empty_response.
  if (analysis.turns + analysis.synthetic_turns > 0 && !analysis.has_text) warnings.push(TASK_WARNINGS.EMPTY_RESPONSE);
  if (analysis.model_used) {
    const expected = modelId(profile, modelOrdered) || modelOrdered;
    if (without1m(analysis.model_used) !== without1m(expected)) warnings.push(TASK_WARNINGS.MODEL_MISMATCH);
  }
  const windowPercent = analysis.model_used && analysis.fill_max > 0
    ? Math.round((analysis.fill_max / windowFor(profile, analysis.model_used, modelOrdered)) * 10000) / 100
    : null;
  const gitInfo = gitPart(team, worker, taskFile.cwd, status, env, opts);
  if (gitInfo.success_without_changes) warnings.push(TASK_WARNINGS.SUCCESS_WITHOUT_CHANGES);
  const advisorLog = env.OMC_PROVIDER_ADVISOR_LOG_FILE || statePath(profile, env, 'advisor.jsonl');
  return redactRow({
    id: taskId,
    team,
    session_id: session?.session_id ?? null,
    start: typeof taskFile.start === 'string' ? taskFile.start : null,
    duration_s: durationS == null ? null : Math.round(durationS * 1000) / 1000,
    status,
    model_ordered: modelOrdered,
    model_used: analysis.model_used,
    // Zero counted from the transcript stays zero (not null); null only without a transcript (could not be determined).
    tokens_in: fromTranscript ? analysis.tokens_in : null,
    tokens_out: fromTranscript ? analysis.tokens_out : null,
    tokens_cache: fromTranscript ? analysis.tokens_cache : null,
    window_percent: windowPercent,
    turns: fromTranscript ? analysis.turns : null,
    bash_calls: fromTranscript ? analysis.bash_calls : null,
    bash_failures: fromTranscript ? analysis.bash_failures : null,
    bash_last_code: analysis.bash_last_code,
    consultations: countConsultations(advisorLog, `${team}/`),
    warnings,
    class: session?.class ?? null,
    branch: gitInfo.branch,
    base_sha: gitInfo.base_sha,
    files_changed: gitInfo.files_changed,
    added: gitInfo.added,
    removed: gitInfo.removed,
  });
};

// Appends the row to <stateDir>/tasks.jsonl at most once per id; rotation at the threshold to .1;
// OMC_PROVIDER_TASK_LOG=off disables. false = nothing written.
const writeRow = (id, opts = {}) => {
  const env = opts.env || process.env;
  if (String(env.OMC_PROVIDER_TASK_LOG || '').trim().toLowerCase() === 'off') return false;
  const profile = profileOf(opts, env);
  const row = taskRow(id, { ...opts, profile });
  if (!row) return false;
  const dir = statePath(profile, env);
  const file = join(dir, 'tasks.jsonl');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const size = (() => { try { return statSync(file).size; } catch { return 0; } })();
    const existing = size > 0 ? readFileSync(file, 'utf8') : '';
    if (existing.includes(`"id":"${id}"`)) return false;
    const threshold = Number(env.OMC_PROVIDER_TASK_LOG_ROTATE_BYTES) > 0 ? Number(env.OMC_PROVIDER_TASK_LOG_ROTATE_BYTES) : ROTATE_BYTES;
    if (size >= threshold) { try { renameSync(file, `${file}.1`); } catch { /* could not move: keep appending */ } }
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch { return false; }
};

// A few lines for the reviewer: model, tokens, turns, Bash and failures, consultations, warnings, branch, base, changes.
// No estimated cost, no cost comparisons with another model, no cleanup hints.
const resultHeader = (w) => {
  if (!w || typeof w !== 'object') return 'journal: no task row';
  const t = (v) => (v == null ? '?' : String(v));
  const lines = [
    `task ${t(w.id)} (${t(w.team)}): status ${t(w.status)}, time ${w.duration_s == null ? '?' : `${Math.round(w.duration_s)}s`}, turns ${t(w.turns)}`,
    `model: ordered ${t(w.model_ordered)}, used ${t(w.model_used)}, window ${w.window_percent == null ? '?' : `${w.window_percent}%`}`,
    `tokens: in ${t(w.tokens_in)}, out ${t(w.tokens_out)}, cache ${t(w.tokens_cache)}`,
    `bash: calls ${t(w.bash_calls)}, failures ${t(w.bash_failures)}, last code ${t(w.bash_last_code)}`,
    `consultations: ${t(w.consultations)}, warnings: ${Array.isArray(w.warnings) && w.warnings.length ? w.warnings.join(', ') : 'none'}`,
  ];
  if (w.branch) lines.push(`branch: ${w.branch}${w.base_sha ? ` (base ${w.base_sha})` : ''}`);
  if (w.files_changed != null) lines.push(`changes: ${w.files_changed} file(s), +${w.added ?? 0}/-${w.removed ?? 0} lines`);
  return mask(lines.join('\n'));
};

const usage = () => console.error('Usage: provider-task-log.cjs <id> | provider-task-log.cjs write <id>');

function main() {
  const argv = process.argv.slice(2);
  if (!argv[0]) { usage(); process.exit(EXIT.CONFIG); }
  try {
    if (argv[0] === 'write') {
      if (!argv[1]) { usage(); process.exit(EXIT.CONFIG); }
      if (!writeRow(argv[1])) { console.error('not written (no data, a second write of the same id or the switch)'); process.exit(EXIT.FAILURE); }
      process.exit(EXIT.OK);
    }
    const w = taskRow(argv[0]);
    if (!w) { console.error('no data for the given id'); process.exit(EXIT.FAILURE); }
    console.log(JSON.stringify(w));
  } catch (e) {
    if (e && e.name === 'ProfileError') { console.error(`provider-task-log: ${mask(e.message)}`); process.exit(e.exit ?? EXIT.CONFIG); }
    throw e;
  }
}

if (require.main === module) main();
module.exports = { taskRow, writeRow, resultHeader };
