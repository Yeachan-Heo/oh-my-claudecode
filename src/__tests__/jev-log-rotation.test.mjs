/* global process */
/**
 * Tests for Jev log rotation (OMC_JEV_LOG_MAX_MB) on the script side:
 * rotateJevLog and resolveJevLogMaxBytes in scripts/jev-resolve.mjs, the
 * shadow-log writer of resolveRequest, the resolver child process, and the
 * --include-rotated flag of scripts/jev-eval.mjs.
 *
 * .mjs so vitest picks it up without tsc typechecking the untyped scripts.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Lets one test make every rename fail, as a locked file or a lost race does.
const fsControl = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renameSync: (...args) => {
      if (fsControl.failRename) {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      return actual.renameSync(...args);
    },
  };
});

import { resolveJevLogMaxBytes, resolveRequest, rotateJevLog } from '../../scripts/jev-resolve.mjs';
import { rotatedLogPaths } from '../../scripts/jev-eval.mjs';
import { parseJevConfig } from '../hooks/jev/config.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const RESOLVE_SCRIPT = join(root, 'scripts', 'jev-resolve.mjs');
const EVAL_SCRIPT = join(root, 'scripts', 'jev-eval.mjs');
const MIB = 1024 * 1024;
const ROTATED = /^shadow-\d{8}-\d{6}-\d+\.jsonl$/;

const tmp = mkdtempSync(join(tmpdir(), 'jev-log-rotation-test-'));
const afterHooks = [];
afterAll(async () => {
  for (const fn of afterHooks.reverse()) await fn();
  rmSync(tmp, { recursive: true, force: true });
});

let dirCount = 0;
function freshDir() {
  dirCount += 1;
  const dir = join(tmp, 'case-' + dirCount);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** JSONL text of at least `bytes` bytes, one fake log line per 100 bytes or so. */
function filler(bytes) {
  const line = JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', point: 'intent', mode: 'shadow', pad: 'x'.repeat(40) }) + '\n';
  return line.repeat(Math.ceil(bytes / line.length));
}

const QUESTIONS = { route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } } };
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) });

function envFor(dir, overrides = {}) {
  return { TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing', OMC_JEV_LOG_DIR: dir, ...overrides };
}

describe('resolveJevLogMaxBytes parity with the TS config contract', () => {
  it.each([
    [{}],
    [{ OMC_JEV_LOG_MAX_MB: '' }],
    [{ OMC_JEV_LOG_MAX_MB: '0' }],
    [{ OMC_JEV_LOG_MAX_MB: '1' }],
    [{ OMC_JEV_LOG_MAX_MB: '50' }],
    [{ OMC_JEV_LOG_MAX_MB: ' 5 ' }],
    [{ OMC_JEV_LOG_MAX_MB: '1e3' }],
    [{ OMC_JEV_LOG_MAX_MB: '-1' }],
    [{ OMC_JEV_LOG_MAX_MB: '1.5' }],
    [{ OMC_JEV_LOG_MAX_MB: '2.5' }],
    [{ OMC_JEV_LOG_MAX_MB: '08' }],
    [{ OMC_JEV_LOG_MAX_MB: '9999999999999' }],
  ])('script and TS agree for %j', (env) => {
    expect(resolveJevLogMaxBytes(env)).toBe(parseJevConfig({ OMC_JEV_LOG_DIR: tmp, ...env }).logMaxBytes);
  });

  it('is 0 (no rotation) without the variable and the limit in MiB with it', () => {
    expect(resolveJevLogMaxBytes({})).toBe(0);
    expect(resolveJevLogMaxBytes({ OMC_JEV_LOG_MAX_MB: '50' })).toBe(50 * MIB);
  });
});

describe('rotateJevLog', () => {
  const now = new Date('2026-11-09T14:30:05.123Z');

  it('leaves a file at the limit in place', () => {
    const dir = freshDir();
    const path = join(dir, 'shadow.jsonl');
    writeFileSync(path, 'x'.repeat(1024));
    rotateJevLog(path, 1024, now);
    expect(readdirSync(dir)).toEqual(['shadow.jsonl']);
  });

  it('renames a file above the limit to <name>-<UTC stamp>-<pid>.jsonl', () => {
    const dir = freshDir();
    const path = join(dir, 'shadow.jsonl');
    const content = 'x'.repeat(1025);
    writeFileSync(path, content);
    rotateJevLog(path, 1024, now);
    const target = `shadow-20261109-143005-${process.pid}.jsonl`;
    expect(readdirSync(dir)).toEqual([target]);
    expect(readFileSync(join(dir, target), 'utf8')).toBe(content);
  });

  it('never rotates with a limit of 0', () => {
    const dir = freshDir();
    const path = join(dir, 'shadow.jsonl');
    writeFileSync(path, 'x'.repeat(4096));
    rotateJevLog(path, 0, now);
    expect(readdirSync(dir)).toEqual(['shadow.jsonl']);
  });

  it('never overwrites an existing target', () => {
    const dir = freshDir();
    const path = join(dir, 'shadow.jsonl');
    const target = join(dir, `shadow-20261109-143005-${process.pid}.jsonl`);
    writeFileSync(target, 'rotated earlier');
    writeFileSync(path, 'x'.repeat(2048));
    expect(() => rotateJevLog(path, 1024, now)).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('rotated earlier');
    expect(readFileSync(path, 'utf8')).toBe('x'.repeat(2048));
  });

  it('does nothing and does not throw for a missing file', () => {
    const dir = freshDir();
    expect(() => rotateJevLog(join(dir, 'shadow.jsonl'), 1024, now)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('resolveRequest shadow-log rotation', () => {
  it('without OMC_JEV_LOG_MAX_MB a shadow.jsonl above 1 MiB keeps growing exactly as before', async () => {
    const dir = freshDir();
    const before = filler(MIB + 1);
    writeFileSync(join(dir, 'shadow.jsonl'), before);
    await resolveRequest({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, heuristic: 'sonnet' }, envFor(dir), okFetch);
    expect(readdirSync(dir)).toEqual(['shadow.jsonl']);
    const after = readFileSync(join(dir, 'shadow.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.slice(before.length))).toMatchObject({ point: 'model-routing', mode: 'shadow', jev: { choice: 'opus' } });
  });

  it('with OMC_JEV_LOG_MAX_MB=1 a file above 1 MiB is renamed and the new line starts a new shadow.jsonl', async () => {
    const dir = freshDir();
    const before = filler(MIB + 1);
    writeFileSync(join(dir, 'shadow.jsonl'), before);
    await resolveRequest({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, heuristic: 'sonnet' }, envFor(dir, { OMC_JEV_LOG_MAX_MB: '1' }), okFetch);
    const rotated = readdirSync(dir).filter((name) => ROTATED.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(dir, rotated[0]), 'utf8')).toBe(before);
    const lines = readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ point: 'model-routing', mode: 'shadow' });
  });

  it('with OMC_JEV_LOG_MAX_MB=1 a file below the limit is appended in place', async () => {
    const dir = freshDir();
    const before = filler(1000);
    writeFileSync(join(dir, 'shadow.jsonl'), before);
    await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, envFor(dir, { OMC_JEV_LOG_MAX_MB: '1' }), okFetch);
    expect(readdirSync(dir)).toEqual(['shadow.jsonl']);
    expect(readFileSync(join(dir, 'shadow.jsonl'), 'utf8').startsWith(before)).toBe(true);
  });

  it('a failed rename is ignored and the line is still appended', async () => {
    const dir = freshDir();
    const before = filler(MIB + 1);
    writeFileSync(join(dir, 'shadow.jsonl'), before);
    fsControl.failRename = true;
    try {
      await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, envFor(dir, { OMC_JEV_LOG_MAX_MB: '1' }), okFetch);
    } finally {
      fsControl.failRename = false;
    }
    expect(readdirSync(dir)).toEqual(['shadow.jsonl']);
    const after = readFileSync(join(dir, 'shadow.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.slice(before.length))).toMatchObject({ point: 'model-routing', mode: 'shadow' });
  });

  it('rotates degraded lines too', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'shadow.jsonl'), filler(MIB + 1));
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, envFor(dir, { OMC_JEV_LOG_MAX_MB: '1' }), failing);
    expect(result.mode).toBe('degraded');
    expect(readdirSync(dir).filter((name) => ROTATED.test(name))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim())).toMatchObject({ mode: 'degraded', jev: null });
  });
});

describe('resolver child process', () => {
  it('reads OMC_JEV_LOG_MAX_MB from the environment the hook passes on', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answers: { route: { type: 'choice', choice: 'opus', confidence: 0.9 } } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    afterHooks.push(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const dir = freshDir();
    const before = filler(MIB + 1);
    writeFileSync(join(dir, 'shadow.jsonl'), before);
    const requestFile = join(dir, 'request.json');
    writeFileSync(requestFile, JSON.stringify({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, heuristic: 'sonnet' }));

    const result = await new Promise((resolve, reject) => {
      execFile(NODE, [RESOLVE_SCRIPT, '--request-file', requestFile], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing:active', OMC_JEV_ENDPOINT: 'http://127.0.0.1:' + port, OMC_JEV_LOG_DIR: dir, OMC_JEV_LOG_MAX_MB: '1' },
      }, (error, stdout) => { if (error) reject(error); else resolve(JSON.parse(stdout)); });
    });

    expect(result).toMatchObject({ mode: 'active', answer: { choice: 'opus' } });
    const rotated = readdirSync(dir).filter((name) => ROTATED.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(dir, rotated[0]), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('jev-eval --include-rotated', () => {
  function line(point) {
    return JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', point, mode: 'shadow', state: null, heuristic: 'a', jev: { type: 'choice', choice: 'a' }, durationMs: 1 }) + '\n';
  }

  function logDir() {
    const dir = freshDir();
    writeFileSync(join(dir, 'shadow-20261102-000000-7.jsonl'), line('intent'));
    writeFileSync(join(dir, 'shadow-20261101-000000-123.jsonl'), line('model-routing') + line('model-routing'));
    writeFileSync(join(dir, 'shadow.jsonl'), line('task-size'));
    // Not rotated files of shadow.jsonl: never read.
    writeFileSync(join(dir, 'shadow-notes.jsonl'), line('skill-trigger'));
    writeFileSync(join(dir, 'other-20261101-000000-1.jsonl'), line('skill-trigger'));
    return dir;
  }

  function runEval(args) {
    return execFileSync(NODE, [EVAL_SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }

  it('lists only the rotated files of the log, oldest first', () => {
    const dir = logDir();
    expect(rotatedLogPaths(join(dir, 'shadow.jsonl'))).toEqual([
      join(dir, 'shadow-20261101-000000-123.jsonl'),
      join(dir, 'shadow-20261102-000000-7.jsonl'),
    ]);
    expect(rotatedLogPaths(join(dir, 'missing', 'shadow.jsonl'))).toEqual([]);
  });

  it('without the flag reads only the live log, as before', () => {
    const dir = logDir();
    const report = JSON.parse(runEval([join(dir, 'shadow.jsonl'), '--json']));
    expect(report.totalLines).toBe(1);
    expect(report.points.map((stats) => stats.point)).toEqual(['task-size']);
    expect(report).not.toHaveProperty('logFiles');
  });

  it('with the flag reads the rotated files first, then the live log', () => {
    const dir = logDir();
    const report = JSON.parse(runEval([join(dir, 'shadow.jsonl'), '--json', '--include-rotated']));
    expect(report.totalLines).toBe(4);
    expect(report.malformed).toBe(0);
    expect(report.logFiles).toEqual([
      join(dir, 'shadow-20261101-000000-123.jsonl'),
      join(dir, 'shadow-20261102-000000-7.jsonl'),
      join(dir, 'shadow.jsonl'),
    ]);
    expect(Object.fromEntries(report.points.map((stats) => [stats.point, stats.requests]))).toEqual({ intent: 1, 'model-routing': 2, 'task-size': 1 });
    expect(runEval([join(dir, 'shadow.jsonl'), '--include-rotated'])).toContain('files: 3 (rotated logs included, oldest first)');
  });

  it('with the flag evaluates rotated files when the live log is missing', () => {
    const dir = logDir();
    rmSync(join(dir, 'shadow.jsonl'));
    expect(existsSync(join(dir, 'shadow.jsonl'))).toBe(false);
    const report = JSON.parse(runEval([join(dir, 'shadow.jsonl'), '--json', '--include-rotated']));
    expect(report.totalLines).toBe(3);
    expect(report.logFiles).toHaveLength(2);
  });

  it('a rotated file written by the resolver is picked up', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'shadow.jsonl'), filler(MIB + 1));
    await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, envFor(dir, { OMC_JEV_LOG_MAX_MB: '1' }), okFetch);
    const files = rotatedLogPaths(join(dir, 'shadow.jsonl'));
    expect(files).toHaveLength(1);
    expect(statSync(files[0]).size).toBeGreaterThan(MIB);
  });
});

describe('overrides.jsonl of the model-routing use marker', () => {
  const OVERRIDES_ROTATED = /^overrides-\d{8}-\d{6}-\d+\.jsonl$/;

  /** One Task call whose prompt starts with a marker that settles model and effort, so Jev is not asked. */
  function runMarkerHook(dir, extraEnv) {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: '',
      DISABLE_OMC: '',
      OMC_SKIP_HOOKS: '',
      OMC_STATE_DIR: '',
      OMC_JEV_MODEL_ROUTING_MARKER: '1',
      OMC_JEV_LOG_DIR: join(dir, 'log'),
      NODE_ENV: 'test',
      ...extraEnv,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined || /^(TYPESAFE_|OMC_JEV$)/.test(key)) delete env[key];
    const input = {
      cwd: dir,
      session_id: 'session-1',
      tool_use_id: 'toolu_1',
      tool_name: 'Task',
      tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'Fix', prompt: 'use sonnet low\n\nFix the regression.', model: 'haiku' },
    };
    execFileSync(NODE, [join(root, 'scripts', 'pre-tool-enforcer.mjs')], { cwd: dir, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
  }

  function prepared() {
    const dir = freshDir();
    mkdirSync(join(dir, 'log'), { recursive: true });
    writeFileSync(join(dir, 'log', 'overrides.jsonl'), filler(MIB + 1));
    return dir;
  }

  it('is rotated before a row is appended when OMC_JEV_LOG_MAX_MB is set', () => {
    const dir = prepared();
    runMarkerHook(dir, { OMC_JEV_LOG_MAX_MB: '1' });
    const files = readdirSync(join(dir, 'log'));
    expect(files.filter((name) => OVERRIDES_ROTATED.test(name))).toHaveLength(1);
    const rows = readFileSync(join(dir, 'log', 'overrides.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'model-routing', override: 'both' });
  });

  it('keeps growing without OMC_JEV_LOG_MAX_MB, as on dev', () => {
    const dir = prepared();
    runMarkerHook(dir, {});
    expect(readdirSync(join(dir, 'log'))).toEqual(['overrides.jsonl']);
    expect(statSync(join(dir, 'log', 'overrides.jsonl')).size).toBeGreaterThan(MIB);
  });
});
