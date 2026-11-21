/**
 * Hook-level tests for the opt-in repeated-failure series (OMC_JEV_FAILURE_SERIES=1) in
 * scripts/post-tool-use-failure.mjs: the unchanged default behavior (state v1, old text at the
 * 5th failure), the per-signature series with one nudge at the third failure and one final state
 * at the fourth, separate series for different errors of one tool, the path-keyed series for
 * mutating commands, the package rule (one attempt per model response) by the transcript message
 * id and via its time-gap fallback, the 4 KiB state limit, and the threshold overrides.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';

import { errorSeriesKey, failureSignature, hashSignature } from '../../scripts/lib/jev-failure-signature.mjs';

const NODE = process.execPath;
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'post-tool-use-failure.mjs');
// Repo-local temp root: the hook resolves the state root under its own cwd, so the input cwd has
// to stay contained within the repository (same pattern as post-tool-use-failure.test.ts).
const TEST_TMP_ROOT = join(REPO_ROOT, '.tmp-post-tool-use-failure-series-tests');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Environment with the series switches stripped, so "unset" cases stay unset regardless of the
// host environment.
function baseEnv() {
  const env = { ...process.env, OMC_STATE_DIR: '' };
  for (const key of ['OMC_JEV_FAILURE_SERIES', 'OMC_JEV_FAILURE_SERIES_NUDGE', 'OMC_JEV_FAILURE_SERIES_FINAL', 'OMC_SESSION_ID', 'DISABLE_OMC', 'OMC_SKIP_HOOKS']) {
    delete env[key];
  }
  return env;
}

const tempDirs = [];
function makeTempDir() {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function runHook(input, extraEnv = {}) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...baseEnv(), CLAUDE_PLUGIN_ROOT: REPO_ROOT, NODE_ENV: 'test', ...extraEnv },
    timeout: 20000,
  }).trim();
  return JSON.parse(raw);
}

function failingInput(cwd, sessionId, overrides = {}) {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'cat /p/missing-file.txt' },
    error: 'Error: ENOENT: no such file or directory',
    cwd,
    session_id: sessionId,
    ...overrides,
  };
}

// A transcript whose last assistant message id is unique per file name and message count, so a
// new count means a new model response.
function writeTranscript(dir, name, messageCount) {
  const path = join(dir, name);
  writeFileSync(path, Array.from({ length: messageCount }, (_, j) => JSON.stringify({ type: 'assistant', message: { id: `msg_${name}-${j}` } })).join('\n') + '\n');
  return path;
}

function sessionStatePath(cwd, sessionId) {
  return join(cwd, '.omc', 'state', 'sessions', sessionId, 'last-tool-error-state.json');
}

function readState(cwd, sessionId) {
  return JSON.parse(readFileSync(sessionStatePath(cwd, sessionId), 'utf-8'));
}

describe('post-tool-use-failure.mjs failure series (opt-in)', () => {
  it('keeps the hook unchanged when the switch is unset or 0 (state v1, old text at the 5th failure)', () => {
    for (const extraEnv of [{}, { OMC_JEV_FAILURE_SERIES: '0' }]) {
      const cwd = makeTempDir();
      const sid = `off-${extraEnv.OMC_JEV_FAILURE_SERIES ?? 'unset'}`;
      for (let i = 1; i <= 5; i++) {
        const out = runHook(failingInput(cwd, sid), extraEnv);
        const text = String(out.hookSpecificOutput?.additionalContext ?? '');
        if (i < 5) {
          expect(text).toBe('Tool "Bash" failed. Analyze the error, fix the issue, and continue working.');
        } else {
          expect(text).toContain('has failed 5 times');
          expect(text).toContain('ask the user for guidance');
          expect(text).not.toContain('OMC FAILURE SERIES');
        }
      }
      const state = readState(cwd, sid);
      expect('version' in state).toBe(false);
      expect('error_key' in state).toBe(false);
      expect(state.retry_count).toBe(5);
    }
  });

  it('fires the nudge at the third failure and the final state at the fourth, once per series', async () => {
    const cwd = makeTempDir();
    const sid = 'series-on';
    const outputs = [];
    for (let i = 1; i <= 5; i++) {
      if (i > 1) await sleep(2100); // cross the package gap: every run is a new attempt
      outputs.push(runHook(failingInput(cwd, sid), { OMC_JEV_FAILURE_SERIES: '1' }));
    }
    const texts = outputs.map((o) => String(o.hookSpecificOutput?.additionalContext ?? ''));
    expect(texts[0]).not.toContain('OMC FAILURE SERIES');
    expect(texts[1]).not.toContain('OMC FAILURE SERIES');
    expect(texts[2]).toContain('[OMC FAILURE SERIES]');
    expect(texts[2]).not.toContain('FINAL');
    expect(texts[2]).toContain('BLOCKED: <reason, at least 20 characters>');
    expect(texts[3]).toContain('[OMC FAILURE SERIES: FINAL]');
    expect(texts[3]).toContain('failed 4 times');
    expect(texts[4]).not.toContain('OMC FAILURE SERIES');
    const input = failingInput(cwd, sid);
    const expectedKey = errorSeriesKey('Bash', input.tool_input, input.error);
    const state = readState(cwd, sid);
    expect(state.version).toBe(2);
    expect(state.retry_count).toBe(5);
    expect(state.nudge_sent).toBe(1);
    expect(state.end_sent).toBe(1);
    expect(state.signature_hash).toBe(hashSignature(failureSignature(input.error)));
    expect(state.error_key).toBe(expectedKey.key);
    expect(state.tool_name).toBe('Bash');
  }, 45000);

  it('counts one model response as one attempt by the transcript message id (package key)', () => {
    const cwd = makeTempDir();
    const sid = 'package-key';
    const transcript = writeTranscript(cwd, 'package.jsonl', 1); // same transcript = same model response
    const run = () => runHook(failingInput(cwd, sid, { transcript_path: transcript }), { OMC_JEV_FAILURE_SERIES: '1' });
    run();
    run();
    const third = run();
    expect(String(third.hookSpecificOutput?.additionalContext ?? '')).not.toContain('OMC FAILURE SERIES');
    const state = readState(cwd, sid);
    expect(state.retry_count).toBe(1); // three calls of one response are one attempt
    expect(state.package_key).toBe('msg_package.jsonl-0'); // the key comes from the transcript
  });

  it('fires the nudge and the final state when every failure has its own message id (no time gap needed)', () => {
    const cwd = makeTempDir();
    const sid = 'package-key-series';
    const outputs = [];
    for (let i = 1; i <= 5; i++) {
      const transcript = writeTranscript(cwd, 'series.jsonl', i); // a new assistant message per run = a new attempt
      outputs.push(runHook(failingInput(cwd, sid, { transcript_path: transcript }), { OMC_JEV_FAILURE_SERIES: '1' }));
    }
    const texts = outputs.map((o) => String(o.hookSpecificOutput?.additionalContext ?? ''));
    expect(texts[0]).not.toContain('OMC FAILURE SERIES');
    expect(texts[1]).not.toContain('OMC FAILURE SERIES');
    expect(texts[2]).toContain('[OMC FAILURE SERIES]');
    expect(texts[2]).not.toContain('FINAL');
    expect(texts[3]).toContain('[OMC FAILURE SERIES: FINAL]');
    expect(texts[4]).not.toContain('OMC FAILURE SERIES');
    const state = readState(cwd, sid);
    expect(state.retry_count).toBe(5);
    expect(state.package_key).toBe('msg_series.jsonl-4');
    expect(state.nudge_sent).toBe(1);
    expect(state.end_sent).toBe(1);
  });

  it('does not read the transcript while the switch is off (package key stays absent)', () => {
    const cwd = makeTempDir();
    const sid = 'package-key-off';
    const transcript = writeTranscript(cwd, 'off.jsonl', 2);
    runHook(failingInput(cwd, sid, { transcript_path: transcript }));
    const state = readState(cwd, sid);
    expect('package_key' in state).toBe(false);
    expect(state.retry_count).toBe(1);
  });

  it('does not add up two different errors of the same tool (separate series)', async () => {
    const cwd = makeTempDir();
    const sid = 'two-errors';
    const run = (error, command) => runHook(failingInput(cwd, sid, { error, tool_input: { command } }), { OMC_JEV_FAILURE_SERIES: '1' });
    run('Error: ENOENT: no such file or directory', 'cat a.txt');
    await sleep(2100);
    run('Error: ENOENT: no such file or directory', 'cat b.txt');
    await sleep(2100);
    const third = run('Error: EACCES: permission denied', 'chmod 000 file');
    await sleep(2100);
    const fourth = run('Error: EACCES: permission denied', 'chmod 000 file2');
    expect(String(third.hookSpecificOutput?.additionalContext ?? '')).not.toContain('OMC FAILURE SERIES');
    expect(String(fourth.hookSpecificOutput?.additionalContext ?? '')).not.toContain('OMC FAILURE SERIES');
    const state = readState(cwd, sid);
    expect(state.retry_count).toBe(2); // the new-signature series counts 2, not 4
  }, 40000);

  it('catches mutating commands on the same file as one series across different commands and messages', async () => {
    const cwd = makeTempDir();
    const sid = 'mutating';
    const target = join(cwd, 'target.json');
    const runs = [
      { tool_input: { command: `rm -f ${target}` }, error: 'rm: cannot remove: Permission denied' },
      { tool_input: { command: `rm -f ${target}` }, error: 'rm: cannot remove: Permission denied' },
      { tool_input: { command: `sed -i 's/a/b/' ${target}` }, error: 'sed: cannot rename: Device busy' },
      { tool_input: { command: `tee ${target} < data` }, error: 'tee: write error' },
    ];
    const outputs = [];
    for (let i = 0; i < runs.length; i++) {
      if (i > 0) await sleep(2100);
      outputs.push(runHook(failingInput(cwd, sid, runs[i]), { OMC_JEV_FAILURE_SERIES: '1' }));
    }
    const texts = outputs.map((o) => String(o.hookSpecificOutput?.additionalContext ?? ''));
    expect(texts[0]).not.toContain('OMC FAILURE SERIES');
    expect(texts[1]).not.toContain('OMC FAILURE SERIES');
    expect(texts[2]).toContain('[OMC FAILURE SERIES]');
    expect(texts[3]).toContain('[OMC FAILURE SERIES: FINAL]');
    const state = readState(cwd, sid);
    expect(state.retry_count).toBe(4);
    expect(state.error_key).toMatch(/^mut\|Bash\|/);
    expect(state.path_hash).toMatch(/^[0-9a-f]{16}$/);
  }, 45000);

  it('counts failures within the package gap as one attempt (time-gap fallback)', () => {
    const cwd = makeTempDir();
    const sid = 'package-gap';
    const input = failingInput(cwd, sid);
    const key = errorSeriesKey('Bash', input.tool_input, input.error).key;
    const statePath = sessionStatePath(cwd, sid);
    mkdirSync(join(cwd, '.omc', 'state', 'sessions', sid), { recursive: true });
    const seed = (packageTs) => writeFileSync(statePath, JSON.stringify({
      version: 2,
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 1,
      signature_hash: 'seeded',
      path_hash: null,
      error_key: key,
      package_key: null,
      package_ts: packageTs,
      nudge_sent: 0,
      end_sent: 0,
    }, null, 2));
    seed(Date.now() + 3600000); // far future: the delta stays within the gap
    const same = runHook(input, { OMC_JEV_FAILURE_SERIES: '1' });
    expect(String(same.hookSpecificOutput?.additionalContext ?? '')).not.toContain('OMC FAILURE SERIES');
    expect(readState(cwd, sid).retry_count).toBe(1);
    seed(Date.now() - 5000); // past the gap: a new attempt
    const next = runHook(input, { OMC_JEV_FAILURE_SERIES: '1' });
    expect(readState(cwd, sid).retry_count).toBe(2);
    expect(String(next.hookSpecificOutput?.additionalContext ?? '')).not.toContain('OMC FAILURE SERIES');
  }, 30000);

  it('keeps the series state under the 4 KiB limit (pathologically long tool name)', () => {
    const cwd = makeTempDir();
    const sid = 'state-limit';
    runHook(failingInput(cwd, sid, { tool_name: 'B'.repeat(4000) }), { OMC_JEV_FAILURE_SERIES: '1' });
    const statePath = sessionStatePath(cwd, sid);
    const size = statSync(statePath).size;
    expect(size).toBeLessThanOrEqual(4096);
    const state = readState(cwd, sid); // parseable
    expect(state.version).toBe(2);
  });

  it('honors the threshold overrides end to end', async () => {
    const cwd = makeTempDir();
    const sid = 'thresholds';
    const env = { OMC_JEV_FAILURE_SERIES: '1', OMC_JEV_FAILURE_SERIES_NUDGE: '2', OMC_JEV_FAILURE_SERIES_FINAL: '3' };
    const outputs = [];
    for (let i = 1; i <= 3; i++) {
      if (i > 1) await sleep(2100);
      outputs.push(runHook(failingInput(cwd, sid), env));
    }
    const texts = outputs.map((o) => String(o.hookSpecificOutput?.additionalContext ?? ''));
    expect(texts[0]).not.toContain('OMC FAILURE SERIES');
    expect(texts[1]).toContain('[OMC FAILURE SERIES]');
    expect(texts[2]).toContain('[OMC FAILURE SERIES: FINAL]');
  }, 40000);
});
