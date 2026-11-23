'use strict';
// Result validator for provider tasks. Pure evaluation: no omc calls and no file writes.
// `provider-task result` calls evaluateResult from this module.
// A richer status is composed from three native OMC channels (the task contract has only five states):
// (1) workers/<name>/status.json with state 'blocked' and a reason field,
// (2) a 'failed' task with an error field, (3) a 'completed' task with a DoneClaim payload in its result field.
// The DoneClaim is parsed strictly: known keys, known values, rejection instead of repair; an invalid
// document yields 'unknown' for review.
// evaluateResult(input, opts): opts.now is an injected clock (default Date.now()); input has a heartbeat
// field holding the output of `omc team api read-worker-heartbeat` or null. The heartbeat has the shape
// { pid, last_turn_at: ISO, turn_count, alive }; last_turn_at (or updatedAt) is read. An old last_turn_at
// is NOT proof of death (OMC writes it once per worker turn and a turn takes minutes). Proof of death for
// pending/in_progress tasks is the worker status 'failed' or heartbeat.alive === false; the age of
// last_turn_at is informational (heartbeat_age_s) and changes neither the status nor the handoff.
// The first non-empty line of a result or error of the form "NEED: <request>" or "ESCALATE: <lane>" is a
// request for a decision. The absence of a task in OMC is evaluated in one function, evaluateMissingTask
// (start-lock queue, grace period from omc_started_at or start, dead _start process, queue ceiling).
const { readFileSync } = require('node:fs');
const vocab = require('./vocab.cjs');

const { EXIT, taskSubject } = vocab;

// Status dictionary (in_progress is not a verdict: a task in progress without proof of death).
const STATUSES = Object.values(vocab.STATUSES);

// Cause classes a worker may declare in a Cause line (and that the evaluation derives from other channels).
const CAUSES = [
  vocab.CAUSES.MODEL,
  vocab.CAUSES.TASK_ENGINE,
  vocab.CAUSES.ENVIRONMENT,
  vocab.CAUSES.PROVIDER_429,
  vocab.CAUSES.QUOTA,
  vocab.CAUSES.TIMEOUT,
  vocab.CAUSES.IDLE,
  vocab.CAUSES.NO_ACCESS,
  vocab.CAUSES.NEEDS_DECISION,
  vocab.CAUSES.CHECK_FAILED,
];

// An empty result gives status 'failed'; the rule name goes into the cause, not into the status.
const EMPTY_RESPONSE = vocab.CAUSES.EMPTY_RESPONSE;

// DoneClaim lines: the base (Summary, Files, Verification, Risks), the machine lines (Status, Gaps, Required,
// Unverified, Cause, Evidence, Points) and two keys of the OMC worker protocol that its task completion
// requires. A key is ASCII; spaces are allowed only in those two names (any other `Subagent <word>` is an
// unknown key, not "no key").
const K = vocab.DONE_CLAIM_KEYS;
const DONE_CLAIM_KEYS = new Set([K.SUMMARY, K.FILES, K.VERIFICATION, K.RISKS, K.STATUS, K.GAPS, K.REQUIRED, K.UNVERIFIED, K.CAUSE, K.EVIDENCE, K.POINTS, 'Subagent skip reason', 'Subagent spawn evidence']);
const KEY_LINE_RE = /^(Subagent [A-Za-z][A-Za-z0-9 ]*|[A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/;

// Map of failure classes from the worker event journal to causes. 'other' has no honest counterpart in the
// dictionary, so it gives no cause (stays null).
const FAILURE_CLASS_TO_CAUSE = {
  [vocab.FAILURE_CLASSES.AUTH]: vocab.CAUSES.NO_ACCESS,
  [vocab.FAILURE_CLASSES.QUOTA]: vocab.CAUSES.QUOTA,
  [vocab.FAILURE_CLASSES.THROTTLE]: vocab.CAUSES.PROVIDER_429,
  [vocab.FAILURE_CLASSES.INFRA]: vocab.CAUSES.ENVIRONMENT,
  [vocab.FAILURE_CLASSES.ADVISOR]: vocab.CAUSES.TASK_ENGINE,
  [vocab.FAILURE_CLASSES.OTHER]: null,
};

// Start exit codes: 4 = quota (the quota gate refuses a start with code 4); every other non-zero code is an
// environment problem (the start itself failed).
const CAUSE_OF_START_EXIT = { [EXIT.QUOTA_REFUSED]: vocab.CAUSES.QUOTA };

// Constants of the missing-task evaluation: grace 60 s (counted from omc_started_at when written, otherwise
// from the start field); start-lock limit 300 s; queue ceiling = start-lock limit plus 120 s, a safeguard for a
// hung _start process waiting in the queue, counted from max(start, queue_ts).
const START_GRACE_MS = 60_000;
const START_LOCK_LIMIT_MS = 300_000;
const QUEUE_EXTRA_MS = 120_000;

// start time from /proc/<pid>/stat (field 22; after the last ')' the fields count from the state = field 3,
// so the start time has index 19; a process name may contain spaces and brackets), null when the process is
// missing or unreadable.
const readStarttime = (pid) => {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(t.slice(t.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return null; }
};

// A live start: the pid exists and, when the recorded start time is not null, the start time from /proc
// matches (protection against pid reuse); with a null start time a live pid is enough.
const isStartAliveDefault = (pid, starttime) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (starttime == null) return true;
  return readStarttime(pid) === starttime;
};

// Patterns of a permission question or a stop to ask, and of an announcement instead of execution (the last
// message promises an action). A match on a result with Status success gives a non-success status. They match
// English worker output; the worker rule is written in English.
const QUESTION_PATTERNS = [
  /\b(?:should|shall)\s+i\b/i,
  /\bdo\s+you\s+want\b/i,
  /\blet\s+me\s+know\s+(?:if|whether)\b/i,
  /\b(?:whether\s+to|should\s+i|shall\s+i)\s+continue\b/i,
  /\bwaiting\s+for\s+(?:your\s+)?(?:decision|confirmation|approval|acceptance|instructions|answer)/i,
];
const ANNOUNCEMENT_PATTERNS = [
  /\bi(?:'ll|\s+will)\s+(?:do|make)\b/i,
  /\bi\s+(?:intend|plan)\s+to\b/i,
  /\bi(?:'ll|\s+will)\s+(?:still\s+)?(?:continue|keep\s+working|work|be\s+(?:fixing|implementing|adding|doing))\b/i,
  /\bi(?:'m|\s+am)\s+(?:now\s+)?(?:proceeding|starting)\b/i,
  /\bi(?:'ll|\s+will)\s+(?:do|proceed|fix|add)\b[^.\n]*\b(?:in\s+a\s+moment|right\s+away|shortly)\b/i,
  /\bi\s+(?:just\s+)?still\s+(?:need\s+to|have\s+to|must|will\s+(?:fix|do|add))\b/i,
];

// Heuristic for an announcement or a permission question; returns a description of the match or null.
function matchedPattern(text) {
  for (const p of QUESTION_PATTERNS) if (p.test(text)) return `permission question (${p})`;
  for (const p of ANNOUNCEMENT_PATTERNS) if (p.test(text)) return `announcement instead of execution (${p})`;
  return null;
}

// A green-tests declaration in Verification ("passed", "green", "OK", "7/7"), with negations cut off ("did not pass").
const greenDeclaration = (t) => /test/i.test(t) && !/(?:\bnot|n't)\s+(?:pass|green)/i.test(t) && /(?:pass|green|\bok\b|\b\d+\s*\/\s*\d+\b)/i.test(t);

// Reason of a block for `required`. First worker status reason; when missing, the first line "NEED: ..." of
// task.result or task.error (text after NEED: trimmed); otherwise null.
function blockReason(workerStatus, task) {
  const reason = workerStatus?.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  for (const text of [task?.result, task?.error]) {
    if (typeof text !== 'string') continue;
    const line = text.split('\n').find((l) => /^\s*NEED:/.test(l));
    if (line) return line.replace(/^\s*NEED:\s*/, '').trim();
  }
  return null;
}

// Request channel: the first NON-EMPTY line of result (or, when the result is empty or missing, of error)
// equal to "NEED: <request>" or "ESCALATE: <lane>" is a request for a decision; later lines are free text
// (no DoneClaim validation). Returns { required, escalation } or null.
function requestChannel(task) {
  for (const text of [task?.result, task?.error]) {
    if (typeof text !== 'string') continue;
    const line = text.split('\n').find((l) => l.trim());
    if (!line) continue;
    const need = /^NEED:\s*(.*)$/.exec(line.trim());
    if (need) return { required: need[1].trim() || null, escalation: null };
    const esc = /^ESCALATE:\s*(.*)$/.exec(line.trim());
    if (esc) return { required: null, escalation: esc[1].trim() || null };
    return null; // the first non-empty line is not a request: later fields do not decide
  }
  return null;
}

// Evaluation from the request channel (completed and failed tasks): blocked, needs_decision, handoff to the lead.
function applyRequest(evaluation, request) {
  evaluation.status = vocab.STATUSES.BLOCKED;
  evaluation.cause = vocab.CAUSES.NEEDS_DECISION;
  evaluation.required = request.required;
  evaluation.escalation = request.escalation;
  evaluation.handoff = true;
}

// Strict payload parsing: every line is "Key: value" with a known key and no duplicates; empty lines are
// ignored; every deviation is an entry in errors (rejection instead of repair).
function parseDoneClaim(text) {
  const fields = {};
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = KEY_LINE_RE.exec(line);
    if (!m) { errors.push(`line ${i + 1} has no key (text outside the payload)`); continue; }
    const key = m[1];
    if (!DONE_CLAIM_KEYS.has(key)) { errors.push(`line ${i + 1}: unknown key "${key}"`); continue; }
    if (key in fields) { errors.push(`line ${i + 1}: duplicate key "${key}"`); continue; }
    fields[key] = m[2].trim();
  }
  return { fields, errors };
}

// Strict value validation: Status only from the statuses a worker may DECLARE, Cause only from CAUSES; a bad
// value invalidates the document. 'in_progress' and 'unknown' are given only by the evaluation code, never by
// a worker, so they are rejected as the value of a Status line.
const WORKER_STATUSES = new Set([
  vocab.STATUSES.SUCCESS, vocab.STATUSES.PARTIAL_SUCCESS, vocab.STATUSES.BLOCKED,
  vocab.STATUSES.FAILED, vocab.STATUSES.CAPPED, vocab.STATUSES.BUDGET_STOPPED,
]);
function validateValues(fields, errors) {
  if (fields[K.STATUS] !== undefined && !WORKER_STATUSES.has(fields[K.STATUS])) {
    errors.push(`bad value ${K.STATUS}: "${fields[K.STATUS]}" (worker vocabulary: ${[...WORKER_STATUSES].join(', ')})`);
  }
  if (fields[K.CAUSE] !== undefined && !CAUSES.includes(fields[K.CAUSE])) {
    errors.push(`bad value ${K.CAUSE}: "${fields[K.CAUSE]}" (vocabulary: ${CAUSES.join(', ')})`);
  }
}

// Completed tasks. Order of rules in this branch: request channel -> empty result -> failed (empty_response);
// model_mismatch -> failed (model); strict parsing (invalid -> unknown); then the facts from the journal (a green
// declaration with bash_last_code != 0, success_without_changes) and the announcement heuristic, each moving
// success to unknown; finally the cause from the failure-class map when the payload gave none.
function evaluateCompleted(evaluation, task, facts, warnings) {
  const result = typeof task.result === 'string' ? task.result : null;
  const empty = result === null || !result.trim();
  if (task.result != null && result === null) evaluation.errors.push(`${EMPTY_RESPONSE}: result is not a string`);

  // The request channel decides before an empty result and the journal warnings (later lines are not validated).
  const request = requestChannel(task);
  if (request) { applyRequest(evaluation, request); return; }

  // An empty result (or the journal says empty_response): failed with cause empty_response, for rescue by the lead.
  if (empty || warnings.includes(EMPTY_RESPONSE)) {
    evaluation.status = vocab.STATUSES.FAILED;
    evaluation.cause = EMPTY_RESPONSE;
    if (!empty) evaluation.errors.push(`${EMPTY_RESPONSE}: journal warning with a non-empty result`);
    evaluation.handoff = true;
    return;
  }
  // Fail closed: a model mismatch means the result is not accepted even when the payload looks valid.
  if (warnings.includes('model_mismatch')) {
    evaluation.status = vocab.STATUSES.FAILED;
    evaluation.cause = vocab.CAUSES.MODEL;
    evaluation.errors.push('model_mismatch: fail closed, the result is not accepted');
    evaluation.handoff = true;
    return;
  }

  const { fields, errors } = parseDoneClaim(result);
  validateValues(fields, errors);
  evaluation.errors.push(...errors);
  // The announcement heuristic runs on the whole result, also when the document is invalid (the status is
  // unknown anyway; the entry refines the cause).
  const pattern = matchedPattern(result);
  if (errors.length > 0) {
    evaluation.status = vocab.STATUSES.UNKNOWN; // an invalid document goes to review
    evaluation.handoff = true;
    if (pattern) evaluation.errors.push(`the result ends with a promise or a question: ${pattern}`);
    return;
  }

  // Valid payload: Status from the machine line, success without it (the base DoneClaim); fields copied to the evaluation.
  evaluation.status = fields[K.STATUS] || vocab.STATUSES.SUCCESS;
  evaluation.cause = fields[K.CAUSE] || null;
  evaluation.gaps = fields[K.GAPS] || null;
  evaluation.required = fields[K.REQUIRED] || null;
  evaluation.unverified = fields[K.UNVERIFIED] || null;
  evaluation.evidence = fields[K.EVIDENCE] || null;
  evaluation.points = fields[K.POINTS] || null;

  // A green-tests declaration with the last Bash != 0: unverified, goes to unverified and errors, status not success.
  const code = facts?.bash_last_code;
  if (typeof code === 'number' && code !== 0 && fields[K.VERIFICATION] !== undefined && greenDeclaration(fields[K.VERIFICATION])) {
    const entry = `bash_last_code ${code} with a green-tests declaration in Verification ("${fields[K.VERIFICATION]}")`;
    evaluation.unverified = evaluation.unverified ? `${evaluation.unverified}; ${entry}` : entry;
    evaluation.errors.push('green-tests declaration unverified: the last Bash call did not exit with code 0');
    if (evaluation.status === vocab.STATUSES.SUCCESS) evaluation.status = vocab.STATUSES.UNKNOWN;
  }
  // Success without changes: the journal sees no execution (journal warning) or there are no changed files
  // (facts.files_changed === 0; null or a missing field means no data and the rule does not fire). Both
  // channels at once give one entry in errors; success does not pass.
  const noChanges = warnings.includes('success_without_changes') || facts?.files_changed === 0;
  if (noChanges && evaluation.status === vocab.STATUSES.SUCCESS) {
    evaluation.status = vocab.STATUSES.UNKNOWN;
    evaluation.errors.push('success_without_changes: Status success with no changes and no execution (journal warning or files_changed 0)');
  }
  // An announcement instead of execution or a permission question is an unfinished task, not success.
  if (pattern && evaluation.status === vocab.STATUSES.SUCCESS) {
    evaluation.status = vocab.STATUSES.UNKNOWN;
    evaluation.errors.push(`the result ends with a promise or a question: ${pattern}`);
  }

  // Cause from the failure-class map (facts.class from the journal) when the payload gave none and the result is not success.
  if (evaluation.status !== vocab.STATUSES.SUCCESS && !evaluation.cause) {
    const mapped = FAILURE_CLASS_TO_CAUSE[facts?.class];
    if (mapped) evaluation.cause = mapped;
  }
}

// The integrity rejection of an evaluation (also applied by provider-task to a verdict that was saved before the integrity row existed).
const INTEGRITY_ERROR = 'integrity: the worker changed the shared part of .git, fail closed, the result is not accepted';
function rejectIntegrity(evaluation) {
  evaluation.status = vocab.STATUSES.FAILED;
  evaluation.handoff = true;
  evaluation.errors = Array.isArray(evaluation.errors) ? evaluation.errors : [];
  if (!evaluation.errors.includes(INTEGRITY_ERROR)) evaluation.errors.push(INTEGRITY_ERROR);
  return evaluation;
}

// Result validator. Takes the OMC task (omc team api read-task / list-tasks), the worker status
// (workers/<name>/status.json), the task file of the provider-task command, the journal facts and the
// heartbeat. Returns { status, cause, gaps, required, unverified, evidence, points, escalation,
// heartbeat_age_s, handoff, errors }. heartbeat_age_s is the age of last_turn_at in whole seconds (null
// without a heartbeat or with a bad date). No side effects.
function evaluateResult({ task = null, workerStatus = null, taskFile = null, facts = null, heartbeat = null } = {}, { now = Date.now() } = {}) {
  const evaluation = { status: vocab.STATUSES.UNKNOWN, cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null, handoff: false, errors: [] };
  const warnings = Array.isArray(facts?.warnings) ? facts.warnings : [];
  // The age of the heartbeat is computed once and filled in every branch with a heartbeat given (null otherwise,
  // also with a bad date); it changes neither the status nor the handoff.
  if (heartbeat) {
    const ts = Date.parse(heartbeat.last_turn_at ?? heartbeat.updatedAt);
    if (Number.isFinite(ts)) evaluation.heartbeat_age_s = Math.floor((now - ts) / 1000);
  }

  if (taskFile?.killed) {
    // killed takes precedence over a late completed (a human decision is not overwritten by a worker result).
    evaluation.status = 'killed';
  } else if (typeof taskFile?.start_exit_code === 'number' && taskFile.start_exit_code !== 0 && !task) {
    // Failed start: only when no OMC task was found. A task that was found decides by its own status (the same precedence as `status`):
    // omc team can end with a non-zero exit code for a team that ran, so a found task, finished or still in progress, must not be
    // turned into a start_failed verdict (a verdict is saved and never re-evaluated).
    // Code 4 is a refusal by the quota gate, other codes go as environment.
    evaluation.status = 'start_failed';
    evaluation.cause = CAUSE_OF_START_EXIT[taskFile.start_exit_code] ?? vocab.CAUSES.ENVIRONMENT;
    evaluation.handoff = true;
  } else if (workerStatus?.state === 'blocked' || task?.status === 'blocked') {
    // Channel 1: an OMC task 'blocked' gives blocked (never worker_dead). The reason of the block:
    // workerStatus.reason, otherwise the first line "NEED: ..." of task.result or task.error; otherwise null.
    evaluation.status = vocab.STATUSES.BLOCKED;
    evaluation.required = blockReason(workerStatus, task);
  } else if (task?.status === 'failed') {
    // The request channel in error (or result) wins over failed: a request for a decision is blocked.
    const request = requestChannel(task);
    if (request) { applyRequest(evaluation, request); }
    else {
      // Channel 2: a failed task with an error field; the error text goes as the cause (the class is unknown).
      evaluation.status = vocab.STATUSES.FAILED;
      evaluation.cause = typeof task.error === 'string' && task.error.trim() ? task.error.trim() : null;
    }
  } else if (task?.status === 'completed') {
    // Channel 3: completed with a payload (DoneClaim) or an empty result.
    evaluateCompleted(evaluation, task, facts, warnings);
  } else if (task && ['pending', 'in_progress'].includes(task.status)) {
    // worker_dead only with proof of death: workerStatus.state === 'failed' or heartbeat.alive === false.
    // An old last_turn_at is not proof; 'unknown' is not proof either (a fresh worker has not written its
    // status yet). Without proof a task in progress is in_progress (not a verdict: handoff false, no errors).
    const state = workerStatus?.state;
    const dead = state === 'failed' || heartbeat?.alive === false;
    if (dead) {
      evaluation.status = 'worker_dead';
      evaluation.errors.push(`worker_dead: task in progress with proof of death (${state === 'failed' ? 'worker status failed' : 'heartbeat alive false'})`);
      evaluation.handoff = true;
    } else {
      evaluation.status = vocab.STATUSES.IN_PROGRESS;
    }
  } else {
    evaluation.status = vocab.STATUSES.UNKNOWN;
    evaluation.errors.push('no resolution: task in progress or no input data');
    evaluation.handoff = true;
  }

  // An integrity failure of the worker (it changed the shared part of .git; class integrity in the journal) rejects the result in every channel: a completed claim,
  // a request for a decision, a blocked task and a task in progress all end as failed with a handoff. Only a human decision (killed) keeps its place.
  if (facts?.class === vocab.FAILURE_CLASSES.INTEGRITY && evaluation.status !== 'killed') rejectIntegrity(evaluation);

  // failed, capped and unknown end with a handoff to the lead (escalation to the advisor goes through the lead).
  if ([vocab.STATUSES.FAILED, vocab.STATUSES.CAPPED, vocab.STATUSES.UNKNOWN].includes(evaluation.status)) evaluation.handoff = true;
  // An abandon with a reason does not change the status but forces a handoff to the lead.
  if (taskFile?.abandon) evaluation.handoff = true;
  return evaluation;
}

// Evaluation of a missing OMC task in one function, for status and result (provider-task).
// Why: a grace period counted from the start field wrongly gave start_failed to tasks waiting in the
// start-lock queue. Returns { state, verdict }:
//   'queue'        - _start is alive and waits for the start lock; no verdict yet;
//   'grace'        - the grace period of 60 s is running (from omc_started_at, without it from the start field); no verdict yet;
//   'start_failed' - verdict { status: 'start_failed', cause: 'environment', handoff: true, errors }.
// Order of rules: (1) omc_started_at present: grace 60 s from it, after it start_failed; (2) no omc_started_at,
// start_pid present: a live process (pid exists, with a recorded start time the /proc start time matches) is
// the queue, unless more than the start-lock limit plus 120 s passed since max(start, queue_ts) (queue
// ceiling, a safeguard for a hung _start: start_failed/environment); queue_ts is the last progress of the
// queue (written by _start when the owner of the start lock changes), so the ceiling moves with progress;
// without queue_ts the ceiling counts from start; a dead process or another start time: start_failed at once
// with an error about exiting before provider-team was launched; (3) no start_pid and no omc_started_at
// (a file from before these fields or the moment between writing the file and adding the pid): grace 60 s
// from the start field, then start_failed; with an unreadable start field: grace without a verdict.
// The /proc read and the clock are injected ({ now, isStartAlive, startLockLimitMs }), so the function is
// testable without /proc.
function evaluateMissingTask(taskFile, { now = Date.now(), isStartAlive = isStartAliveDefault, startLockLimitMs = START_LOCK_LIMIT_MS } = {}) {
  const z = taskFile || {};
  const nowMs = typeof now === 'function' ? now() : now;
  const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const verdict = (errors) => ({ status: 'start_failed', cause: vocab.CAUSES.ENVIRONMENT, handoff: true, errors });
  const missingTask = (id, team) => `OMC task ${taskSubject(id)} not found in team ${team ?? 'unknown'}`;
  // (1) omc_started_at present: grace 60 s from writing it (the moment provider-team was launched), then start_failed.
  if (typeof z.omc_started_at === 'string' && z.omc_started_at) {
    const t = time(z.omc_started_at);
    if (t != null) {
      return nowMs - t > START_GRACE_MS
        ? { state: 'start_failed', verdict: verdict([missingTask(z.id, z.team)]) }
        : { state: 'grace', verdict: null };
    }
  }
  // (2) no omc_started_at, start_pid present: the queue, or start_failed at once with a dead _start process.
  if (Number.isInteger(z.start_pid)) {
    const alive = isStartAlive(z.start_pid, z.start_pid_starttime ?? null);
    if (!alive) return { state: 'start_failed', verdict: verdict(['the _start process exited before it launched provider-team']) };
    // The queue ceiling counts from max(start, queue_ts); an unreadable queue_ts: from start; both unreadable: no ceiling, queue.
    const tStart = time(z.start);
    const tQueue = typeof z.queue_ts === 'string' ? time(z.queue_ts) : null;
    const from = tStart == null ? tQueue : (tQueue == null ? tStart : Math.max(tStart, tQueue));
    // Queue ceiling: a live _start without progress for more than the start-lock limit plus 120 s is hung: start_failed.
    if (from != null && nowMs - from > startLockLimitMs + QUEUE_EXTRA_MS) {
      return { state: 'start_failed', verdict: verdict([`the _start process has waited for the start lock for more than ${Math.round((startLockLimitMs + QUEUE_EXTRA_MS) / 1000)} s without launching provider-team`]) };
    }
    return { state: 'queue', verdict: null };
  }
  // (3) no start_pid and no omc_started_at: grace 60 s from the start field; a missing or unreadable start
  // field gives grace without a verdict.
  const t = time(z.start);
  if (t == null) return { state: 'grace', verdict: null };
  return nowMs - t > START_GRACE_MS
    ? { state: 'start_failed', verdict: verdict([missingTask(z.id, z.team)]) }
    : { state: 'grace', verdict: null };
}

module.exports = { STATUSES, CAUSES, INTEGRITY_ERROR, rejectIntegrity, evaluateResult, evaluateMissingTask, START_GRACE_MS, START_LOCK_LIMIT_MS, QUEUE_EXTRA_MS };
