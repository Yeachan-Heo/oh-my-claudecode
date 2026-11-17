#!/usr/bin/env node
// Consultation of a provider worker with an advisor on the host login of Claude: `provider-advisor "<question with context>"`
// (the question from the arguments, or from stdin when there are no arguments). The answer goes to stdout.
// Called by its bare name (the name is advisor.commandName of the profile; the worker wrapper installs a shim for it in
// the worker shim directory and the Bash guard lets exactly this bare name through).
// Security: a `claude` process with the provider address in its env would send the login token of the host to that
// address, so the env is cleared of everything that belongs to the provider (the provider variables, the credentials,
// every ANTHROPIC_*, the OMC_PROVIDER_* markers and overrides) and PATH has no shim directories (a directory whose
// `claude` is a generated provider shim is removed). Project settings files: the advisor claude starts in an empty
// temporary directory (mkdtemp, removed afterwards; the plan is read by an absolute path) and with `--setting-sources ""`,
// so `.claude/settings*.json` written by the worker in the task worktree (for example an env with ANTHROPIC_BASE_URL)
// cannot bring a foreign address back after the env was cleared. A foreign ANTHROPIC_BASE_URL in the incoming env
// (isForeignProvider): exit code 2 without a start (a second layer next to the env clearing), except the address of the
// calling provider worker's own session (see ownSessionAddress below).
// The script sends nothing to the provider address and reads no provider key. The advisor answers with plain text:
// `--tools ""` disables the built-in tools, an empty --mcp-config with --strict-mcp-config disables MCP.
// Prompt on the stdin of claude: the role header and the answer format (the line `ADVISOR: change|confirm|reject`),
// the worker context (from the env of an OMC team worker: OMC_TEAM_WORKER, OMC_TEAM_WORKTREE_PATH, OMC_TEAM_WORKER_CWD),
// the task plan from the lead ($OMC_TEAM_STATE_ROOT/tasks/*.json: owner = the short worker name and status in_progress,
// the way the worker wrapper composes the task text), the worker question. Time limit advisor.timeoutSeconds (exit code 124).
// Journal: a JSON row {ts, job_id, model, question_chars, answer_chars, status, duration_ms} in the advisor journal
// (OMC_PROVIDER_ADVISOR_LOG_FILE wins, otherwise <stateDir>/advisor.jsonl), no text and no secrets, also on an error.
// The claude process is not `detached`: it stays in the group of the worker, so a kill of the group (the time limit of
// the task) kills it with the rest; the time limit and the signals kill the child with SIGKILL.
// Variables for tests only: OMC_PROVIDER_ADVISOR_CLAUDE_BIN (instead of claude from PATH), OMC_PROVIDER_ADVISOR_TIMEOUT_MS
// (instead of advisor.timeoutSeconds); the Bash guard refuses commands that set them (a worker cannot set them inline).
// `--permission-mode plan` is a second layer next to the lack of tools; `--no-session-persistence` together with
// `--output-format json` (cost and tokens in machine form) writes no session to disk; `--disable-slash-commands`.
// Role from a file (--system-prompt): templates/provider/advisor-role.md (or advisor.roleFile of the profile, or the test
// variable OMC_PROVIDER_ADVISOR_ROLE_FILE: a plain text file); with the input switch on, OMC_PROVIDER_ADVISOR_PROTOCOL
// (plan, rescue, final) selects a profile from the role file (the COMMON section plus the profile section); otherwise the
// DEFAULT section (or the whole file when it has no sections).
// Shaped input (advisor-input.cjs) with OMC_PROVIDER_ADVISOR_INPUT=1; off by default.
// Verdict mode: with the input switch on and OMC_PROVIDER_ADVISOR_PROTOCOL in {plan, rescue, final} the answer of the
// advisor goes through the parser and the validator (advisor-verdict.cjs): the control line TOKEN (a random token
// appended to the input by advisor-input), a verdict from the dictionary of the profile, SUMMARY, validation of the
// SOURCE citations against the files and ranges shown (the input metadata), STALE (the SHA-256 of the task diff and HEAD
// at input time versus after the answer), a protective cap of the advice OMC_PROVIDER_ADVISOR_CAP_ADVICE (4000
// characters by default; the TOKEN and VERDICT lines are never trimmed). Statuses in the journal: ok, no-advice, stale,
// invalid-citations; exit code 3 = the final gate failed or no advice in the final profile; the advisory mode (plan,
// rescue) is fail-open: exit code 0 and the message "advice unavailable, continue or report to the lead".
// Journal of explicit advice and cost with OMC_PROVIDER_ADVISOR_JOURNAL=1 (advisor-journal.cjs; off by default): two rows
// per consultation, `start` before the claude process is launched and `end` with the result; refusals and start errors
// have only an end row. The event from a closed list (plan, test-failure, final, other) is a required call parameter
// with the journal on: --event <v> or OMC_PROVIDER_ADVISOR_EVENT, --failure-no N only with test-failure; a value outside
// the list is refused (exit code 2) also with the journal off.
// Limit with OMC_PROVIDER_ADVISOR_LIMIT=1 (advisor-limit.cjs; off by default): consultation limit per task and per group
// and a FIFO queue for the top-model bucket.
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { ProfileError, PROFILE_DEFAULTS, advisorModel, loadProfile } = require('./lib/profile.cjs');
const { isForeignProvider, stripOverrides, stripProviderEnv } = require('./lib/env.cjs');
const { shimDir } = require('./lib/settings.cjs');
const { ADVISOR_EVENTS, ADVISOR_STATUSES } = require('./lib/vocab.cjs');
const input = require('./lib/advisor-input.cjs');
const verdict = require('./lib/advisor-verdict.cjs');
const journal = require('./lib/advisor-journal.cjs');
const limit = require('./lib/advisor-limit.cjs');

const START = Date.now();
const env = process.env;
const S = ADVISOR_STATUSES;

// Profile of the advisor: the profile named by OMC_PROVIDER (the worker env carries only the marker, so the profiles file
// is found by the default path) or, without a profile, the defaults of the advisor section; a profile that cannot be
// loaded never blocks a consultation (the advisor is a help, not a gate of the work).
const profile = (() => {
  const fallback = { name: env.OMC_PROVIDER || 'default', advisor: PROFILE_DEFAULTS.advisor };
  try { return loadProfile(env, { name: env.OMC_PROVIDER, onWarning: () => {} }).profile; } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    if (e.code !== 'missing_profile') console.error(`provider-advisor: provider profile ignored (${e.message}); advisor defaults apply`);
    return fallback;
  }
})();
const journalPath = journal.logPath(profile, env);
// Consultation metadata of the input (input_hash, size, files, shown, head, decision_chars) for the journal; null with the input mode off and on refusals.
let inputMeta = null;
// State of a consultation: the key of the start+end row pair, the consultation number in the task, the advice text
// (redacted of secrets before the write).
let consultationKey = null;
let consultationNumber = 0;
let adviceText = null;
// Limit slots (reservation before the spawn, commit after delivered advice, an idempotent refund after an error), flag of the 429 retry.
let consultationSlot = null;
let topSlot = null;
let retryDone = false;
// Secrets from the raw env for the redaction of the text fields of the journal and of the stderr of claude; computed before the first write.
const secrets = Object.entries(env).filter(([k, v]) => /TOKEN|KEY|SECRET|API_KEY|AUTH/i.test(k) && typeof v === 'string' && v.length >= 12).map(([, v]) => v);
const LIMIT_MS = Number(env.OMC_PROVIDER_ADVISOR_TIMEOUT_MS) > 0 ? Number(env.OMC_PROVIDER_ADVISOR_TIMEOUT_MS) : profile.advisor.timeoutSeconds * 1000;
// One definition of the advisor model: advisorModel(profile, env) (OMC_PROVIDER_ADVISOR_MODEL, the default advisor.defaultModel, a value outside
// advisor.models is null); the start is refused below with exit code 2.
const MODEL = advisorModel(profile, env);
// A rate-limit refusal is recognised (status refused-limit instead of response-error or error) with the limit on or the journal on;
// with all switches off the statuses are response-error and error.
const refusedForRate = (t) => (limit.enabled(env) || journal.enabled(env)) && journal.isRateLimitRefusal(t);

const writeRow = (status, questionChars, answerChars = 0, result = null, extra = null) => {
  try {
    const row = { ts: new Date().toISOString(), job_id: env.OMC_TEAM_WORKER || null, model: MODEL, question_chars: questionChars, answer_chars: answerChars, status, duration_ms: Date.now() - START };
    // Cost and tokens from the JSON answer (--output-format json) go to the journal in machine form.
    if (result && typeof result === 'object') {
      if (Number.isFinite(result.total_cost_usd)) row.cost_usd = result.total_cost_usd;
      if (result.usage && typeof result.usage === 'object') {
        if (Number.isFinite(result.usage.input_tokens)) row.tokens_in = result.usage.input_tokens;
        if (Number.isFinite(result.usage.output_tokens)) row.tokens_out = result.usage.output_tokens;
      }
    }
    if (inputMeta && !(journal.enabled(env) && consultationKey)) { // input metadata on the metadata row (journal protocol off); with the protocol on the metadata goes to the start row
      row.input_hash = inputMeta.input_hash;
      row.size = inputMeta.size;
      row.files = inputMeta.files;
      row.shown = inputMeta.shown;
      row.head = inputMeta.head;
      row.decision_chars = inputMeta.decision_chars;
      if (inputMeta.token) row.token = inputMeta.token; // control token of the input (in the hash and in the control line of the answer)
    }
    if (journal.enabled(env) && consultationKey) { // the end row of the protocol
      row.type = 'end';
      row.consultation_id = consultationKey;
      row.number = consultationNumber;
      row.event = eventInfo.event;
      if (eventInfo.failure_no !== null) row.failure_no = eventInfo.failure_no;
      if (adviceText) row.advice = journal.redact(adviceText, secrets);
      if (result && typeof result === 'object' && result.modelUsage && typeof result.modelUsage === 'object') row.model_usage = result.modelUsage;
    }
    if (extra && typeof extra === 'object') Object.assign(row, extra); // verdict, parser and validation fields (the status canon)
    journal.appendRow(journalPath, row, { secrets });
  } catch (e) { console.error(`provider-advisor: journal not written (${e.message})`); } // a lost row is visible on stderr
};
let workDir = null;
// Ending a consultation: closing the limit slots (commit after delivered advice ok/stale/invalid-citations/stop, an
// idempotent refund after every error: start error, a non-zero exit code, timeout), then the journal write (skipped for
// a journal hit: the type='cache' row is written by limit.appendHit), stderr, cleanup.
const finish = (code, status, text, questionChars, answerChars, result = null, extra = null, options = {}) => {
  if (consultationSlot || topSlot) {
    const delivered = status === S.OK || status === S.STALE || status === S.INVALID_CITATIONS || status === S.STOP; // stop: advice was issued, the gate failed: the slot is committed
    try { limit.closeSlots({ path: limit.limitFile(env, profile), consultation: consultationSlot, top: topSlot, commit: delivered }); } catch { /* slots are best effort */ }
    consultationSlot = null;
    topSlot = null;
  }
  if (retryDone) extra = { ...(extra || {}), retry_429: 1 }; // a trace of the 429 retry in the journal
  if (!options.skipJournal) writeRow(status, questionChars, answerChars, result, extra);
  if (text) console.error(`provider-advisor: ${text}`);
  if (workDir) try { rmSync(workDir, { recursive: true, force: true }); } catch { /* cleanup is best effort */ }
  process.exit(code);
};
// A disallowed advisor model value: refusal with exit code 2 before the start (finish calls writeRow, which already has MODEL in scope).
if (!MODEL) finish(2, S.BAD_MODEL, `OMC_PROVIDER_ADVISOR_MODEL has a disallowed value "${env.OMC_PROVIDER_ADVISOR_MODEL}"; allowed: ${profile.advisor.models.join(', ')}; start aborted`, 0, 0);

// The event from a closed list as a call parameter (--event <v> or OMC_PROVIDER_ADVISOR_EVENT, an optional --failure-no N
// only with test-failure); the flags are taken off argv so the question stays clean. A value outside the list is refused
// (exit code 2, refused-event). Parsing the event works only with the journal on (OMC_PROVIDER_ADVISOR_JOURNAL=1); with
// it off argv stays the question in full.
const eventInfo = journal.enabled(env)
  ? journal.parseEvent(process.argv.slice(2), env)
  : { event: null, failure_no: null, rest: process.argv.slice(2) };
if (eventInfo.refusal) finish(2, S.REFUSED_EVENT, eventInfo.refusal, 0, 0);
// The question: from the arguments (after the event parameters are taken off) and, when there are none, from stdin (read to the end).
const question = (() => {
  const fromArgv = eventInfo.rest.join(' ').trim();
  if (fromArgv || process.stdin.isTTY) return fromArgv;
  try { return readFileSync(0, 'utf8').trim(); } catch { return ''; }
})();
if (!question) finish(2, S.EMPTY_QUESTION, `usage: ${profile.advisor.commandName} "<question with context>" (or the question on stdin)`, 0, 0);
if (journal.enabled(env) && !eventInfo.event) finish(2, S.REFUSED_EVENT, `missing event parameter (required with OMC_PROVIDER_ADVISOR_JOURNAL=1): --event ${Object.values(ADVISOR_EVENTS).join('|')} or OMC_PROVIDER_ADVISOR_EVENT; --failure-no N only with ${ADVISOR_EVENTS.TEST_FAILURE}`, question.length, 0);

// The advisor binary: the test variable, then advisor.claudeBinary, then the first `claude` on PATH that is not a generated provider shim.
const isShimFile = (file) => { try { return readFileSync(file, 'utf8').slice(0, 200).includes('Generated provider shim'); } catch { return false; } };
const shimDirs = new Set([shimDir(profile, env, 'session'), shimDir(profile, env, 'worker')].map((d) => resolve(d)));
const pathEntries = String(env.PATH || '/usr/bin:/bin').split(':').filter((p) => p && !shimDirs.has(resolve(p)) && !isShimFile(join(p, 'claude')));
const explicitBinary = String(env.OMC_PROVIDER_ADVISOR_CLAUDE_BIN || '').trim() || profile.advisor.claudeBinary || null;
const binary = explicitBinary || pathEntries.map((p) => join(p, 'claude')).find((c) => existsSync(c)) || null;
if (!binary || !existsSync(binary)) finish(127, S.NO_BINARY, `no claude binary (${env.OMC_PROVIDER_ADVISOR_CLAUDE_BIN ? 'OMC_PROVIDER_ADVISOR_CLAUDE_BIN' : explicitBinary ? 'advisor.claudeBinary' : 'none found on PATH'})`, question.length, 0);

// A foreign ANTHROPIC_BASE_URL in the INCOMING env (not anthropic.com): refusal with exit code 2 before the clearing (the
// clearing removes every ANTHROPIC_*, so a check after it would never be true).
// The one address that is not refused is the own session address of a provider worker: its settings env block sets
// ANTHROPIC_BASE_URL (the provider, or the local proxy) for every process of the session, the advisor shim included, so the
// consultation that the worker rule asks for would never start. That address is recognised by the settings file of the session
// (OMC_PROVIDER_SETTINGS_FILE, written by the worker wrapper): the OMC_PROVIDER marker and ANTHROPIC_BASE_URL of the incoming env must
// equal the ones in its env block. Any other address, also under a marker without such a file, is refused as before; the address
// does not reach claude in either case, because every ANTHROPIC_* is cleared below.
// ANTHROPIC_AUTH_TOKEN in the input does not refuse: provider workers hold the provider key in their process env and call
// the advisor from it; the key is cleared below.
const ownSessionAddress = () => {
  if (!env.OMC_PROVIDER || !env.OMC_PROVIDER_SETTINGS_FILE || !env.ANTHROPIC_BASE_URL) return false;
  try {
    const session = JSON.parse(readFileSync(env.OMC_PROVIDER_SETTINGS_FILE, 'utf8')).env;
    return Boolean(session) && session.OMC_PROVIDER === env.OMC_PROVIDER && session.ANTHROPIC_BASE_URL === env.ANTHROPIC_BASE_URL;
  } catch { return false; }
};
if (isForeignProvider(env) && !ownSessionAddress()) finish(2, S.REFUSED_ENV, 'the incoming env has a foreign ANTHROPIC_BASE_URL; start aborted (the advisor goes to the Claude login; the login token must not go to a foreign address)', question.length, 0);

// Env without the provider: the helpers of env.cjs plus every ANTHROPIC_*; PATH without the shim directories.
const clean = stripProviderEnv(stripOverrides(env));
for (const k of Object.keys(clean)) if (/^ANTHROPIC_/.test(k)) delete clean[k];
clean.PATH = pathEntries.join(':');
// Kill switches in the env of the advisor process: the advisor does not call the native advisor on its own transcript (double cost) and the OMC hooks do not load.
clean.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
clean.DISABLE_OMC = '1';
// The stderr of claude goes through the redaction of secrets (computed above, before writeRow: the journal redacts the advice field too).
const redactSecrets = (t) => secrets.reduce((s, w) => s.split(w).join('[REDACTED]'), String(t || ''));

// The task plan from the lead: tasks $OMC_TEAM_STATE_ROOT/tasks/*.json (owner = the short worker name, status in_progress; the number in the line), the way the
// worker wrapper composes the task text. No task: information in the PLAN section.
const inProgressTasks = () => {
  if (!env.OMC_TEAM_WORKER || !env.OMC_TEAM_STATE_ROOT) return [];
  const name = String(env.OMC_TEAM_WORKER).split('/')[1] || String(env.OMC_TEAM_WORKER);
  try {
    const dir = join(env.OMC_TEAM_STATE_ROOT, 'tasks');
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
      .filter((z) => z && z.owner === name && z.status === 'in_progress');
  } catch { return []; }
};
const plan = inProgressTasks()
  .map((z) => `task ${z.id}: ${[z.subject, z.title, z.description].filter((x) => typeof x === 'string').join(': ')}`)
  .join('\n');

// Role from a file (--system-prompt), not from a header in the code. Precedence: OMC_PROVIDER_ADVISOR_ROLE_FILE (a path, tests only; plain text), the profile of the
// protocol from the role file (only with the input switch on and a protocol plan|rescue|final), the DEFAULT section of the role file (or the whole
// file when it has no sections). A name of a protocol only from lower-case letters, digits and hyphens. No text from a file whose path is actually used
// is a refusal with exit code 2 (status no-role), not a silent fallback in the code.
const protocol = /^[a-z0-9-]{1,40}$/.test(String(env.OMC_PROVIDER_ADVISOR_PROTOCOL || '')) ? String(env.OMC_PROVIDER_ADVISOR_PROTOCOL) : '';
const roleFile = profile.advisor.roleFile || join(__dirname, '..', '..', 'templates', 'provider', 'advisor-role.md');
const role = (() => {
  const explicit = env.OMC_PROVIDER_ADVISOR_ROLE_FILE;
  if (explicit) { try { const t = readFileSync(explicit, 'utf8').trim(); if (t) return t; } catch { /* the explicit file is missing: next */ } }
  if (input.enabled(env) && verdict.PROTOCOLS.includes(protocol)) {
    let profileRole = null;
    try { profileRole = verdict.systemRole(readFileSync(roleFile, 'utf8'), protocol); } catch { profileRole = null; }
    if (profileRole) return profileRole;
    return finish(2, S.NO_ROLE, 'no role file (or no section of the protocol profile in it); start aborted', question.length, 0);
  }
  try {
    const text = readFileSync(roleFile, 'utf8');
    const { profiles } = verdict.parseProfiles(text);
    const plain = profiles.default || (Object.keys(profiles).length === 0 ? text.trim() : '');
    if (plain) return plain;
  } catch { /* missing role file */ }
  return finish(2, S.NO_ROLE, 'no role file (templates/provider/advisor-role.md next to the scripts, advisor.roleFile or OMC_PROVIDER_ADVISOR_ROLE_FILE); start aborted', question.length, 0);
})();

// Worker context from the env of an OMC team worker.
const context = [
  env.OMC_TEAM_WORKER ? `worker: ${env.OMC_TEAM_WORKER}` : null,
  env.OMC_TEAM_WORKER && String(env.OMC_TEAM_WORKER).includes('/') ? `team: ${String(env.OMC_TEAM_WORKER).split('/')[0]}` : null,
  env.OMC_TEAM_WORKTREE_PATH ? `worktree: ${env.OMC_TEAM_WORKTREE_PATH}` : null,
  env.OMC_TEAM_WORKER_CWD ? `working directory: ${env.OMC_TEAM_WORKER_CWD}` : null,
].filter(Boolean).join('\n');

const planSection = plan
  ? `TASK PLAN FROM THE LEAD:\n${plan}\n`
  : 'TASK PLAN FROM THE LEAD: none found.\n';
let prompt = [
  ...(context ? [`WORKER CONTEXT:\n${context}\n`] : []),
  planSection, `WORKER QUESTION:\n${question}`, '',
].join('\n');
// Verdict mode: only with the input switch on and a protocol of the profile (plan|rescue|final).
const activeProtocol = input.enabled(env) && verdict.PROTOCOLS.includes(protocol) ? protocol : null;
let inputToken = null;
let inputDiffHash = null; // SHA-256 of the task diff set (diff + untracked files) at input time (STALE after the answer); null = unknown state
const diffBaseDir = env.OMC_TEAM_WORKTREE_PATH || env.OMC_PROVIDER_FILE_ROOT || '';
// The diff base is the parameter OMC_PROVIDER_ADVISOR_DIFF_BASE (HEAD by default); for a team task the lead sets the start
// ref of the task, because `git diff HEAD` does not cover changes committed during the task, and untracked files (the typical
// result) are not in the diff at all.
const diffBaseRef = String(env.OMC_PROVIDER_ADVISOR_DIFF_BASE || 'HEAD').trim() || 'HEAD';
if (activeProtocol) {
  inputToken = verdict.controlToken();
  if (diffBaseDir) { const z = input.collectTaskDiff(diffBaseDir, diffBaseRef); if (z.ok) inputDiffHash = createHash('sha256').update(z.text).digest('hex'); }
}
if (input.enabled(env)) { // the mode is on: the input is built by advisor-input.cjs (refusals: exit code 2, a journal row, no model call)
  const built = (() => { try { return input.buildInput({ env, question, planSection, context, token: inputToken }); } catch (e) { return { refused: true, status: S.INPUT_ERROR, message: `could not build the input (${e.message})` }; } })();
  if (built.refused) finish(2, built.status, built.message, question.length, 0);
  prompt = built.prompt;
  inputMeta = built.meta;
}

// ===== Limit: consultation limit per task/group and the top-model queue: OMC_PROVIDER_ADVISOR_LIMIT=1 turns it on (off by default) =====
if (limit.enabled(env)) {
  // Limit keys: the task = the number of the in_progress task of the worker from $OMC_TEAM_STATE_ROOT/tasks/*.json (the same set as the plan);
  // the group = the team name (OMC_TEAM_WORKER before the slash), not the worker name. With no team the dimension is skipped.
  // No keys at all: the limit does not work (a warning on stderr), not a shared counter under an empty key.
  const limitTask = (() => { const z = inProgressTasks()[0]; return z ? String(z.id) : null; })();
  const limitGroup = env.OMC_TEAM_WORKER ? String(env.OMC_TEAM_WORKER).split('/')[0] : null;
  const limitPath = limit.limitFile(env, profile);
  const lim = limit.limits(env, profile);
  // Every call of the limit library under a guard: an infrastructure error (lock, state path, damaged file) is a message on stderr, a limit-error
  // journal row and a continuation without the limit (fail-open; the limit is a cost fuse, it does not block the work of the worker), never an uncaught exception.
  const guardLimit = (what, fn) => {
    try { return fn(); } catch (e) {
      try {
        console.error(`provider-advisor: limit error (${what}): ${e.message}; continuing without the limit`);
        writeRow(S.LIMIT_ERROR, question.length, 0, null, { limit_error: what });
      } catch { /* stderr and the journal are best effort */ }
      return null;
    }
  };
  // An answer from the journal: the same question plus diff (the input hash) as in the last delivered consultation of the task -> advice from the
  // journal, with no model call and no slot; only without the verdict protocol (the random control token breaks the repeatability of the hash, and the
  // TOKEN/verdict gate must pass every time). The key includes the model.
  if (journal.enabled(env) && !activeProtocol && inputMeta && inputMeta.input_hash) {
    const hitJobId = env.OMC_TEAM_WORKER || null;
    const hit = guardLimit('journal read', () => limit.findInJournal({ path: journalPath, jobId: hitJobId, inputHash: inputMeta.input_hash, model: MODEL }));
    if (hit) {
      guardLimit('hit write', () => limit.appendHit({ path: journalPath, jobId: hitJobId, task: null, worker: env.OMC_TEAM_WORKER || null, inputHash: inputMeta.input_hash, source_id: hit.source_id, answer_chars: hit.advice.length, secrets }));
      const leftForCache = guardLimit('limit read', () => limit.remainingFor({ path: limitPath, task: limitTask, group: limitGroup, limits: lim }));
      const cacheText = `${hit.advice}\nADVISOR-LIMIT: ${leftForCache === null ? 'no data' : leftForCache} left\n`;
      process.stdout.write(cacheText, () => finish(0, S.FROM_JOURNAL, '', question.length, cacheText.length, null, { hit: hit.source_id }, { skipJournal: true }));
      return;
    }
  }
  if (limitTask === null && limitGroup === null) {
    console.error('provider-advisor: no task identifier (an in_progress task in OMC_TEAM_STATE_ROOT) and no team (OMC_TEAM_WORKER): the limit and the queue do not work in this call');
  } else {
    // (a) reservation of a consultation slot (task and group limit; a refusal without a model call, a "what next" message with the parameter names;
    // a refusal does not raise the counter)
    const reservation = guardLimit('reservation', () => limit.reserve({ path: limitPath, task: limitTask, group: limitGroup, limits: lim }));
    if (reservation === null) { /* continuing without the limit (limit-error) */ }
    else if (!reservation.ok) {
      finish(2, S.REFUSED_TASK_LIMIT, `CONSULTATION LIMIT EXHAUSTED (0 left, reason: ${reservation.reason === 'group' ? 'group limit' : 'task limit'}). What next: continue without the advisor or report to the lead. The lead raises the limits: OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK, OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP, OMC_PROVIDER_ADVISOR_TOP_SLOTS.`, question.length, 0, null, { limit_reason: reservation.reason, limit_left: 0 });
    } else {
      consultationSlot = { id: reservation.id, left: reservation.left };
      // (b) a machine-wide FIFO queue for the top-model bucket (2 slots by default, wait 15000 ms; a failure is exit code 2, status queue-timeout,
      // the consultation slot is refunded by finish); the queue concerns only the bucket of the top model, so with another model it does not work.
      if (MODEL === 'opus') {
        const waitMs = Number(env.OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS) > 0 ? Number(env.OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS) : profile.advisor.limits.queueWaitMs;
        const waiting = guardLimit('top-model queue', () => limit.waitForTop({ path: limitPath, limits: lim, waitMs }));
        if (waiting === null) { /* continuing without the bucket (limit-error) */ }
        else if (!waiting.ok) finish(2, S.QUEUE_TIMEOUT, `TOP-MODEL QUEUE BUSY: no bucket slot for ${Math.round(waitMs / 1000)} s. What next: continue without the advisor or report to the lead; also try again in a moment.`, question.length, 0, null, { limit_left: consultationSlot.left });
        else topSlot = { id: waiting.id };
      }
    }
  }
}

try { workDir = mkdtempSync(join(tmpdir(), 'provider-advisor-')); } catch (e) { finish(127, S.START_ERROR, `could not create a temporary directory: ${e.code || e.message}`, question.length, 0); }
// The start row before the claude process is launched (only with OMC_PROVIDER_ADVISOR_JOURNAL=1); the consultation number in the task and the key of the
// start+end pair come from the journal module (under the lock); a failed write does not stop the consultation.
if (journal.enabled(env)) {
  try {
    const opened = journal.openConsultation({ path: journalPath, job_id: env.OMC_TEAM_WORKER || null, task: null, worker: env.OMC_TEAM_WORKER || null, event: eventInfo.event, failure_no: eventInfo.failure_no, meta: inputMeta, diff_hash: inputDiffHash, model: MODEL });
    consultationKey = opened.key;
    consultationNumber = opened.number;
  } catch (e) { console.error(`provider-advisor: journal not written (start: ${e.message})`); } // a lost start row is visible on stderr
}
// A safe call: no user and project settings (no hooks, no advisor model and no OMC_JEV*), no session on disk, no slash commands, plan mode as a second layer next to the lack of tools,
// a JSON answer (cost and tokens), the role from a file; the prompt on stdin, no shell.
// The call lives in run(): one retry after a rate-limit refusal (429) after Retry-After, with no consultation slot consumed (the slot and the bucket slot are held for the whole consultation, retry included).
const claudeArgs = ['-p', '--model', MODEL, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--permission-mode', 'plan', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt', role];
let currentChild = null;
let ended = false;
let lastOutputLength = 0; // the output length of the last attempt (journal on abort)
const kill = (signal) => { try { if (currentChild) currentChild.kill(signal); } catch { /* already ended */ } };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { ended = true; kill('SIGKILL'); finish(1, S.ABORTED, `signal ${signal}`, question.length, lastOutputLength); });
const run = () => {
  ended = false;
  const child = spawn(binary, claudeArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: clean, cwd: workDir });
  currentChild = child;
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { output += c; lastOutputLength = output.length; });
  child.stderr.on('data', (c) => { errors += c; });
  child.stdin.on('error', () => { /* claude closed stdin before the write ended: the result comes in exit */ });
  child.stdin.end(prompt);
  const timer = setTimeout(() => { if (ended) return; ended = true; kill('SIGKILL'); finish(124, S.TIMEOUT, `time limit of ${Math.round(LIMIT_MS / 1000)} s exceeded`, question.length, output.length); }, Math.max(1000, LIMIT_MS - (Date.now() - START))); // a time budget for all attempts together (the 429 retry does not stretch the consultation beyond the limit)
  child.on('error', (e) => { if (ended) return; ended = true; clearTimeout(timer); finish(127, S.START_ERROR, `could not start claude: ${e.code || e.message}`, question.length, 0); });
  child.on('close', (code, signal) => {
    ended = true; clearTimeout(timer);
    if (code === 0) {
      // The answer of --output-format json: the text of the result field goes to stdout, cost and tokens to the journal; without JSON or with is_error: an error
      let result = null; try { result = JSON.parse(output); } catch { /* no JSON: error below */ }
      if (!result || typeof result !== 'object' || typeof result.result !== 'string') finish(1, S.JSON_ERROR, 'claude returned an answer without JSON with a result field (--output-format json)', question.length, output.length);
      if (result.is_error) { // a rate-limit refusal in the result: one retry after Retry-After, with no slot consumed
        if (limit.enabled(env) && !retryDone && journal.isRateLimitRefusal(result.result)) {
          retryDone = true;
          const ms = limit.retryDelayMs(result.result);
          console.error(`provider-advisor: rate-limit refusal (429) in the result: one retry after ${ms} ms`);
          setTimeout(() => { run(); }, ms);
          return;
        }
        finish(1, refusedForRate(result.result) ? S.REFUSED_LIMIT : S.RESPONSE_ERROR, 'claude returned an answer with is_error', question.length, output.length);
      }
      const answer = input.redactPatterns(result.result); // the advice goes through the scan of secret patterns (PEM, sk-..., AKIA..., Bearer..., NAME=long value) before stdout and the journal write
      if (answer.trim()) adviceText = answer; // the full advice text for the journal (redacted at write time); an empty one: no advice field
      if (activeProtocol) { // three-state parser, citation validation, STALE, protective cap, canonical statuses
        const parsed = verdict.parse(answer, { protocol: activeProtocol, token: inputToken });
        const validation = verdict.validateCitations(parsed.citations, inputMeta && inputMeta.shown);
        let stale = null;
        if (inputDiffHash !== null) {
          // STALE from the same set (the diff against the base + untracked files); compareDiffHash returns true/false/null (null = git unreachable).
          stale = input.compareDiffHash({ base: diffBaseDir, diffBase: diffBaseRef, startHash: inputDiffHash, startHead: inputMeta && inputMeta.head ? inputMeta.head : null });
        }
        const decision = verdict.decide({ protocol: activeProtocol, parsed, validation, stale });
        const capChars = Number(env.OMC_PROVIDER_ADVISOR_CAP_ADVICE) > 0 ? Number(env.OMC_PROVIDER_ADVISOR_CAP_ADVICE) : 4000;
        const extra = {
          verdict: parsed.verdict,
          parser_reason: parsed.reason,
          citations_total: validation.total, citations_valid: validation.valid.length, citations_invalid: validation.invalid.length,
          stale, token_ok: parsed.controlLine,
          concerns_count: parsed.concerns.length,
          criteria_chars: parsed.criteria ? parsed.criteria.length : null, // plan: acceptance criteria (the journal has no text)
          cap_trimmed: parsed.state === 'ok' ? verdict.capAdvice(answer, capChars).trimmed : undefined,
        };
        let printed; // the printout for the worker: the text with the cap, the citation validation line, warnings
        if (parsed.state !== 'ok') {
          printed = `${decision.advisory ? `ADVICE UNAVAILABLE (${parsed.reason}): continue or report to the lead` : `GATE: no advice (${parsed.reason})`}\n`;
        } else {
          const capped = verdict.capAdvice(answer, capChars);
          printed = [capped.text, validation.message, decision.warning].filter(Boolean).join('\n') + '\n';
        }
        const limitLine = limit.enabled(env) ? `ADVISOR-LIMIT: ${consultationSlot ? consultationSlot.left : 0} left\n` : '';
        const canonStatus = parsed.state !== 'ok' && parsed.reason === 'empty' ? S.EMPTY_ANSWER_ON_ZERO_EXIT : parsed.state !== 'ok' && parsed.reason === S.NO_VERDICT ? S.NO_VERDICT : decision.status; // the parser reasons mapped to canonical statuses
        process.stdout.write(printed + limitLine, () => finish(decision.code, canonStatus, '', question.length, (printed + limitLine).length, result, extra));
        return;
      }
      if (!answer.trim() && journal.enabled(env)) finish(0, S.EMPTY_ANSWER_ON_ZERO_EXIT, '', question.length, 0, result); // (the status only with the journal on; with it off an empty answer is stdout '\n', status ok)
      const limitLine = limit.enabled(env) ? `ADVISOR-LIMIT: ${consultationSlot ? consultationSlot.left : 0} left\n` : ''; // the line with the number of consultations left in the answer
      process.stdout.write((answer.endsWith('\n') ? answer : `${answer}\n`) + limitLine, () => finish(0, S.OK, '', question.length, (answer + limitLine).length, result));
      return;
    }
    // A rate-limit refusal (429) on stderr: one retry after Retry-After, with no slot consumed
    if (limit.enabled(env) && !retryDone && journal.isRateLimitRefusal(errors)) {
      retryDone = true;
      const ms = limit.retryDelayMs(errors);
      console.error(`provider-advisor: rate-limit refusal (429): one retry after ${ms} ms`);
      setTimeout(() => { run(); }, ms);
      return;
    }
    if (errors) process.stderr.write(redactSecrets(errors)); // the stderr of claude goes to the worker after the redaction of secrets
    finish(code ?? (signal ? 1 : 0), refusedForRate(errors) ? S.REFUSED_LIMIT : S.ERROR, `claude ended with code ${code ?? signal}`, question.length, output.length);
  });
};
run();
