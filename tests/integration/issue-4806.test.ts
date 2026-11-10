/**
 * Reproduction test for issue #4806: Plugin hook script path
 * - jev-eval expects primitive heuristics but jev-resolve writes objects/arrays
 * - This prevents evidence-based promotion from shadow to active for plugin installs
 *
 * The issue: `node scripts/jev-eval.mjs` reports `comparable: 0` when heuristic
 * values are objects/arrays rather than primitives (choice, noul, score types).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORD_PRIORITY } from '../../src/hooks/keyword-detector/index.js';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const JEV_RESOLVE_SCRIPT = join(root, 'scripts', 'jev-resolve.mjs');
const JEV_EVAL_SCRIPT = join(root, 'scripts', 'jev-eval.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'issue-4806-'));
const afterHooks: Array<() => void | Promise<void>> = [];

function onExit(fn: () => void | Promise<void>) {
  afterHooks.push(fn);
}

afterAll(async () => {
  for (const fn of afterHooks.reverse()) {
    await fn();
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('issue #4806: plugin hook heuristic format', () => {
  it('jev-resolve writes heuristics as objects (task-size point)', async () => {
    // Set up a mock Jev endpoint that returns a valid response
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Respond with a choice answer for task-size
      res.end(JSON.stringify({
        answers: {
          'task-size': {
            type: 'choice',
            choice: 'medium',
            confidence: 0.85,
          },
        },
      }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    onExit(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const port = (server.address() as any).port;

    // Call jev-resolve with a task-size heuristic (object)
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        NODE,
        [JEV_RESOLVE_SCRIPT],
        {
          env: {
            ...process.env,
            TYPESAFE_API_KEY: 'test-key',
            OMC_JEV: 'task-size:shadow',
            OMC_JEV_ENDPOINT: `http://127.0.0.1:${port}`,
            OMC_JEV_LOG_DIR: tmp,
          },
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(JSON.parse(stdout));
        }
      );

      // Send a request with a task-size heuristic (object with size field)
      const request = {
        point: 'task-size',
        state: { prompt: 'test', source: 'user-prompt-submit' },
        questions: {
          'task-size': {
            type: 'choice',
            criteria: {
              small: 'task is small',
              medium: 'task is medium',
              large: 'task is large',
            },
          },
        },
        heuristic: {
          size: 'small',
          reason: 'heuristic',
          wordCount: 10,
          hasEscapeHatch: false,
        },
      };
      child.stdin!.write(JSON.stringify(request));
      child.stdin!.end();
    });

    // Verify the shadow log was written
    const logLines = readFileSync(join(tmp, 'shadow.jsonl'), 'utf8').trim().split('\n');
    expect(logLines.length).toBeGreaterThan(0);

    const entry = JSON.parse(logLines[logLines.length - 1]!);
    expect(entry.point).toBe('task-size');
    expect(entry.mode).toBe('shadow');
    // An object is not a valid choice answer, so it is logged as non-comparable.
    expect(entry.heuristic).toBeNull();
    // The jev answer should be the choice object
    expect(entry.jev).toEqual({ type: 'choice', choice: 'medium', confidence: 0.85 });
  });

  it('jev-eval cannot compare object heuristics (comparable: 0)', () => {
    // Create a shadow log with object heuristics (current behavior)
    const shadowLog = [
      {
        ts: '2026-11-02T11:00:00.000Z',
        point: 'task-size',
        mode: 'shadow',
        state: { prompt: 'test' },
        heuristic: { size: 'small', reason: 'heuristic', wordCount: 10 },
        jev: { type: 'choice', choice: 'medium', confidence: 0.85 },
        durationMs: 100,
      },
      {
        ts: '2026-11-02T11:00:01.000Z',
        point: 'model-routing',
        mode: 'shadow',
        state: { prompt: 'test' },
        heuristic: { model: 'sonnet', tier: 'standard' },
        jev: { type: 'choice', choice: 'opus', confidence: 0.9 },
        durationMs: 100,
      },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';

    const logPath = join(tmp, 'issue-4806-shadow.jsonl');
    writeFileSync(logPath, shadowLog);

    // Run jev-eval
    const output = execFileSync(NODE, [JEV_EVAL_SCRIPT, logPath, '--json'], {
      encoding: 'utf8',
    });

    const report = JSON.parse(output);

    // The issue: comparable is 0 because heuristics are objects, not primitives
    expect(report.points).toBeDefined();
    expect(report.points.length).toBeGreaterThan(0);
    // All points should have comparable: 0 (nonComparable should be > 0)
    for (const point of report.points) {
      expect(point.comparable).toBe(0);
      expect(point.nonComparable).toBeGreaterThan(0);
    }
  });

  it('skill-trigger points with ultragoal, ai-slop-cleaner, wiki heuristics are comparable (issue P2)', () => {
    // After the fix, skill-trigger heuristics for ultragoal, ai-slop-cleaner, and wiki
    // should be valid choices in SKILL_TRIGGER_QUESTIONS.criteria, making them comparable.
    // Before the fix, these would have comparable=0 and nonComparable=3.
    
    // Assert the production criteria actually contains these keywords (regression test for issue #4806)
    expect(KEYWORD_PRIORITY).toContain('ultragoal');
    expect(KEYWORD_PRIORITY).toContain('ai-slop-cleaner');
    expect(KEYWORD_PRIORITY).toContain('wiki');
    
    const shadowLog = [
      {
        ts: '2026-11-02T11:00:00.000Z',
        point: 'skill-trigger',
        mode: 'shadow',
        state: { prompt: 'test', source: 'user-prompt-submit' },
        heuristic: 'ultragoal',
        jev: { type: 'choice', choice: 'ralph', confidence: 0.8 },
        durationMs: 100,
      },
      {
        ts: '2026-11-02T11:00:01.000Z',
        point: 'skill-trigger',
        mode: 'shadow',
        state: { prompt: 'test', source: 'user-prompt-submit' },
        heuristic: 'ai-slop-cleaner',
        jev: { type: 'choice', choice: 'ralph', confidence: 0.75 },
        durationMs: 100,
      },
      {
        ts: '2026-11-02T11:00:02.000Z',
        point: 'skill-trigger',
        mode: 'shadow',
        state: { prompt: 'test', source: 'user-prompt-submit' },
        heuristic: 'wiki',
        jev: { type: 'choice', choice: 'cancel', confidence: 0.7 },
        durationMs: 100,
      },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';

    const logPath = join(tmp, 'issue-4806-skill-triggers.jsonl');
    writeFileSync(logPath, shadowLog);

    // Run jev-eval
    const output = execFileSync(NODE, [JEV_EVAL_SCRIPT, logPath, '--json'], {
      encoding: 'utf8',
    });

    const report = JSON.parse(output);

    // With the fix, these heuristics should be comparable (in the criteria)
    expect(report.points).toBeDefined();
    expect(report.points.length).toBeGreaterThan(0);
    
    // Find the skill-trigger point (entries are aggregated by point name)
    const skillTriggerPoint = report.points.find((p: any) => p.point === 'skill-trigger');
    expect(skillTriggerPoint).toBeDefined();
    
    // With the fix: all 3 entries should be comparable (not nonComparable)
    // comparable=3, nonComparable=0
    expect(skillTriggerPoint.comparable).toBe(3);
    expect(skillTriggerPoint.nonComparable).toBe(0);
  });
});
