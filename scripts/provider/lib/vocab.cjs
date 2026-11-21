'use strict';
// Shared vocabulary for provider workers: status values, cause and failure
// classes, exit codes and protocol labels. Modules import these names instead
// of repeating string literals. Documented in docs/PROVIDER-WORKERS.md (Vocabulary).

const STATUSES = Object.freeze({
  SUCCESS: 'success',
  PARTIAL_SUCCESS: 'partial_success',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  CAPPED: 'capped',
  BUDGET_STOPPED: 'budget_stopped',
  UNKNOWN: 'unknown',
  IN_PROGRESS: 'in_progress',
});

const CAUSES = Object.freeze({
  MODEL: 'model',
  TASK_ENGINE: 'task_engine',
  ENVIRONMENT: 'environment',
  PROVIDER_429: 'provider_429',
  QUOTA: 'quota',
  TIMEOUT: 'timeout',
  IDLE: 'idle',
  NO_ACCESS: 'no_access',
  NEEDS_DECISION: 'needs_decision',
  CHECK_FAILED: 'check_failed',
  WORKER_DEAD: 'worker_dead',
  START_FAILED: 'start_failed',
  EMPTY_RESPONSE: 'empty_response',
  VERY_SHORT_RUN: 'very_short_run',
});

const FAILURE_CLASSES = Object.freeze({
  AUTH: 'auth',
  QUOTA: 'quota',
  THROTTLE: 'throttle',
  INFRA: 'infra',
  ADVISOR: 'advisor',
  OTHER: 'other',
  INTEGRITY: 'integrity',
});

const DONE_CLAIM_KEYS = Object.freeze({
  SUMMARY: 'Summary',
  FILES: 'Files',
  VERIFICATION: 'Verification',
  RISKS: 'Risks',
  STATUS: 'Status',
  GAPS: 'Gaps',
  REQUIRED: 'Required',
  UNVERIFIED: 'Unverified',
  CAUSE: 'Cause',
  EVIDENCE: 'Evidence',
  POINTS: 'Points',
});

const GATE_REASONS = Object.freeze({
  BREAKER: 'breaker',
  POOL: 'pool',
  AUTH: 'auth',
  QUOTA: 'quota',
});

// Quota levels: PAUSE stops new starts, STOP also aborts running workers, WORK means below both thresholds.
const QUOTA_LEVELS = Object.freeze({
  PAUSE: 'PAUSE',
  STOP: 'STOP',
  WORK: 'WORK',
});

// Exit codes of the provider tools. 128 + n is used for a process killed by signal n.
const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  CONFIG: 2,
  MISSING: 3,
  QUOTA_REFUSED: 4,
  NO_ROLE: 5,
  ADVISOR_TIMEOUT: 124,
  NO_BINARY: 127,
});

function signalExitCode(signalNumber) {
  return 128 + signalNumber;
}

const WORKER_EVENT_RESULTS = Object.freeze({
  ABORTED_NO_KEY: 'aborted-no-key',
  ABORTED_QUOTA: 'aborted-quota',
  ABORTED_BAD_CONFIG: 'aborted-bad-config',
  ABORTED_NO_ROLE: 'aborted-no-role',
  ABORTED_NO_SLOT: 'aborted-no-slot',
  END: 'end',
  INTEGRITY: 'integrity',
});

const ADVISOR_STATUSES = Object.freeze({
  OK: 'ok',
  EMPTY_ANSWER_ON_ZERO_EXIT: 'empty-answer-on-zero-exit',
  NO_VERDICT: 'no-verdict',
  NO_ADVICE: 'no-advice',
  STALE: 'stale',
  INVALID_CITATIONS: 'invalid-citations',
  STOP: 'stop',
  REFUSED_LIMIT: 'refused-limit',
  REFUSED_TASK_LIMIT: 'refused-task-limit',
  REFUSED_MISSING_DECISION: 'refused-missing-decision',
  REFUSED_PATH: 'refused-path',
  REFUSED_ENV: 'refused-env',
  REFUSED_EVENT: 'refused-event',
  QUEUE_TIMEOUT: 'queue-timeout',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  ABORTED: 'aborted',
  EMPTY_QUESTION: 'empty-question',
  BAD_MODEL: 'bad-model',
  INPUT_ERROR: 'input-error',
  START_ERROR: 'start-error',
  NO_BINARY: 'no-binary',
  NO_ROLE: 'no-role',
  JSON_ERROR: 'json-error',
  RESPONSE_ERROR: 'response-error',
  FROM_JOURNAL: 'from-journal',
  LIMIT_ERROR: 'limit-error',
});

// Closed list of consultation events (the --event parameter of the advisor call).
const ADVISOR_EVENTS = Object.freeze({
  PLAN: 'plan',
  TEST_FAILURE: 'test-failure',
  FINAL: 'final',
  OTHER: 'other',
});

// Verdict words per advisor protocol profile.
const ADVISOR_VERDICTS = Object.freeze({
  plan: Object.freeze(['LGTM', 'CONCERNS']),
  rescue: Object.freeze(['proceed', 'proceed-with-changes', 'reconsider']),
  final: Object.freeze(['GO', 'STOP']),
});

// Token the advisor answer starts with, followed by the chosen action.
const ADVISOR_TOKENS = Object.freeze({
  CHANGE: 'ADVISOR: change',
  CONFIRM: 'ADVISOR: confirm',
  REJECT: 'ADVISOR: reject',
});

// Warnings of the task journal row (warnings field).
const TASK_WARNINGS = Object.freeze({
  VERY_SHORT_RUN: 'very_short_run',
  EMPTY_RESPONSE: 'empty_response',
  SUCCESS_WITHOUT_CHANGES: 'success_without_changes',
  MODEL_MISMATCH: 'model_mismatch',
});

// Events written to rescue.jsonl by the rescue hooks.
const RESCUE_EVENTS = Object.freeze({
  FAILURE: 'failure',
  HINT: 'hint',
  DENIAL: 'denial',
  CONSULTATION: 'consultation',
  CONSULTATION_FAILURE: 'consultation-failure',
  RESET: 'reset',
  BREAKER: 'breaker',
  PARK: 'park',
});

// Fields of the rescue counter (tasks/<key>/counter.json).
const RESCUE_COUNTER_FIELDS = Object.freeze([
  'failed_checks', 'gate_denials', 'rounds', 'repeats', 'signature', 'failures', 'failures_previous', 'consultations',
  'awaiting_consultation', 'parked', 'parked_written', 'breaker', 'last_green_ts', 'last_denial_ts', 'last_error',
]);

// Name of the tool-call counter file (tasks/<key>/calls.json).
const CALL_COUNTER_FILE = 'calls.json';

// Task team names are `ptask-<8 hex>` optionally followed by `-<free text>`.
const TASK_TEAM_RE = /^ptask-([0-9a-f]{8})(?:-|$)/;

function taskSubject(id) {
  return `ptask-${id}`;
}

module.exports = {
  STATUSES,
  CAUSES,
  FAILURE_CLASSES,
  DONE_CLAIM_KEYS,
  GATE_REASONS,
  QUOTA_LEVELS,
  EXIT,
  signalExitCode,
  WORKER_EVENT_RESULTS,
  ADVISOR_STATUSES,
  ADVISOR_EVENTS,
  ADVISOR_VERDICTS,
  ADVISOR_TOKENS,
  TASK_WARNINGS,
  RESCUE_EVENTS,
  RESCUE_COUNTER_FIELDS,
  CALL_COUNTER_FILE,
  TASK_TEAM_RE,
  taskSubject,
};
