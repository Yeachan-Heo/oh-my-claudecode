/* global process */
// Result validator of provider tasks: pure evaluation, all data in memory.
import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STATUSES, CAUSES, evaluateResult, evaluateMissingTask } = require('../../../scripts/provider/lib/task-result.cjs');
const vocab = require('../../../scripts/provider/lib/vocab.cjs');

const js = (v) => JSON.stringify(v);

// A valid DoneClaim payload; single cases build their own variants.
const DONECLAIM = [
  'Summary: Task done, branch and report ready.',
  'Files: scripts/provider/lib/task-result.cjs',
  'Verification: tests 7/7 OK',
  'Risks: none',
  'Status: success',
].join('\n');

const EMPTY_EVALUATION = { status: 'unknown', cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null, handoff: false, errors: [] };
const evaluation = (n) => ({ ...EMPTY_EVALUATION, ...n });
const NOW = 1000000000000;
const hb = (agoS, alive = true) => ({ pid: 1, last_turn_at: new Date(NOW - agoS * 1000).toISOString(), turn_count: 3, alive });

describe.skipIf(process.platform === 'win32')('provider task result validator', () => {
  it('(1) dictionaries: STATUSES in order plus in_progress and equal to the shared vocabulary; CAUSES ASCII with quota and timeout', () => {
    assert.deepEqual(STATUSES, ['success', 'partial_success', 'blocked', 'failed', 'capped', 'budget_stopped', 'unknown', 'in_progress']);
    expect(STATUSES).toEqual(Object.values(vocab.STATUSES));
    for (const p of ['model', 'task_engine', 'environment', 'provider_429', 'quota', 'timeout', 'idle', 'no_access', 'needs_decision', 'check_failed']) {
      assert.ok(CAUSES.includes(p), `class ${p} missing from CAUSES`);
    }
    assert.ok(CAUSES.every((p) => /^[a-z0-9_]+$/.test(p)), 'classes are not ASCII constants');
  });

  it('(2) killed is not overwritten by a late completed', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, taskFile: { killed: '2026-11-14T20:00:00.000Z' } });
    assert.deepEqual(w, evaluation({ status: 'killed' }), js(w));
  });

  it('(3) a payload outside the dictionary gives unknown (an invalid document goes to review)', () => {
    const w = evaluateResult({ task: { status: 'completed', result: 'Summary: x\nStatus: super' } });
    assert.equal(w.status, 'unknown', js(w));
    assert.equal(w.handoff, true, js(w));
    assert.ok(w.errors.some((b) => b.includes('Status')), js(w.errors));
  });

  it('(4) an empty result gives failed with cause empty_response and a handoff', () => {
    const w = evaluateResult({ task: { status: 'completed', result: '' } });
    assert.equal(w.status, 'failed', js(w));
    assert.equal(w.cause, 'empty_response', js(w));
    assert.equal(w.handoff, true, js(w));
    const missing = evaluateResult({ task: { status: 'completed' } });
    assert.equal(missing.status, 'failed', js(missing));
    const notText = evaluateResult({ task: { status: 'completed', result: { bad: 'shape' } } });
    assert.equal(notText.status, 'failed', js(notText));
    assert.ok(notText.errors.some((b) => b.includes('is not a string')), js(notText.errors));
  });

  it('(5) a dead worker gives worker_dead only with proof of death (worker status failed); without proof in_progress', () => {
    const w = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'failed' } });
    assert.equal(w.status, 'worker_dead', js(w));
    assert.equal(w.handoff, true, js(w));
    assert.ok(w.errors.some((b) => b.includes('worker_dead')), js(w.errors));
    // unknown and a missing status file are NOT proof (a fresh worker has not written one yet)
    const unknownState = evaluateResult({ task: { status: 'pending' }, workerStatus: { state: 'unknown' } });
    assert.equal(unknownState.status, 'in_progress', js(unknownState));
    const noFile = evaluateResult({ task: { status: 'pending' }, workerStatus: null });
    assert.equal(noFile.status, 'in_progress', js(noFile));
  });

  it('(6) channel 1: worker status blocked with a reason gives blocked, the reason as required', () => {
    const w = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'blocked', reason: 'worker stuck: no permission for a confirmed bash' } });
    assert.equal(w.status, 'blocked', js(w));
    assert.equal(w.required, 'worker stuck: no permission for a confirmed bash', js(w));
    assert.equal(w.handoff, false, js(w));
    const noReason = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'blocked' } });
    assert.equal(noReason.status, 'blocked', js(noReason));
    assert.equal(noReason.required, null, js(noReason));
  });

  it('(7) channel 2: a failed task with an error field gives failed, the error as cause, handoff', () => {
    const w = evaluateResult({ task: { status: 'failed', error: 'worker reported a failure: no access to the worktree' } });
    assert.equal(w.status, 'failed', js(w));
    assert.equal(w.cause, 'worker reported a failure: no access to the worktree', js(w));
    assert.equal(w.handoff, true, js(w));
    const noError = evaluateResult({ task: { status: 'failed' } });
    assert.equal(noError.status, 'failed', js(noError));
    assert.equal(noError.cause, null, js(noError));
  });

  it('(8) channel 3: completed with a valid DoneClaim gives success and the copied evaluation fields', () => {
    const w = evaluateResult({ task: { status: 'completed', result: [
      'Summary: Task done.',
      'Files: scripts/provider/lib/task-result.cjs',
      'Verification: tests 7/7 OK',
      'Risks: none',
      'Status: success',
      'Gaps: none',
      'Required: code review by the lane reviewer',
      'Unverified: -',
      'Cause: model',
      'Evidence: report in the result file',
      'Points: result-status',
    ].join('\n') } });
    assert.deepEqual(w, evaluation({
      status: 'success',
      cause: 'model',
      gaps: 'none',
      required: 'code review by the lane reviewer',
      unverified: '-',
      evidence: 'report in the result file',
      points: 'result-status',
    }), js(w));
  });

  it('(9) strict parsing: an unknown key invalidates the document (unknown, entry in errors)', () => {
    const w = evaluateResult({ task: { status: 'completed', result: 'Summary: ok\nDone: everything that was needed' } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('unknown key "Done"')), js(w.errors));
  });

  it('(10) strict parsing: a bad Cause value invalidates the document (class outside the dictionary)', () => {
    const w = evaluateResult({ task: { status: 'completed', result: 'Summary: ok\nCause: throttle' } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('bad value Cause')), js(w.errors));
  });

  it('(11) strict parsing: a line without a colon and a duplicate key invalidate the document', () => {
    const w = evaluateResult({ task: { status: 'completed', result: 'Summary: ok\nThis is plain text without a colon' } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('no key')), js(w.errors));
    const duplicate = evaluateResult({ task: { status: 'completed', result: 'Summary: first\nStatus: success\nSummary: second' } });
    assert.equal(duplicate.status, 'unknown', js(duplicate));
    assert.ok(duplicate.errors.some((b) => b.includes('duplicate key "Summary"')), js(duplicate.errors));
  });

  it('(12) the base DoneClaim without a Status line gives success (the default status of a valid document)', () => {
    const w = evaluateResult({ task: { status: 'completed', result: 'Summary: finished\nFiles: none\nVerification: n/a\nRisks: none' } });
    assert.equal(w.status, 'success', js(w));
    assert.equal(w.handoff, false, js(w));
  });

  it('(13) the failure-class map from facts.class fills the cause for a non-success result without Cause in the payload', () => {
    const payload = 'Summary: it did not work\nFiles: none\nVerification: n/a\nRisks: none\nStatus: failed';
    const expected = [['auth', 'no_access'], ['quota', 'quota'], ['throttle', 'provider_429'], ['infra', 'environment'], ['advisor', 'task_engine']];
    for (const [klass, cause] of expected) {
      const w = evaluateResult({ task: { status: 'completed', result: payload }, facts: { class: klass } });
      assert.equal(w.status, 'failed', js(w));
      assert.equal(w.cause, cause, `${klass}: ${js(w)}`);
      assert.equal(w.handoff, true, js(w));
    }
    const other = evaluateResult({ task: { status: 'completed', result: payload }, facts: { class: 'other' } });
    assert.equal(other.cause, null, js(other));
    // success gets no cause from the map even when the journal has a failure class
    const success = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { class: 'auth' } });
    assert.equal(success.status, 'success', js(success));
    assert.equal(success.cause, null, js(success));
    // the payload is validated only by the CAUSES dictionary: the class throttle in Cause is rejected (above);
    // a success with a Cause from the dictionary passes unchanged
    const fromPayload = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM}\nCause: quota` } });
    assert.equal(fromPayload.status, 'success', js(fromPayload));
    assert.equal(fromPayload.cause, 'quota', js(fromPayload));
  });

  it('(13b) facts.class integrity is fail closed: a valid completed success claim is failed with a handoff, whatever the payload says; a payload with a failed status stays failed with the handoff', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { class: 'integrity' } });
    assert.equal(w.status, 'failed', js(w));
    assert.equal(w.handoff, true, js(w));
    assert.ok(w.errors.some((b) => b.startsWith('integrity:')), js(w.errors));
    const partial = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM.replace('Status: success', 'Status: partial_success')}\nGaps: x` }, facts: { class: 'integrity' } });
    assert.equal(partial.status, 'failed', js(partial));
    assert.equal(partial.handoff, true, js(partial));
    const clean = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { class: 'other' } });
    assert.equal(clean.status, 'success', js(clean));
    assert.equal(clean.handoff, false, js(clean));
  });

  it('(14) facts: model_mismatch is fail closed, failed with cause model even with a valid success', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { warnings: ['model_mismatch'] } });
    assert.equal(w.status, 'failed', js(w));
    assert.equal(w.cause, 'model', js(w));
    assert.equal(w.handoff, true, js(w));
    assert.ok(w.errors.some((b) => b.includes('model_mismatch')), js(w.errors));
  });

  it('(15) facts: the last Bash != 0 with a green declaration in Verification gives unverified, errors and a non-success status', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { bash_last_code: 1 } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.unverified.includes('bash_last_code 1'), js(w));
    assert.ok(w.errors.some((b) => b.includes('unverified')), js(w.errors));
    // a negation in Verification is not a green declaration, so code 2 does not invalidate it
    const negation = evaluateResult({ task: { status: 'completed', result: 'Summary: ok\nFiles: none\nVerification: tests did not pass, see the log\nRisks: none\nStatus: success' }, facts: { bash_last_code: 2 } });
    assert.equal(negation.status, 'success', js(negation));
    assert.equal(negation.unverified, null, js(negation));
  });

  it('(16) facts: success_without_changes with Status success gives a non-success status', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { warnings: ['success_without_changes'] } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('success_without_changes')), js(w.errors));
    assert.equal(w.handoff, true, js(w));
  });

  it('(17) facts: the empty_response warning with a non-empty valid result acts like an empty result', () => {
    const w = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { warnings: ['empty_response'] } });
    assert.equal(w.status, 'failed', js(w));
    assert.equal(w.cause, 'empty_response', js(w));
    assert.equal(w.handoff, true, js(w));
  });

  it('(18) an announcement instead of execution in the result gives a non-success status with an entry in errors', () => {
    const w = evaluateResult({ task: { status: 'completed', result: [
      'Summary: I am sticking to the task, the work is scoped.',
      'Files: none',
      'Verification: not run yet',
      'Risks: none',
      'Status: success',
      'I will make one more fix and report the test results.',
    ].join('\n') } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('announcement')), js(w.errors));
    assert.equal(w.handoff, true, js(w));
  });

  it('(19) a permission question in the result gives a non-success status and a handoff', () => {
    const w = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM}\nshould I continue?` } });
    assert.equal(w.status, 'unknown', js(w));
    assert.ok(w.errors.some((b) => b.includes('permission question')), js(w.errors));
    assert.equal(w.handoff, true, js(w));
    const other = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM}\nlet me know whether to fix the documentation too.` } });
    assert.equal(other.status, 'unknown', js(other));
    // a valid result without questions and announcements passes as success
    const clean = evaluateResult({ task: { status: 'completed', result: DONECLAIM } });
    assert.equal(clean.status, 'success', js(clean));
  });

  it('(20) handoff: failed and capped from the payload give a handoff, budget_stopped and blocked from the payload do not; abandon forces a handoff even with success', () => {
    const failed = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM.replace('Status: success', 'Status: failed')}\nCause: model` } });
    assert.equal(failed.status, 'failed', js(failed));
    assert.equal(failed.handoff, true, js(failed));
    const capped = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM.replace('Status: success', 'Status: capped')}\nCause: timeout` } });
    assert.equal(capped.status, 'capped', js(capped));
    assert.equal(capped.handoff, true, js(capped));
    const budget = evaluateResult({ task: { status: 'completed', result: DONECLAIM.replace('Status: success', 'Status: budget_stopped') } });
    assert.equal(budget.status, 'budget_stopped', js(budget));
    assert.equal(budget.handoff, false, js(budget));
    const blockedPayload = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM.replace('Status: success', 'Status: blocked')}\nRequired: a lead decision on the scope` } });
    assert.equal(blockedPayload.status, 'blocked', js(blockedPayload));
    assert.equal(blockedPayload.handoff, false, js(blockedPayload));
    const abandon = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, taskFile: { abandon: { reason: 'priorities changed', ts: '2026-11-14T21:00:00.000Z' } } });
    assert.equal(abandon.status, 'success', js(abandon));
    assert.equal(abandon.handoff, true, js(abandon));
  });

  it('(21) failed start: with no OMC task found, start_exit_code 4 gives start_failed with cause quota, another code environment, code 0 does not interfere', () => {
    const quota = evaluateResult({ task: null, taskFile: { start_exit_code: 4 } });
    assert.equal(quota.status, 'start_failed', js(quota));
    assert.equal(quota.cause, 'quota', js(quota));
    assert.equal(quota.handoff, true, js(quota));
    const environment = evaluateResult({ task: null, taskFile: { start_exit_code: 1 } });
    assert.equal(environment.status, 'start_failed', js(environment));
    assert.equal(environment.cause, 'environment', js(environment));
    const ok = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, taskFile: { start_exit_code: 0 } });
    assert.equal(ok.status, 'success', js(ok));
    // killed takes precedence over start_failed as well
    const killed = evaluateResult({ task: { status: 'pending' }, taskFile: { killed: '2026-11-14T20:00:00.000Z', start_exit_code: 4 } });
    assert.equal(killed.status, 'killed', js(killed));
  });

  it('(21b) a found OMC task wins over a non-zero start_exit_code, whatever its status (omc team can end with a non-zero exit code for a team that ran): completed is evaluated from its result, failed and blocked keep their own status, pending and in_progress stay in_progress; none of them is a start_failed verdict', () => {
    const taskFile = { start_exit_code: 1, start_error: 'startup_failure worker=worker-1' };
    const completed = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, taskFile });
    assert.equal(completed.status, 'success', js(completed));
    assert.equal(completed.handoff, false, js(completed));
    assert.deepEqual(completed.errors, [], js(completed));
    const failed = evaluateResult({ task: { status: 'failed', error: 'worker crashed' }, taskFile });
    assert.equal(failed.status, 'failed', js(failed));
    assert.equal(failed.cause, 'worker crashed', js(failed));
    const blocked = evaluateResult({ task: { status: 'blocked', result: 'NEED: a decision' }, taskFile });
    assert.equal(blocked.status, 'blocked', js(blocked));
    for (const status of ['pending', 'in_progress']) {
      const running = evaluateResult({ task: { status }, taskFile });
      assert.equal(running.status, 'in_progress', js(running));
      assert.equal(running.handoff, false, js(running));
      assert.equal(running.cause, null, js(running));
    }
    // no task at all: the launch failure decides
    assert.equal(evaluateResult({ task: null, taskFile }).status, 'start_failed');
  });

  it('(22) no input data gives unknown with a handoff; a task in progress with a live worker gives in_progress', () => {
    const nothing = evaluateResult();
    assert.equal(nothing.status, 'unknown', js(nothing));
    assert.equal(nothing.handoff, true, js(nothing));
    const running = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' } });
    assert.equal(running.status, 'in_progress', js(running));
    assert.equal(running.handoff, false, js(running));
    assert.deepEqual(running.errors, [], js(running));
  });

  it('(23) a blocked task without a worker status gives blocked (never worker_dead), required from the NEED: line', () => {
    const w = evaluateResult({ task: { status: 'blocked', result: 'Did A.\nNEED: access to file X' }, workerStatus: null });
    assert.equal(w.status, 'blocked', js(w));
    assert.equal(w.required, 'access to file X', js(w));
    assert.equal(w.handoff, false, js(w));
    // required from workerStatus.reason takes precedence over NEED:
    const fromReason = evaluateResult({ task: { status: 'blocked' }, workerStatus: { state: 'blocked', reason: 'R' } });
    assert.equal(fromReason.status, 'blocked', js(fromReason));
    assert.equal(fromReason.required, 'R', js(fromReason));
    // unknown in the worker status does not decide death: still blocked
    const unknownState = evaluateResult({ task: { status: 'blocked' }, workerStatus: { state: 'unknown' } });
    assert.equal(unknownState.status, 'blocked', js(unknownState));
    // NEED: from task.error when the result has none; without NEED and reason: required null
    const fromError = evaluateResult({ task: { status: 'blocked', error: 'NEED: a scope decision' }, workerStatus: null });
    assert.equal(fromError.required, 'a scope decision', js(fromError));
    const noReason = evaluateResult({ task: { status: 'blocked' }, workerStatus: null });
    assert.equal(noReason.required, null, js(noReason));
  });

  it('(24) worker_dead needs proof of death (failed or alive false); an old heartbeat is not proof, in_progress with an informational age', () => {
    const fromFailed = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'failed' } }, { now: NOW });
    assert.equal(fromFailed.status, 'worker_dead', js(fromFailed));
    assert.ok(fromFailed.errors.some((b) => b.includes('worker_dead')), js(fromFailed.errors));
    // an old last_turn_at (61 s) with alive: true is NOT proof of death; the age is informational
    const old = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'unknown' }, heartbeat: hb(61) }, { now: NOW });
    assert.equal(old.status, 'in_progress', js(old));
    assert.equal(old.heartbeat_age_s, 61, js(old));
    // the second proof of death: heartbeat.alive === false gives worker_dead
    const notAlive = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' }, heartbeat: hb(5, false) }, { now: NOW });
    assert.equal(notAlive.status, 'worker_dead', js(notAlive));
    assert.ok(notAlive.errors.some((b) => b.includes('alive false')), js(notAlive.errors));
    const fresh = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'unknown' }, heartbeat: hb(59) }, { now: NOW });
    assert.equal(fresh.status, 'in_progress', js(fresh));
    // heartbeat null (no file): no proof, in_progress, heartbeat_age_s null
    const noHeartbeat = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'unknown' }, heartbeat: null }, { now: NOW });
    assert.equal(noHeartbeat.status, 'in_progress', js(noHeartbeat));
    assert.equal(noHeartbeat.heartbeat_age_s, null, js(noHeartbeat));
  });

  it('(25) in_progress for pending/in_progress without proof of death (handoff false, errors empty), in_progress in STATUSES', () => {
    for (const workerState of [null, { state: 'unknown' }, { state: 'working' }]) {
      for (const taskStatus of ['pending', 'in_progress']) {
        const w = evaluateResult({ task: { status: taskStatus }, workerStatus: workerState, heartbeat: null });
        assert.equal(w.status, 'in_progress', js(w));
        assert.equal(w.handoff, false, js(w));
        assert.deepEqual(w.errors, [], js(w));
      }
    }
    assert.ok(STATUSES.includes('in_progress'), js(STATUSES));
  });

  it('(26) files_changed 0 with success gives unknown with the error success_without_changes; 3 and null keep success; warning and field together give one entry', () => {
    const zero = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { files_changed: 0, warnings: [] } });
    assert.equal(zero.status, 'unknown', js(zero));
    assert.equal(zero.handoff, true, js(zero));
    assert.equal(zero.errors.filter((b) => b.includes('success_without_changes')).length, 1, js(zero.errors));
    const three = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { files_changed: 3, warnings: [] } });
    assert.equal(three.status, 'success', js(three));
    const empty = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { files_changed: null, warnings: [] } });
    assert.equal(empty.status, 'success', js(empty));
    const noField = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { warnings: [] } });
    assert.equal(noField.status, 'success', js(noField));
    const both = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, facts: { files_changed: 0, warnings: ['success_without_changes'] } });
    assert.equal(both.status, 'unknown', js(both));
    assert.equal(both.errors.filter((b) => b.includes('success_without_changes')).length, 1, js(both.errors));
  });

  it('(27) a verbatim real worker result (3 protocol lines, no Status line) gives success without errors', () => {
    const REAL = [
      'Summary: Created probe-1.txt (one line: ok) in the worker worktree root; commit b4560b1 probe-1 contains only that file (git add probe-1.txt; git commit -m probe-1), no AI signatures.',
      'Verification: git show --stat HEAD -> probe-1.txt | 1 +, 1 file changed; git status after the commit -> only the pre-modified AGENTS.md (out of scope).',
      'Subagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session',
    ].join('\n');
    const w = evaluateResult({ task: { status: 'completed', result: REAL } });
    assert.equal(w.status, 'success', js(w));
    assert.deepEqual(w.errors, [], js(w.errors));
    assert.equal(w.handoff, false, js(w));
  });

  it('(28) the canonical result (6 lines) gives success without errors; the partial_success variant gives partial_success', () => {
    const CANON = [
      'Status: success',
      'Summary: added function X and a test',
      'Files: scripts/x.cjs, tests/x.test.mjs',
      'Verification: vitest run x 5/5',
      'Risks: none',
      'Subagent skip reason: worker protocol forbids nested subagents; completed focused task in-session',
    ].join('\n');
    const w = evaluateResult({ task: { status: 'completed', result: CANON } });
    assert.equal(w.status, 'success', js(w));
    assert.deepEqual(w.errors, [], js(w.errors));
    const partial = evaluateResult({ task: { status: 'completed', result: CANON.replace('Status: success', 'Status: partial_success') } });
    assert.equal(partial.status, 'partial_success', js(partial));
  });

  it('(29) Subagent spawn evidence is accepted; Subagent foo is rejected as an unknown key', () => {
    const w = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM}\nSubagent spawn evidence: spawned helper in-session` } });
    assert.equal(w.status, 'success', js(w));
    assert.deepEqual(w.errors, [], js(w.errors));
    const foo = evaluateResult({ task: { status: 'completed', result: `${DONECLAIM}\nSubagent foo: x` } });
    assert.equal(foo.status, 'unknown', js(foo));
    assert.ok(foo.errors.some((b) => b.includes('unknown key "Subagent foo"')), js(foo.errors));
  });

  it('(30) Status in_progress and unknown from a worker invalidate the document (unknown, bad value error, handoff)', () => {
    for (const bad of ['in_progress', 'unknown']) {
      const w = evaluateResult({ task: { status: 'completed', result: `Summary: x\nStatus: ${bad}` } });
      assert.equal(w.status, 'unknown', js(w));
      assert.equal(w.handoff, true, js(w));
      assert.ok(w.errors.some((b) => b.includes(`bad value Status: "${bad}"`)), js(w.errors));
    }
  });

  it('(31) the first non-empty NEED line in the result gives blocked/needs_decision/handoff for completed, in error for failed; later lines are not validated', () => {
    const needCompleted = evaluateResult({ task: { status: 'completed', result: 'NEED: I need decision X\nBLOCKED: abc' } });
    assert.equal(needCompleted.status, 'blocked', js(needCompleted));
    assert.equal(needCompleted.cause, 'needs_decision', js(needCompleted));
    assert.equal(needCompleted.handoff, true, js(needCompleted));
    assert.equal(needCompleted.required, 'I need decision X', js(needCompleted));
    assert.deepEqual(needCompleted.errors, [], js(needCompleted.errors)); // later lines (BLOCKED: abc) are not validated as a DoneClaim
    const needFailed = evaluateResult({ task: { status: 'failed', error: 'NEED: a scope decision' } });
    assert.equal(needFailed.status, 'blocked', js(needFailed));
    assert.equal(needFailed.cause, 'needs_decision', js(needFailed));
    assert.equal(needFailed.handoff, true, js(needFailed));
    assert.equal(needFailed.required, 'a scope decision', js(needFailed));
  });

  it('(32) the first non-empty ESCALATE line gives blocked with the escalation field', () => {
    const esc = evaluateResult({ task: { status: 'completed', result: 'ESCALATE: plan-unclear\nmissing rule Y' } });
    assert.equal(esc.status, 'blocked', js(esc));
    assert.equal(esc.cause, 'needs_decision', js(esc));
    assert.equal(esc.handoff, true, js(esc));
    assert.equal(esc.escalation, 'plan-unclear', js(esc));
    assert.deepEqual(esc.errors, [], js(esc.errors)); // later lines (missing rule Y) are not validated as a DoneClaim
  });

  it('(33) an old last_turn_at (8 h) with alive true gives in_progress and heartbeat_age_s 28800, not worker_dead (age is not proof of death)', () => {
    const old = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' }, heartbeat: hb(8 * 3600) }, { now: NOW });
    assert.equal(old.status, 'in_progress', js(old));
    assert.equal(old.handoff, false, js(old));
    assert.deepEqual(old.errors, [], js(old.errors));
    assert.equal(old.heartbeat_age_s, 28800, js(old));
  });

  it('(34) heartbeat alive false gives worker_dead with a handoff; a bad date in last_turn_at gives heartbeat_age_s null', () => {
    const notAlive = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' }, heartbeat: hb(5, false) }, { now: NOW });
    assert.equal(notAlive.status, 'worker_dead', js(notAlive));
    assert.equal(notAlive.handoff, true, js(notAlive));
    assert.ok(notAlive.errors.some((b) => b.includes('worker_dead') && b.includes('alive false')), js(notAlive.errors));
    const badDate = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' }, heartbeat: { pid: 1, last_turn_at: 'not-a-date', turn_count: 3, alive: true } }, { now: NOW });
    assert.equal(badDate.status, 'in_progress', js(badDate));
    assert.equal(badDate.heartbeat_age_s, null, js(badDate));
  });

  it('(35) heartbeat_age_s is filled in the other branches with a heartbeat (completed, failed, blocked) and null without one; a fresh last_turn_at is in_progress', () => {
    const completed = evaluateResult({ task: { status: 'completed', result: DONECLAIM }, heartbeat: hb(90) }, { now: NOW });
    assert.equal(completed.status, 'success', js(completed));
    assert.equal(completed.heartbeat_age_s, 90, js(completed));
    const failedBranch = evaluateResult({ task: { status: 'failed', error: 'x' }, heartbeat: hb(120) }, { now: NOW });
    assert.equal(failedBranch.status, 'failed', js(failedBranch));
    assert.equal(failedBranch.heartbeat_age_s, 120, js(failedBranch));
    const blockedBranch = evaluateResult({ task: { status: 'blocked' }, workerStatus: { state: 'blocked', reason: 'R' }, heartbeat: hb(30) }, { now: NOW });
    assert.equal(blockedBranch.status, 'blocked', js(blockedBranch));
    assert.equal(blockedBranch.heartbeat_age_s, 30, js(blockedBranch));
    const none = evaluateResult({ task: { status: 'in_progress' }, workerStatus: null, heartbeat: null }, { now: NOW });
    assert.equal(none.status, 'in_progress', js(none));
    assert.equal(none.heartbeat_age_s, null, js(none));
    const fresh = evaluateResult({ task: { status: 'in_progress' }, workerStatus: { state: 'working' }, heartbeat: hb(5) }, { now: NOW });
    assert.equal(fresh.status, 'in_progress', js(fresh));
  });

  describe('missing OMC task evaluation', () => {
    const NOW4 = 1_763_100_000_000;
    const alive = {}; // pid -> true (fake isStartAlive; the start time is checked through the recorded arguments)
    let lastArgs = null;
    const isStartAliveFake = (pid, st) => {
      lastArgs = { pid, st }; // check of the call arguments (pid and start_pid_starttime go to the liveness check)
      return Boolean(alive[pid]);
    };
    const startFile = (override) => ({ id: 'abcd0001', team: 'ptask-abcd0001-x', start: new Date(NOW4 - 70_000).toISOString(), ...override });
    const MISSING = ['OMC task ptask-abcd0001 not found in team ptask-abcd0001-x'];

    it('(36) queue: a live start_pid without omc_started_at gives the state queue and a null verdict (task in progress), isStartAlive gets pid and start_pid_starttime', () => {
      alive[4242] = true;
      lastArgs = null;
      const o = evaluateMissingTask(startFile({ start_pid: 4242, start_pid_starttime: 777 }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.deepEqual(o, { state: 'queue', verdict: null }, js(o));
      assert.deepEqual(lastArgs, { pid: 4242, st: 777 }, 'isStartAlive gets pid and start_pid_starttime');
      // queue ceiling: start-lock limit 300 s plus 120 s = 420 s from the start field; 70 s is still the queue
      const ceiling = evaluateMissingTask(startFile({ start_pid: 4242, start_pid_starttime: null, start: new Date(NOW4 - 421_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.equal(ceiling.state, 'start_failed', js(ceiling));
      assert.equal(ceiling.verdict.cause, 'environment', js(ceiling));
      assert.ok(ceiling.verdict.errors[0].includes('more than 420 s'), js(ceiling));
      // a small lock limit moves the ceiling: 1500 ms plus 120 s = 121.5 s; a start 121 s ago is still the queue, 122 s is start_failed
      const small = evaluateMissingTask(startFile({ start_pid: 4242, start_pid_starttime: null, start: new Date(NOW4 - 121_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake, startLockLimitMs: 1500 });
      assert.equal(small.state, 'queue', js(small));
      const small2 = evaluateMissingTask(startFile({ start_pid: 4242, start_pid_starttime: null, start: new Date(NOW4 - 122_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake, startLockLimitMs: 1500 });
      assert.equal(small2.state, 'start_failed', js(small2));
      delete alive[4242];
    });

    it('(37) grace from omc_started_at: 30 s is grace (despite a start 200 s ago), 61 s is start_failed with the usual error', () => {
      const grace = evaluateMissingTask(startFile({ start: new Date(NOW4 - 200_000).toISOString(), omc_started_at: new Date(NOW4 - 30_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.deepEqual(grace, { state: 'grace', verdict: null }, js(grace));
      const after = evaluateMissingTask(startFile({ omc_started_at: new Date(NOW4 - 61_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.equal(after.state, 'start_failed', js(after));
      assert.deepEqual(after.verdict, { status: 'start_failed', cause: 'environment', handoff: true, errors: MISSING }, js(after));
      // omc_started_at without a parsable date: the rule is skipped (the grace from the start field decides: 70 s > 60 s -> start_failed)
      const bad = evaluateMissingTask(startFile({ omc_started_at: 'not-a-date' }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.equal(bad.state, 'start_failed', js(bad));
    });

    it('(38) a dead _start (isStartAlive false) gives start_failed at once with an error about exiting before the launch, even within the grace from start', () => {
      const o = evaluateMissingTask(startFile({ start_pid: 999, start_pid_starttime: null, start: new Date(NOW4 - 5_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.equal(o.state, 'start_failed', js(o));
      assert.deepEqual(o.verdict.errors, ['the _start process exited before it launched provider-team'], js(o));
      assert.equal(o.verdict.cause, 'environment', js(o));
      assert.equal(o.verdict.handoff, true, js(o));
    });

    it('(39) no start_pid and no omc_started_at (a file from before these fields): grace 60 s from the start field: 59 s grace, 61 s start_failed with the usual error', () => {
      const w = evaluateMissingTask(startFile({ start: new Date(NOW4 - 59_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.deepEqual(w, { state: 'grace', verdict: null }, js(w));
      const after = evaluateMissingTask(startFile({ start: new Date(NOW4 - 61_000).toISOString() }), { now: NOW4, isStartAlive: isStartAliveFake });
      assert.equal(after.state, 'start_failed', js(after));
      assert.deepEqual(after.verdict, { status: 'start_failed', cause: 'environment', handoff: true, errors: MISSING }, js(after));
    });
  });
});
