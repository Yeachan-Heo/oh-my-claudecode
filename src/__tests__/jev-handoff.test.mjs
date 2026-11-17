/**
 * Session handoff at a large transcript (scripts/lib/jev-handoff.mjs) and its wiring into the PreToolUse hook
 * (opt-in: OMC_JEV_HANDOFF=1). A module part (no hook) and a hook part: scripts/pre-tool-enforcer.mjs runs as a
 * subprocess with a sparse transcript file (20 MiB + 1 B and 25 MiB + 1 B), assistant message rows appended at its
 * end, and an active ultragoal as a state file. Everything lives in temporary directories (HOME, OMC_JEV_LOG_DIR).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, describe, it } from 'vitest';
import {
  DEFAULT_HANDOFF_FILE, DEFAULT_LAUNCHER_COMMAND, DEFAULT_TAKEOVER_MARKER, HANDOFF_BLOCK_BYTES, LAUNCHER_ATTEMPT_LIMIT, LAUNCHER_IN_FLIGHT_MS,
  assessMode, handedOverText, handoffFileName, handoffModeTools, handoffStepBytes, handoffSteps, handoffWarnBytes,
  isHandoffFileName, isLauncherCommand, launcherCommand, launcherGate, modelAlias, readHandoffState, readTakeoverLine, refusalText,
  successorUseLine, takeoverMarker, warningText, writeHandoffState,
} from '../../scripts/lib/jev-handoff.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIB = 1024 * 1024;
const CLEANUPS = [];
afterAll(() => {
  for (const path of CLEANUPS.splice(0)) rmSync(path, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-handoff-'));
  CLEANUPS.push(dir);
  return dir;
}

describe('handoff module', () => {
  it('thresholds, file name, takeover marker and launcher command: defaults and configuration', () => {
    assert.equal(handoffWarnBytes({}), 20 * MIB);
    assert.equal(HANDOFF_BLOCK_BYTES, 25 * MIB);
    assert.equal(handoffStepBytes({}), 1 * MIB);
    assert.equal(DEFAULT_HANDOFF_FILE, 'HANDOFF.md');
    assert.equal(DEFAULT_TAKEOVER_MARKER, 'TAKEN OVER:');
    assert.equal(DEFAULT_LAUNCHER_COMMAND, 'jev-session');
    assert.equal(handoffWarnBytes({ OMC_JEV_HANDOFF_WARN_MIB: '12' }), 12 * MIB);
    assert.equal(handoffStepBytes({ OMC_JEV_HANDOFF_STEP_MIB: '3' }), 3 * MIB);
    assert.equal(handoffWarnBytes({ OMC_JEV_HANDOFF_WARN_MIB: 'abc' }), 20 * MIB);
    assert.equal(handoffWarnBytes({ OMC_JEV_HANDOFF_WARN_MIB: '0' }), 20 * MIB);
    assert.equal(handoffFileName({ OMC_JEV_HANDOFF_FILE: 'NEXT.md' }), 'NEXT.md');
    assert.equal(handoffFileName({ OMC_JEV_HANDOFF_FILE: '../NEXT.md' }), 'HANDOFF.md');
    assert.equal(takeoverMarker({ OMC_JEV_HANDOFF_MARKER: 'DONE:' }), 'DONE:');
    assert.equal(takeoverMarker({ OMC_JEV_HANDOFF_MARKER: 'a\nb' }), 'TAKEN OVER:');
    assert.equal(launcherCommand({ OMC_JEV_HANDOFF_COMMAND: 'my-launcher' }), 'my-launcher');
    assert.equal(launcherCommand({ OMC_JEV_HANDOFF_COMMAND: 'a b' }), 'jev-session');
    assert.equal(isHandoffFileName('/a/b/HANDOFF.md'), true);
    assert.equal(isHandoffFileName('C:\\x\\HANDOFF.md'), true);
    assert.equal(isHandoffFileName('HANDOFF.md'), true);
    assert.equal(isHandoffFileName('/a/b/other.md'), false);
    assert.equal(isHandoffFileName('/a/b/HANDOFF.md.bak'), false);
    assert.equal(isHandoffFileName(''), false);
    assert.equal(isHandoffFileName('/a/NEXT.md', { OMC_JEV_HANDOFF_FILE: 'NEXT.md' }), true);
  });

  it('isLauncherCommand: one launcher command, chains and substitutions refused', () => {
    assert.equal(isLauncherCommand('jev-session --role worker --brief /tmp/x/HANDOFF.md --name "n (successor)"'), true);
    assert.equal(isLauncherCommand('/opt/bin/jev-session --role worker'), true);
    assert.equal(isLauncherCommand('jev-session'), true);
    for (const forbidden of ['jev-session x; rm -rf y', 'jev-session x && curl z', 'jev-session x || curl z', 'jev-session $(id)', 'jev-session `id`', 'echo x | jev-session', 'jev-session x > /tmp/out', 'jev-session x < in', 'jev-session x &', 'jev-session x\ny', 'rm -rf /', '  ']) {
      assert.equal(isLauncherCommand(forbidden), false, `forbidden: ${JSON.stringify(forbidden)}`);
    }
    assert.equal(isLauncherCommand('my-launcher --role worker', { OMC_JEV_HANDOFF_COMMAND: 'my-launcher' }), true);
    assert.equal(isLauncherCommand('jev-session --role worker', { OMC_JEV_HANDOFF_COMMAND: 'my-launcher' }), false);
  });

  it('modelAlias: Claude model ids to the aliases of the use marker', () => {
    assert.equal(modelAlias('claude-opus-4-1-20250805'), 'opus');
    assert.equal(modelAlias('claude-sonnet-5-5'), 'sonnet');
    assert.equal(modelAlias('claude-haiku-4-5'), 'haiku');
    assert.equal(modelAlias('claude-fable-5'), 'fable');
    assert.equal(modelAlias('other-model-5.3'), '');
    assert.equal(modelAlias(''), '');
  });

  it('successor use line: sessions.jsonl, effort max left out, fallback from the transcript, no model', () => {
    const logs = tempDir();
    const stateDir = join(logs, 'state');
    const env = { OMC_JEV_LOG_DIR: logs };
    const transcript = join(logs, 'fallback.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"x"}}\n{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5"}}\n');
    const withoutModel = join(logs, 'no-model.jsonl');
    writeFileSync(withoutModel, '{"type":"user","message":{"role":"user","content":"x"}}\n{"type":"assistant","message":{"role":"assistant"}}\n');
    // (i) started_with.model + effort high; rows of another session are skipped
    writeFileSync(join(logs, 'sessions.jsonl'), JSON.stringify({ session_id: 's1', started_with: { model: 'opus', effort: 'high' } }) + '\n' + JSON.stringify({ session_id: 's2', started_with: { model: 'sonnet', effort: 'low' } }) + '\n');
    assert.equal(successorUseLine({ sessionId: 's1', transcriptPath: transcript, stateDir, env }), 'use opus high');
    // the last row of the session wins; model.to and effort.to as a fallback; effort max gives a line without the effort
    writeFileSync(join(logs, 'sessions.jsonl'), JSON.stringify({ session_id: 's3', started_with: { model: null, effort: null }, model: { to: 'fable' }, effort: { to: 'max' } }) + '\n');
    assert.equal(successorUseLine({ sessionId: 's3', transcriptPath: transcript, stateDir, env }), 'use fable');
    writeFileSync(join(logs, 'sessions.jsonl'), JSON.stringify({ session_id: 's4', started_with: { model: 'opus', effort: 'max' } }) + '\n');
    assert.equal(successorUseLine({ sessionId: 's4', stateDir, env }), 'use opus');
    // (ii) fallback from the transcript (no row of this session), without the effort
    assert.equal(successorUseLine({ sessionId: 's9', transcriptPath: transcript, stateDir, env }), 'use sonnet');
    // fallback: the last assistant message without a model field gives no fallback
    assert.equal(successorUseLine({ sessionId: 's10', transcriptPath: withoutModel, stateDir, env }), '');
    // (iii) no model (no row of the session, no transcript): no use line
    assert.equal(successorUseLine({ sessionId: 's11', stateDir, env: { OMC_JEV_LOG_DIR: join(logs, 'empty') } }), '');
    // the log directory is the state directory's jev directory when OMC_JEV_LOG_DIR is unset
    mkdirSync(join(stateDir, 'jev'), { recursive: true });
    writeFileSync(join(stateDir, 'jev', 'sessions.jsonl'), JSON.stringify({ session_id: 's12', started_with: { model: 'haiku', effort: 'low' } }) + '\n');
    assert.equal(successorUseLine({ sessionId: 's12', stateDir, env: {} }), 'use haiku low');
    // a row that sits in a rotated archive of the journal is found, and the live file wins over an archive
    const rotated = tempDir();
    writeFileSync(join(rotated, 'sessions-20261101-120000-77.jsonl'), JSON.stringify({ session_id: 's13', started_with: { model: 'opus', effort: 'low' } }) + '\n' + JSON.stringify({ session_id: 's14', started_with: { model: 'haiku' } }) + '\n');
    writeFileSync(join(rotated, 'sessions.jsonl'), JSON.stringify({ session_id: 's14', started_with: { model: 'sonnet', effort: 'high' } }) + '\n');
    assert.equal(successorUseLine({ sessionId: 's13', stateDir, env: { OMC_JEV_LOG_DIR: rotated } }), 'use opus low');
    assert.equal(successorUseLine({ sessionId: 's14', stateDir, env: { OMC_JEV_LOG_DIR: rotated } }), 'use sonnet high');
  });

  it('texts of the warning, the refusal and the handed-over denial, and the handoff steps', () => {
    const facts = { role: 'worker', coordinator: 'abc123', name: 'Track A' };
    const steps = handoffSteps({ useLine: 'use opus high', facts });
    assert.match(steps, /use opus high/);
    assert.match(steps, /jev-session --role worker --coordinator abc123 --brief/);
    assert.match(steps, /--name "Track A \(successor\)"/);
    assert.match(steps, /TAKEN OVER:/);
    const noRole = handoffSteps({ useLine: '', facts: null });
    assert.match(noRole, /jev-session --role worker --brief/);
    assert.doesNotMatch(noRole, /--coordinator/);
    assert.match(noRole, /Jev chooses the model and effort of the successor at start/);
    const warning = warningText({ sizeBytes: 20 * MIB + 123, useLine: 'use opus high', facts });
    assert.match(warning, /20\.0 MiB/);
    assert.match(warning, /From 25 MiB with an active ultragoal/);
    assert.match(warning, /use opus high/);
    const refusal = refusalText({ useLine: 'use opus high', facts });
    assert.match(refusal, /hand the session over/);
    assert.match(refusal, /HANDOFF\.md/);
    assert.match(refusal, /jev-session/);
    assert.match(refusal, /SendMessage/);
    assert.match(refusal, /BLOCKED: <reason, at least 20 characters>/);
    assert.ok(handedOverText('track-9').startsWith('[OMC HANDOFF] The session was handed over to track-9, end your turn; the coordinator will close the session (claude stop)'));
    // configuration changes the printed names
    const env = { OMC_JEV_HANDOFF_FILE: 'NEXT.md', OMC_JEV_HANDOFF_MARKER: 'DONE:', OMC_JEV_HANDOFF_COMMAND: 'my-launcher' };
    const custom = handoffSteps({ useLine: '', facts: null, env });
    assert.match(custom, /NEXT\.md/);
    assert.match(custom, /DONE:/);
    assert.match(custom, /my-launcher --role worker --brief/);
  });

  it('handoff state: atomic write and read of the file the hook resolved; takeover line', () => {
    const stateDir = tempDir();
    const file = join(stateDir, 'sessions', 's1', 'handoff.json'); // the hook passes the path resolved by the canonical session helper
    assert.deepEqual(readHandoffState(file), {});
    writeHandoffState(file, 's1', { last_warning_bytes: 20 * MIB + 5 });
    assert.equal(readHandoffState(file).last_warning_bytes, 20 * MIB + 5);
    assert.equal(readHandoffState(file).session_id, 's1');
    writeHandoffState(file, 's1', { handoff_path: '/tmp/x/HANDOFF.md' });
    assert.equal(readHandoffState(file).handoff_path, '/tmp/x/HANDOFF.md');
    // an unsafe session id and a missing path write nothing, and a missing path reads as an empty state
    writeHandoffState(join(stateDir, 'outside.json'), '../outside', { handoff_path: 'x' });
    assert.equal(existsSync(join(stateDir, 'outside.json')), false);
    writeHandoffState('', 's1', { handoff_path: 'x' });
    assert.deepEqual(readHandoffState(''), {});
    assert.deepEqual(readHandoffState(undefined), {});
    const taken = join(stateDir, 'taken.md');
    writeFileSync(taken, 'use opus high\nbrief\nTAKEN OVER: track-9 2026-11-14T20:00:00.000Z\n');
    assert.deepEqual(readTakeoverLine(taken), { found: true, name: 'track-9' });
    const without = join(stateDir, 'without.md');
    writeFileSync(without, 'use opus high\nbrief\n');
    assert.deepEqual(readTakeoverLine(without), { found: false, name: '' });
    assert.deepEqual(readTakeoverLine(join(stateDir, 'missing.md')), { found: false, name: '' });
    assert.deepEqual(readTakeoverLine(taken, { OMC_JEV_HANDOFF_MARKER: 'DONE:' }), { found: false, name: '' });
  });

  it('assessMode: handed over, handoff, warning, none', () => {
    assert.equal(assessMode({ sessionId: 's', sizeBytes: null, state: { handoff_path: '/x' }, takeover: { found: true } }), 'handed-over');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: 25 * MIB + 1, ultragoalDenial: true, state: {}, takeover: { found: false } }), 'handoff');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: 25 * MIB + 1, ultragoalDenial: false, state: {} }), 'warning');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: 20 * MIB + 1, ultragoalDenial: true, state: {} }), 'warning');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: 20 * MIB, ultragoalDenial: true, state: {} }), 'none');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: null, ultragoalDenial: true, state: {} }), 'none');
    assert.equal(assessMode({ sessionId: '', sizeBytes: 30 * MIB, ultragoalDenial: true, state: {} }), 'none');
    assert.equal(assessMode({ sessionId: 's', sizeBytes: 13 * MIB, state: {}, env: { OMC_JEV_HANDOFF_WARN_MIB: '12' } }), 'warning');
  });

  it('the block threshold equals MAX_TRANSCRIPT_BYTES of the hook', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'pre-tool-enforcer.mjs'), 'utf8');
    assert.match(source, /const MAX_TRANSCRIPT_BYTES = 25 \* 1024 \* 1024;/);
    assert.equal(HANDOFF_BLOCK_BYTES, 25 * 1024 * 1024);
  });

  it('launcherGate: the launcher journal decides whether a start happened; a call that did not start a session can be repeated up to the limit', () => {
    const logDir = tempDir();
    const brief = join(tempDir(), 'HANDOFF.md');
    const t0 = Date.now();
    const state = (extra = {}) => ({ handoff_path: brief, launcher_attempts: 1, launcher_attempt_ts: t0, ...extra });
    const row = (extra) => appendFileSync(join(logDir, 'sessions.jsonl'), JSON.stringify({ point: 'session-routing', ts: new Date(t0 + 1000).toISOString(), brief, ...extra }) + '\n');
    // no call yet: free; a start flag in the state: closed
    assert.deepEqual(launcherGate({ state: { handoff_path: brief }, logDir, now: t0 }), { allow: true, status: 'first' });
    assert.deepEqual(launcherGate({ state: state({ successor_started: true }), logDir, now: t0 }), { allow: false, status: 'started' });
    // a call without a row: in flight for LAUNCHER_IN_FLIGHT_MS, retryable after it (the launcher died or never wrote)
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + 1000 }), { allow: false, status: 'in-flight' });
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + LAUNCHER_IN_FLIGHT_MS + 1 }), { allow: true, status: 'retry' });
    // rows of other briefs, dry runs and rows before the call say nothing
    row({ brief: join(logDir, 'other.md'), starter_exit: 0 });
    row({ result: 'dry-run' });
    row({ ts: new Date(t0 - 5000).toISOString(), starter_exit: 0 });
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + 1000 }), { allow: false, status: 'in-flight' });
    // failure rows (pool refusal, a failed starter, an error exit): the call is repeatable at once
    row({ result: 'pool-refused' });
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + 1000 }), { allow: true, status: 'retry' });
    row({ result: 'decided', starter_exit: 1 });
    row({ result: 'decided', starter_exit: 'error:ENOENT' });
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + 1000 }), { allow: true, status: 'retry' });
    // the limit of calls without a start
    assert.deepEqual(launcherGate({ state: state({ launcher_attempts: LAUNCHER_ATTEMPT_LIMIT }), logDir, now: t0 + 1000 }), { allow: false, status: 'exhausted' });
    // a row of a started session wins over earlier failures, also from a rotated archive; the brief may also be given masked
    row({ result: 'decided', starter_exit: 0, session_id: 'ab12cd34' });
    assert.deepEqual(launcherGate({ state: state(), logDir, now: t0 + 1000 }), { allow: false, status: 'started' });
    const rotated = tempDir();
    writeFileSync(join(rotated, 'sessions-20991231-235959-1.jsonl'), JSON.stringify({ ts: new Date(t0 + 1000).toISOString(), brief, result: 'decided', starter_exit: 0 }) + '\n');
    writeFileSync(join(rotated, 'sessions.jsonl'), JSON.stringify({ ts: new Date(t0 + 2000).toISOString(), brief, result: 'pool-refused' }) + '\n');
    assert.deepEqual(launcherGate({ state: state(), logDir: rotated, now: t0 + 3000 }), { allow: false, status: 'started' });
    // the gate reaches handoffModeTools: the launcher command of a started handoff is refused, a failed one passes
    const context = { cwd: tempDir(), sessionStateDir: tempDir(), state: state(), logDir, now: t0 + 1000, env: {} };
    assert.equal(handoffModeTools('Bash', { command: `jev-session --role worker --brief ${brief}` }, context), false);
    assert.equal(handoffModeTools('Bash', { command: `jev-session --role worker --brief ${brief}` }, { ...context, logDir: tempDir() }), false); // no row: in flight
    assert.equal(handoffModeTools('Bash', { command: `jev-session --role worker --brief ${brief}` }, { ...context, logDir: tempDir(), now: t0 + LAUNCHER_IN_FLIGHT_MS + 1 }), true);
  });

  it('the refusal text names why the launcher is refused', () => {
    assert.match(refusalText({ launcherStatus: 'started' }), /The successor has already been started/);
    assert.match(refusalText({ launcherStatus: 'in-flight' }), /may still be running/);
    assert.match(refusalText({ launcherStatus: 'exhausted' }), new RegExp(`${LAUNCHER_ATTEMPT_LIMIT} times without starting a session`));
    assert.doesNotMatch(refusalText({ launcherStatus: 'first' }), /already been started|may still be running|without starting a session/);
  });

  it('the printed launcher command, with --brief equal to the registered path, passes once and is refused the second time', () => {
    const dir = tempDir();
    const cwd = join(dir, 'proj');
    mkdirSync(cwd, { recursive: true });
    const registered = join(cwd, 'HANDOFF.md');
    const steps = handoffSteps({ useLine: '', facts: { role: 'worker', coordinator: 'c1', name: 'n' } });
    const printed = /^2\. Start the successor \(Bash, exactly one command\): (.+)$/m.exec(steps)[1].replace('<path of HANDOFF.md>', registered);
    assert.equal(isLauncherCommand(printed), true);
    const state = { handoff_path: registered };
    const context = { cwd, sessionStateDir: join(dir, 'sessions', 's'), state };
    assert.equal(handoffModeTools('Bash', { command: printed }, context), true);
    assert.equal(handoffModeTools('Bash', { command: printed }, { ...context, state: { ...state, successor_started: true } }), false);
    assert.equal(handoffModeTools('Bash', { command: printed.replace(registered, join(dir, 'other.md')) }, context), false);
  });
});

// --- hook part ---------------------------------------------------------------------------------------------------

const SID = 'handoff-session';
const SID_SUB = 'handoff-subagent';

function newWorld() {
  const root = tempDir();
  const world = {
    root,
    home: join(root, 'home'),
    project: join(root, 'proj'),
    logs: join(root, 'logs'),
    transcripts: join(root, 'transcripts'),
  };
  for (const dir of [world.home, join(world.home, '.claude'), world.project, world.logs, world.transcripts]) mkdirSync(dir, { recursive: true });
  world.stateDir = join(world.home, '.omc', 'state');
  world.handoff = join(world.project, 'HANDOFF.md');
  world.transcript = join(world.transcripts, `${SID}.jsonl`);
  world.transcriptSub = join(world.transcripts, `${SID_SUB}.jsonl`);
  return world;
}

function hookEnv(world, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC|CODEX)/i.test(key)));
  Object.assign(env, { HOME: world.home, USERPROFILE: world.home, CLAUDE_CONFIG_DIR: join(world.home, '.claude'), OMC_JEV_LOG_DIR: world.logs, OMC_JEV_QUIET: '1', OMC_JEV_HANDOFF: '1' });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// A sparse transcript of the given size; assistant message rows are appended at its end (they carry the model field).
function sparseTranscript(path, bytes, rows = []) {
  closeSync(openSync(path, 'w'));
  truncateSync(path, bytes);
  // a new line first: the sparse file ends with a zero byte, a JSON row would be glued to it
  if (rows.length) appendFileSync(path, '\n' + rows.join('\n') + '\n');
}

// A global active ultragoal state file (the hook reads it also from a subagent's context).
function activeUltragoal(world) {
  mkdirSync(world.stateDir, { recursive: true });
  writeFileSync(join(world.stateDir, 'ultragoal-state.json'), JSON.stringify({
    active: true,
    current_phase: 'execution',
    started_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    objective: 'test objective',
    project_path: world.project,
  }));
}

function noUltragoal(world) {
  for (const path of [join(world.stateDir, 'ultragoal-state.json'), join(world.stateDir, 'sessions', SID, 'ultragoal-state.json'), join(world.stateDir, 'sessions', SID_SUB, 'ultragoal-state.json')]) rmSync(path, { force: true });
}

function runHook(world, tool, input, { sid = SID, transcript = world.transcript, agentId = null, env = {} } = {}) {
  const payload = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: sid, cwd: world.project, transcript_path: transcript };
  if (agentId) payload.agent_id = agentId;
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], { cwd: world.project, input: JSON.stringify(payload), env: hookEnv(world, env), encoding: 'utf8', timeout: 120_000 });
  const raw = String(result.stdout || '').trim();
  let output = null;
  try { output = JSON.parse(raw); } catch { output = null; }
  if (!output) {
    try { output = JSON.parse(raw.split('\n').filter(Boolean).pop() || ''); } catch { output = null; }
  }
  return { ...result, output };
}

function denied(output, fragment = '') {
  const reason = output?.hookSpecificOutput?.permissionDecision === 'deny' ? (output.hookSpecificOutput.permissionDecisionReason || '') : '';
  return Boolean(reason) && (fragment ? reason.includes(fragment) : true);
}

function reasonOf(output) {
  return output?.hookSpecificOutput?.permissionDecisionReason ?? '';
}

function contextOf(output) {
  return output?.hookSpecificOutput?.additionalContext ?? '';
}

function handoffRows(world) {
  const path = join(world.logs, 'denials.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === 'handoff');
}

function sessionsLog(world, row) {
  writeFileSync(join(world.logs, 'sessions.jsonl'), JSON.stringify(row) + '\n');
}

// A row the launcher (scripts/jev-session.mjs) would have written for a start of the handoff brief.
function launcherRow(world, row) {
  appendFileSync(join(world.logs, 'sessions.jsonl'), JSON.stringify({ point: 'session-routing', ...row }) + '\n');
}

// The handoff state file as the canonical session path helper places it.
const handoffFileOf = (world, sid = SID) => join(world.stateDir, 'sessions', sid, 'handoff.json');

describe('handoff hook (OMC_JEV_HANDOFF=1)', () => {
  it('warning from 20 MiB: once after crossing, again after a 1 MiB growth, not on every call', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 20 * MIB + 1);
    const first = runHook(world, 'Read', { file_path: '/etc/hosts' });
    assert.equal(denied(first.output), false, `passed: ${JSON.stringify(first.output)}`);
    const context1 = contextOf(first.output);
    assert.match(context1, /\[OMC HANDOFF\]/);
    assert.match(context1, /20\.0 MiB/);
    assert.match(context1, /HANDOFF STEPS/);
    // no growth: no warning (the frequency is kept in handoff.json)
    const second = runHook(world, 'Read', { file_path: '/etc/hosts' });
    assert.equal(denied(second.output), false);
    assert.equal(contextOf(second.output).includes('[OMC HANDOFF]'), false);
    // a growth by 1 MiB: the warning again
    sparseTranscript(world.transcript, 21 * MIB + 1);
    const third = runHook(world, 'Read', { file_path: '/etc/hosts' });
    assert.match(contextOf(third.output), /21\.0 MiB/);
    const rows = handoffRows(world).filter((row) => row.action === 'warning');
    assert.equal(rows.length, 2, `warning rows: ${rows.length}`);
    assert.equal(rows[0].session_id, SID);
    assert.equal(rows[0].tool_name, 'Read');
    assert.equal(rows[0].result, 'passed');
    assert.ok(rows[0].bytes > 20 * MIB);
  });

  it('configured warning threshold and step', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 12 * MIB + 1);
    const env = { OMC_JEV_HANDOFF_WARN_MIB: '12', OMC_JEV_HANDOFF_STEP_MIB: '2', OMC_JEV_HANDOFF_FILE: 'NEXT.md' };
    const first = runHook(world, 'Read', { file_path: '/etc/hosts' }, { env });
    assert.match(contextOf(first.output), /12\.0 MiB/);
    assert.match(contextOf(first.output), /NEXT\.md/);
    sparseTranscript(world.transcript, 13 * MIB + 1);
    assert.equal(contextOf(runHook(world, 'Read', { file_path: '/etc/hosts' }, { env }).output).includes('[OMC HANDOFF]'), false);
    sparseTranscript(world.transcript, 14 * MIB + 1);
    assert.match(contextOf(runHook(world, 'Read', { file_path: '/etc/hosts' }, { env }).output), /14\.0 MiB/);
  });

  it('handoff mode at 25 MiB with an active ultragoal: the handoff tools pass, everything else is refused with the steps and the use line', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    const allowed = [
      ['Write', { file_path: world.handoff, content: 'use opus high\n' }],
      ['Edit', { file_path: world.handoff, old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: '/etc/hosts' }],
      ['Grep', { pattern: 'brief', path: world.logs }],
      ['Glob', { pattern: '*.md', path: world.logs }],
      ['ToolSearch', { query: 'SendMessage' }],
      ['ListAgents', {}],
      ['SendMessage', { to: 'coordinator', message: 'handoff' }],
      ['Bash', { command: `jev-session --role worker --coordinator abc --brief ${world.handoff} --name "successor"` }],
    ];
    for (const [tool, input] of allowed) {
      const run = runHook(world, tool, input);
      assert.equal(denied(run.output), false, `${tool} must pass: ${JSON.stringify(run.output)}`);
    }
    const rows = handoffRows(world).filter((row) => row.action === 'handoff-allowed');
    // ToolSearch passes through the bootstrap exit of the ultragoal guard before the handoff branch: it is not counted
    assert.equal(rows.length, allowed.length - 1, `handoff-allowed rows: ${rows.length}`);
    assert.equal(rows[0].tool_name, 'Write');
    assert.equal(rows[0].session_id, SID);
    assert.equal(rows[0].result, 'passed');
    // the path of the allowed write of the handoff file is kept in the state
    assert.equal(readHandoffState(handoffFileOf(world)).handoff_path, resolve(world.handoff));
    const refused = [
      ['Bash', { command: 'jev-session x; rm -rf y' }],
      ['Bash', { command: 'jev-session x && curl z' }],
      ['Bash', { command: 'jev-session $(id)' }],
      ['Bash', { command: 'echo x | jev-session' }],
      ['Bash', { command: 'jev-session x > /tmp/out' }],
      ['Write', { file_path: join(world.logs, 'other.md'), content: 'x' }],
      ['Edit', { file_path: join(world.logs, 'other.md'), old_string: 'a', new_string: 'b' }],
    ];
    for (const [tool, input] of refused) {
      const run = runHook(world, tool, input);
      assert.equal(denied(run.output), true, `${tool} ${JSON.stringify(input)} must be refused: ${JSON.stringify(run.output)}`);
      const reason = reasonOf(run.output);
      assert.match(reason, /hand the session over/);
      assert.match(reason, /HANDOFF STEPS/);
      assert.match(reason, /use opus high/);
    }
    const refusalRows = handoffRows(world).filter((row) => row.action === 'handoff-refused');
    assert.equal(refusalRows.length, refused.length);
    assert.ok(refusalRows.every((row) => row.result === 'denied'));
  });

  it('use line: fallback from the transcript, no model, effort max left out', () => {
    // fallback: the model field of the last assistant message at the end of the transcript (sessions.jsonl without a row of this session)
    let world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1, ['{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5"}}']);
    activeUltragoal(world);
    let run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' });
    assert.equal(denied(run.output), true);
    assert.match(reasonOf(run.output), /the first line is `use sonnet`/);
    // no model: the text points to Jev's choice
    world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' });
    assert.equal(denied(run.output), true);
    assert.match(reasonOf(run.output), /Jev chooses the model and effort of the successor at start/);
    // effort max in sessions.jsonl: a line without the effort
    world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'max' } });
    run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' });
    assert.equal(denied(run.output), true);
    const reason = reasonOf(run.output);
    assert.match(reason, /the first line is `use opus`/);
    assert.doesNotMatch(reason, /use opus (low|medium|high|xhigh|max)/);
  });

  it('after a takeover line appended by another session every tool of the main session is refused with a handed-over-refused row', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    mkdirSync(join(world.stateDir, 'sessions', SID), { recursive: true });
    writeFileSync(world.handoff, 'use opus high\nbrief\n');
    const hash = createHash('sha256').update('use opus high\nbrief\n').digest('hex'); // the hash of the last write of the handing-over session
    writeFileSync(join(world.stateDir, 'sessions', SID, 'handoff.json'), JSON.stringify({ version: 1, session_id: SID, handoff_path: world.handoff, handoff_hash: hash }));
    appendFileSync(world.handoff, 'TAKEN OVER: track-9 2026-11-14T20:00:00.000Z\n'); // the line is appended by another session (outside the hook)
    const cases = [['Read', { file_path: '/etc/hosts' }], ['Write', { file_path: world.handoff, content: 'x' }], ['Bash', { command: `jev-session --role worker --brief ${world.handoff}` }], ['SendMessage', { to: 'x', message: 'y' }]];
    for (const [tool, input] of cases) {
      const run = runHook(world, tool, input);
      assert.equal(denied(run.output, 'The session was handed over to track-9, end your turn; the coordinator will close the session (claude stop)'), true, `${tool}: ${JSON.stringify(run.output)}`);
    }
    assert.equal(handoffRows(world).filter((row) => row.action === 'handed-over-refused').length, cases.length);
  });

  it('a subagent (agent_id) at a transcript over the limit passes with a handoff-subagent row', () => {
    const world = newWorld();
    sparseTranscript(world.transcriptSub, 25 * MIB + 1);
    activeUltragoal(world);
    const run = runHook(world, 'Read', { file_path: '/etc/hosts' }, { sid: SID_SUB, transcript: world.transcriptSub, agentId: 'agent-1' });
    assert.equal(denied(run.output), false, `the subagent must pass: ${JSON.stringify(run.output)}`);
    const rows = handoffRows(world).filter((row) => row.action === 'handoff-subagent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, 'agent-1');
    assert.equal(rows[0].session_id, SID_SUB);
  });

  it('without an active ultragoal there is no block at 25 MiB, only the warning', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    noUltragoal(world);
    const run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' });
    assert.equal(denied(run.output), false, `no block: ${JSON.stringify(run.output)}`);
    assert.match(contextOf(run.output), /\[OMC HANDOFF\]/);
    assert.equal(handoffRows(world).filter((row) => row.action === 'warning').length, 1);
  });

  it('the guard denial below the size limit is unchanged: the plain text, no handoff rows', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 20 * MIB + 1);
    activeUltragoal(world);
    const run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' });
    assert.equal(denied(run.output, 'ULTRAGOAL /GOAL REQUIRED'), true, `the plain denial: ${JSON.stringify(run.output)}`);
    assert.equal(handoffRows(world).length, 1); // the 20 MiB warning row only: the denial itself carries no handoff row
    assert.equal(handoffRows(world).filter((row) => row.action.startsWith('handoff-')).length, 0);
  });

  it('handoff-mode denials go through the denial counter under the guard name handoff: a degree text from the 3rd denial, never released', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    const env = { OMC_JEV_DENIAL_COUNTER: '1', OMC_JEV_DENIAL_RELEASE: '1', OMC_JEV_DENIAL_SESSION_MAX: '5' };
    let third = '';
    for (let i = 1; i <= 8; i++) {
      // every denial is its own model response: a new assistant message id at the end of the transcript
      appendFileSync(world.transcript, `{"type":"assistant","message":{"id":"msg-${i}","content":[]}}\n`);
      const run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' }, { env });
      assert.equal(denied(run.output, 'hand the session over'), true, `denial ${i} must stay a denial (the guard handoff is never released): ${JSON.stringify(run.output)}`);
      if (i < 3) assert.doesNotMatch(reasonOf(run.output), /DENIAL COUNTER/, `denial ${i} must have no degree text`);
      if (i === 3) third = reasonOf(run.output);
    }
    assert.match(third, /DENIAL COUNTER/);
    assert.match(third, /guard handoff/);
    const rows = readFileSync(join(world.logs, 'denials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.kind === 'denial' && row.guard === 'handoff' && row.action === 'escalation-1').length, 1);
    assert.equal(rows.filter((row) => row.kind === 'release').length, 0);
    assert.equal(handoffRows(world).filter((row) => row.action === 'handoff-refused').length, 8);
  });

  it('21 handoff-mode denials 2.2 s apart (no message ids: the time-gap package rule): a degree text from the 3rd, past 20 still a denial, one escalation row, 21 refusal rows', { timeout: 300_000 }, () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    const env = { OMC_JEV_DENIAL_COUNTER: '1' };
    // A synchronous gap above 2 s: without a package key, denials closer than 2 s count as one attempt.
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    let third = '';
    for (let i = 1; i <= 21; i++) {
      if (i > 1) pause(2200);
      const run = runHook(world, 'Write', { file_path: join(world.logs, 'other.md'), content: 'x' }, { env });
      assert.equal(denied(run.output, 'hand the session over'), true, `denial ${i} must stay a denial: ${JSON.stringify(run.output)}`);
      if (i < 3) assert.doesNotMatch(reasonOf(run.output), /DENIAL COUNTER/, `denial ${i} must have no degree text`);
      if (i === 3) third = reasonOf(run.output);
    }
    assert.match(third, /DENIAL COUNTER/);
    assert.match(third, /guard handoff/);
    const rows = readFileSync(join(world.logs, 'denials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.kind === 'denial' && row.guard === 'handoff' && row.action === 'escalation-1').length, 1);
    assert.equal(handoffRows(world).filter((row) => row.action === 'handoff-refused').length, 21);
  });

  it('a successor appends the takeover line through an allowed Edit and keeps working; a plain session editing an old handoff file with that line gets no denials', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 1); // a small transcript: a session without handoff mode (how a successor works)
    writeFileSync(world.handoff, 'use opus high\nbrief\n');
    const first = runHook(world, 'Edit', { file_path: world.handoff, old_string: 'brief', new_string: 'brief\nTAKEN OVER: successor 2026-11-15T00:00:00Z' });
    assert.equal(denied(first.output), false, `the successor's Edit must pass: ${JSON.stringify(first.output)}`);
    appendFileSync(world.handoff, 'TAKEN OVER: successor 2026-11-15T00:00:00Z\n'); // simulates the Edit
    for (const [tool, input] of [['Read', { file_path: '/etc/hosts' }], ['Bash', { command: 'ls' }], ['Edit', { file_path: world.handoff, old_string: 'brief', new_string: 'brief edited' }], ['Bash', { command: 'echo ok' }]]) {
      const run = runHook(world, tool, input);
      assert.equal(denied(run.output), false, `${tool} must pass: ${JSON.stringify(run.output)}`);
    }
    assert.equal(handoffRows(world).length, 0, 'no handoff rows');
  });

  it('the handing-over session: its own takeover line does not close it, a line appended by another session does', () => {
    // (1) the session appends the line itself through an allowed Edit: not closed
    let world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    const write = runHook(world, 'Write', { file_path: world.handoff, content: 'use opus high\nbrief\n' }); // a file that does not exist in the cwd: passes, the hash is registered
    assert.equal(denied(write.output), false, `the Write must pass: ${JSON.stringify(write.output)}`);
    writeFileSync(world.handoff, 'use opus high\nbrief\n'); // simulates the Write
    const edit = runHook(world, 'Edit', { file_path: world.handoff, old_string: 'brief', new_string: 'brief\nTAKEN OVER: mistake-session 2026-11-15T01:00:00Z' });
    assert.equal(denied(edit.output), false, `the Edit must pass: ${JSON.stringify(edit.output)}`);
    appendFileSync(world.handoff, 'TAKEN OVER: mistake-session 2026-11-15T01:00:00Z\n'); // exactly the content the hook predicted for this Edit
    const read = runHook(world, 'Read', { file_path: '/etc/hosts' });
    assert.equal(denied(read.output), false, `its own line must not close the session: ${JSON.stringify(read.output)}`);
    assert.equal(handoffRows(world).filter((row) => row.action === 'handed-over-refused').length, 0);
    // (2) another session appends the line (outside this session's hook): the handing-over session is closed
    world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    const write2 = runHook(world, 'Write', { file_path: world.handoff, content: 'use opus high\nbrief\n' });
    assert.equal(denied(write2.output), false);
    writeFileSync(world.handoff, 'use opus high\nbrief\n');
    appendFileSync(world.handoff, 'TAKEN OVER: track-9 2026-11-15T02:00:00Z\n'); // appended by the successor
    const closed = runHook(world, 'Read', { file_path: '/etc/hosts' });
    assert.equal(denied(closed.output, 'The session was handed over to track-9'), true, `a foreign line closes the session: ${JSON.stringify(closed.output)}`);
    assert.equal(handoffRows(world).filter((row) => row.action === 'handed-over-refused').length, 1);
  });

  it('handoff mode restrictions: Write/Edit only in the session cwd or state directory and only for a new file or one written by the session; Bash launcher only with --brief equal to the registered path and only once', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    // (a) Write to HANDOFF.md outside the cwd and the session state: refused
    const outside = runHook(world, 'Write', { file_path: join(world.home, '.claude', 'hooks', 'HANDOFF.md'), content: 'a' });
    assert.equal(denied(outside.output, 'hand the session over'), true, `Write outside the directories must be refused: ${JSON.stringify(outside.output)}`);
    assert.match(reasonOf(outside.output), /BLOCKED: <reason, at least 20 characters>/);
    // (b) Write to the session state directory (the file does not exist): passes
    const sessionStateDir = join(world.stateDir, 'sessions', SID);
    const inState = join(sessionStateDir, 'HANDOFF.md');
    const inStateRun = runHook(world, 'Write', { file_path: inState, content: 'use opus high\nstate\n' });
    assert.equal(denied(inStateRun.output), false, `Write to the session state directory must pass: ${JSON.stringify(inStateRun.output)}`);
    assert.equal(readHandoffState(handoffFileOf(world)).handoff_path, resolve(inState));
    // (c) Bash launcher with a foreign --brief: refused
    const foreign = runHook(world, 'Bash', { command: 'jev-session --role worker --brief /etc/hostname --name "x (successor)"' });
    assert.equal(denied(foreign.output, 'hand the session over'), true, `Bash with a foreign --brief must be refused: ${JSON.stringify(foreign.output)}`);
    // (d) Bash with --brief equal to the registered path: passes; the call is noted in the state, a start is not assumed
    const command = `jev-session --role worker --brief ${inState} --name "successor"`;
    const once = runHook(world, 'Bash', { command });
    assert.equal(denied(once.output), false, `Bash with --brief equal to the registered path must pass: ${JSON.stringify(once.output)}`);
    const afterCall = readHandoffState(handoffFileOf(world));
    assert.equal(afterCall.launcher_attempts, 1);
    assert.equal(afterCall.successor_started, undefined);
    // (e) a second call while the first has left no row in the launcher journal: refused, it may still be running
    const twice = runHook(world, 'Bash', { command });
    assert.equal(denied(twice.output, 'may still be running'), true, `the second call must wait: ${JSON.stringify(twice.output)}`);
    // (e2) the launcher refused the start (a pool refusal row for this brief): the call can be repeated, and the repeat is noted
    launcherRow(world, { ts: new Date(Date.now() + 1000).toISOString(), brief: inState, result: 'pool-refused' });
    const retry = runHook(world, 'Bash', { command });
    assert.equal(denied(retry.output), false, `a call that did not start a session can be repeated: ${JSON.stringify(retry.output)}`);
    assert.equal(readHandoffState(handoffFileOf(world)).launcher_attempts, 2);
    // (e3) the launcher started a session (starter_exit 0): the next call is refused for good, and the start is kept in the state
    launcherRow(world, { ts: new Date(Date.now() + 2000).toISOString(), brief: inState, result: 'decided', starter_exit: 0, session_id: 'ab12cd34' });
    const third = runHook(world, 'Bash', { command });
    assert.equal(denied(third.output, 'The successor has already been started'), true, `a confirmed start must not be repeated: ${JSON.stringify(third.output)}`);
    assert.equal(readHandoffState(handoffFileOf(world)).successor_started, true);
    const fourth = runHook(world, 'Bash', { command });
    assert.equal(denied(fourth.output, 'The successor has already been started'), true);
    // (f) Edit of the own file in the session state directory: passes (written earlier by this session)
    const own = runHook(world, 'Edit', { file_path: inState, old_string: 'state', new_string: 'state appended' });
    assert.equal(denied(own.output), false, `Edit of the own file must pass: ${JSON.stringify(own.output)}`);
    // (g) Write to an existing HANDOFF.md in the cwd that this session did not write: refused
    writeFileSync(world.handoff, 'an old file of another session\n');
    const foreignFile = runHook(world, 'Write', { file_path: world.handoff, content: 'x' });
    assert.equal(denied(foreignFile.output, 'hand the session over'), true, `Write over a foreign existing file must be refused: ${JSON.stringify(foreignFile.output)}`);
  });

  it('the launcher command, file name and marker from the configuration', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    const env = { OMC_JEV_HANDOFF_FILE: 'NEXT.md', OMC_JEV_HANDOFF_COMMAND: 'my-launcher', OMC_JEV_HANDOFF_MARKER: 'DONE:' };
    const next = join(world.project, 'NEXT.md');
    assert.equal(denied(runHook(world, 'Write', { file_path: next, content: 'x\n' }, { env }).output), false);
    assert.equal(denied(runHook(world, 'Write', { file_path: world.handoff, content: 'x\n' }, { env }).output), true);
    assert.equal(denied(runHook(world, 'Bash', { command: `my-launcher --role worker --brief ${next}` }, { env }).output), false);
    const refused = runHook(world, 'Bash', { command: `jev-session --role worker --brief ${next}` }, { env });
    assert.equal(denied(refused.output, 'NEXT.md'), true);
    assert.match(reasonOf(refused.output), /my-launcher --role worker --brief/);
    assert.match(reasonOf(refused.output), /DONE:/);
  });

  it('the cancel exits of the ultragoal guard stay as a deliberate valve, with no handoff row', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    const cases = [
      ['ToolSearch', { query: 'select:SendMessage' }],
      ['mcp__plugin_oh-my-claudecode_t__state_clear', { mode: 'ultragoal' }],
      ['Skill', { skill: 'oh-my-claudecode:cancel' }],
      ['Bash', { command: 'omc cancel --force' }],
      ['Bash', { command: 'omc ultragoal checkpoint' }],
    ];
    for (const [tool, input] of cases) {
      const run = runHook(world, tool, input);
      assert.equal(denied(run.output), false, `${tool} must pass as a deliberate valve: ${JSON.stringify(run.output)}`);
    }
    assert.equal(handoffRows(world).filter((row) => row.action === 'handoff-allowed').length, 0);
  });

  it('an Agent call of a subagent in handoff mode does not end the hook early: it gets the "Spawning agent" context as outside the mode', () => {
    const world = newWorld();
    sparseTranscript(world.transcriptSub, 25 * MIB + 1);
    activeUltragoal(world);
    const run = runHook(world, 'Agent', { subagent_type: 'oh-my-claudecode:executor', prompt: 'x' }, { sid: SID_SUB, transcript: world.transcriptSub, agentId: 'agent-9' });
    assert.equal(denied(run.output), false, `the subagent must pass: ${JSON.stringify(run.output)}`);
    assert.match(contextOf(run.output), /Spawning agent/, `the Spawning agent context in handoff mode: ${JSON.stringify(run.output).slice(0, 400)}`);
    assert.equal(handoffRows(world).filter((row) => row.action === 'handoff-subagent').length, 1);
    // control outside the mode: the same output form
    const control = newWorld();
    sparseTranscript(control.transcriptSub, 1);
    noUltragoal(control);
    const run2 = runHook(control, 'Agent', { subagent_type: 'oh-my-claudecode:executor', prompt: 'x' }, { sid: `${SID_SUB}-plain`, transcript: control.transcriptSub, agentId: 'agent-10' });
    assert.match(contextOf(run2.output), /Spawning agent/, `control outside the mode: ${JSON.stringify(run2.output).slice(0, 400)}`);
  });

  it('without OMC_JEV_HANDOFF the behavior is unchanged: no warning, no state, no rows, the plain ultragoal denial at 25 MiB', () => {
    const world = newWorld();
    sparseTranscript(world.transcript, 21 * MIB);
    noUltragoal(world);
    const warned = runHook(world, 'Read', { file_path: '/etc/hosts' }, { env: { OMC_JEV_HANDOFF: undefined } });
    assert.equal(denied(warned.output), false);
    assert.equal(contextOf(warned.output).includes('[OMC HANDOFF]'), false);
    sparseTranscript(world.transcript, 25 * MIB + 1);
    activeUltragoal(world);
    sessionsLog(world, { session_id: SID, started_with: { model: 'opus', effort: 'high' } });
    for (const [tool, input] of [['Write', { file_path: world.handoff, content: 'x' }], ['Read', { file_path: '/etc/hosts' }], ['Bash', { command: 'jev-session --role worker --brief x' }]]) {
      const run = runHook(world, tool, input, { env: { OMC_JEV_HANDOFF: undefined } });
      assert.equal(denied(run.output, 'ULTRAGOAL /GOAL REQUIRED'), true, `${tool}: ${JSON.stringify(run.output)}`);
      assert.equal(reasonOf(run.output).includes('hand the session over'), false);
    }
    assert.equal(existsSync(join(world.stateDir, 'sessions', SID, 'handoff.json')), false);
    assert.equal(handoffRows(world).length, 0);
    // a value other than exactly 1 leaves it off
    const other = runHook(world, 'Write', { file_path: world.handoff, content: 'x' }, { env: { OMC_JEV_HANDOFF: 'true' } });
    assert.equal(denied(other.output, 'ULTRAGOAL /GOAL REQUIRED'), true);
    assert.equal(existsSync(join(world.stateDir, 'sessions', SID, 'handoff.json')), false);
  });
});
