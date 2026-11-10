/**
 * `jev-eval --include-rotated` while a hook rotates the log under it.
 *
 * A rotation that happens during the read renames the live log to a file that
 * is in neither the listing the read started from nor the live file read last.
 * The evaluator reads again from a fresh listing until a pass sees no new
 * rotated file, one file in memory at a time. These tests make the rotation
 * happen during the read: a preload (`node --require`) wraps `fs.readFileSync`
 * in the evaluator process and, right after the Nth read of a named file,
 * renames the live log and starts a new one. The production script is run
 * unchanged.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVAL_SCRIPT = join(ROOT, 'scripts', 'jev-eval.mjs');

interface RotationStep {
  /** Path of the file whose read triggers the rotation. */
  afterRead: string;
  /** The rotation happens after this read of that file (1 = the first pass). */
  nth: number;
  live: string;
  rotatedTo: string;
  /** Content of the new live log. */
  fresh: string;
}

const PRELOAD = `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const steps = JSON.parse(process.env.JEV_TEST_ROTATIONS);
const reads = new Map();
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const result = readFileSync.call(this, file, ...args);
  const key = String(file);
  const count = (reads.get(key) || 0) + 1;
  reads.set(key, count);
  for (const step of steps) {
    if (step.afterRead === key && step.nth === count) {
      fs.renameSync(step.live, step.rotatedTo);
      fs.writeFileSync(step.live, step.fresh);
    }
  }
  return result;
};
syncBuiltinESMExports();
`;

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A directory the OS still holds is left for the OS.
    }
  }
});

const row = (point: string, count = 1) => `{"point":"${point}","mode":"shadow"}\n`.repeat(count);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-eval-rotation-'));
  cleanups.push(dir);
  return {
    dir,
    live: join(dir, 'shadow.jsonl'),
    rotated: (stamp: string) => join(dir, `shadow-20261110-${stamp}.jsonl`),
  };
}

function evaluate(dir: string, live: string, steps: RotationStep[]) {
  const preload = join(dir, 'preload.cjs');
  writeFileSync(preload, PRELOAD);
  const child = spawnSync(process.execPath, ['--require', preload, EVAL_SCRIPT, live, '--include-rotated', '--json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout: 60_000,
    env: { ...process.env, JEV_TEST_ROTATIONS: JSON.stringify(steps) },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const report = JSON.parse(child.stdout);
  const requests = Object.fromEntries(report.points.map((stats: { point: string; requests: number }) => [stats.point, stats.requests]));
  return { report, requests, files: report.logFiles.map((file: string) => basename(file)), stderr: child.stderr };
}

describe('jev-eval --include-rotated: the log rotates during the read', () => {
  it('reads the generation that was renamed after the listing, once, oldest first', () => {
    const { dir, live, rotated } = setup();
    const first = rotated('070000-11');
    const second = rotated('074000-22');
    writeFileSync(first, row('intent', 2));
    writeFileSync(live, row('model-routing', 3));

    // The hook rotates after the evaluator has read the first rotated file and before it reads the live log.
    const { report, requests, files, stderr } = evaluate(dir, live, [
      { afterRead: first, nth: 1, live, rotatedTo: second, fresh: row('task-size') },
    ]);

    expect(requests).toEqual({ intent: 2, 'model-routing': 3, 'task-size': 1 });
    expect(stderr).toBe('');
    expect(report.totalLines).toBe(6);
    expect(report.malformed).toBe(0);
    expect(files).toEqual([basename(first), basename(second), 'shadow.jsonl']);
  });

  it('streams a generation of 150000 lines that rotates during the read', () => {
    const { dir, live, rotated } = setup();
    const first = rotated('070000-11');
    const second = rotated('074000-22');
    writeFileSync(first, row('intent'));
    // 150000 lines in one file: spreading them into a push() call overflows the stack.
    writeFileSync(live, row('model-routing', 150_000));

    const { report, requests, files } = evaluate(dir, live, [
      { afterRead: first, nth: 1, live, rotatedTo: second, fresh: row('task-size') },
    ]);

    expect(requests).toEqual({ intent: 1, 'model-routing': 150_000, 'task-size': 1 });
    expect(report.totalLines).toBe(150_002);
    expect(files).toEqual([basename(first), basename(second), 'shadow.jsonl']);
  });

  it('reads again when a second rotation happens during the rescan', () => {
    const { dir, live, rotated } = setup();
    const first = rotated('070000-11');
    const second = rotated('074000-22');
    const third = rotated('075000-33');
    writeFileSync(first, row('intent'));
    writeFileSync(live, row('model-routing', 2));

    const { report, requests, files } = evaluate(dir, live, [
      { afterRead: first, nth: 1, live, rotatedTo: second, fresh: row('task-size', 3) },
      { afterRead: first, nth: 2, live, rotatedTo: third, fresh: row('skill-trigger', 4) },
    ]);

    expect(requests).toEqual({ intent: 1, 'model-routing': 2, 'task-size': 3, 'skill-trigger': 4 });
    expect(report.totalLines).toBe(10);
    expect(files).toEqual([basename(first), basename(second), basename(third), 'shadow.jsonl']);
  });

  it('stops after three passes when the log keeps rotating', () => {
    const { dir, live, rotated } = setup();
    const first = rotated('070000-11');
    writeFileSync(first, row('intent'));
    writeFileSync(live, row('model-routing'));

    // One rotation in each of the first three passes.
    const steps: RotationStep[] = [1, 2, 3].map((nth) => ({
      afterRead: first,
      nth,
      live,
      rotatedTo: rotated(`07${nth}000-${nth}${nth}`),
      fresh: row('task-size'),
    }));
    const { report, files, stderr } = evaluate(dir, live, steps);

    // The third pass listed the first two rotations; the one it caused is left for the next run.
    expect(files).toEqual([basename(first), 'shadow-20261110-071000-11.jsonl', 'shadow-20261110-072000-22.jsonl', 'shadow.jsonl']);
    expect(report.malformed).toBe(0);
    expect(stderr).toContain('rotated again during the last pass');
  });
});
