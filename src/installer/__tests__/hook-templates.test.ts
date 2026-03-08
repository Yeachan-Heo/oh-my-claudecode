import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { KEYWORD_DETECTOR_SCRIPT_NODE, getHookScripts } from '../hooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..', '..');

const STALE_PIPELINE_SNIPPETS = [
  "matches.push({ name: 'pipeline', args: '' });",
  "'pipeline','ccg','ralplan'",
  "'pipeline']);",
  "'swarm', 'pipeline'], sessionId);",
];

function runKeywordHook(scriptPath: string, prompt: string) {
  return JSON.parse(
    execFileSync('node', [scriptPath], {
      cwd: packageRoot,
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
    }),
  ) as Record<string, unknown>;
}

describe('keyword-detector packaged artifacts', () => {
  it('does not ship stale pipeline keyword handling in installer templates', () => {
    const hookScripts = getHookScripts();
    const template = hookScripts['keyword-detector.mjs'];

    expect(template).toBe(KEYWORD_DETECTOR_SCRIPT_NODE);
    for (const snippet of STALE_PIPELINE_SNIPPETS) {
      expect(template).not.toContain(snippet);
    }
  });

  it('does not ship stale pipeline keyword handling in plugin scripts', () => {
    const pluginScript = readFileSync(join(packageRoot, 'scripts', 'keyword-detector.mjs'), 'utf-8');

    for (const snippet of STALE_PIPELINE_SNIPPETS) {
      expect(pluginScript).not.toContain(snippet);
    }
  });

  it('keeps installer template and plugin script aligned for supported compatibility keywords', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    for (const [prompt, expected] of [
      ['tdd implement password validation', '[TDD MODE ACTIVATED]'],
      ['deep-analyze the test failure', 'ANALYSIS MODE'],
      ['deep interview me about requirements', 'oh-my-claudecode:deep-interview'],
    ] as const) {
      const templateResult = JSON.stringify(runKeywordHook(templatePath, prompt));
      const pluginResult = JSON.stringify(runKeywordHook(pluginPath, prompt));
      expect(templateResult).toContain(expected);
      expect(pluginResult).toContain(expected);
    }
  });

  it('does not auto-trigger team mode from keyword-detector artifacts', () => {
    const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
    const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');

    const templateResult = runKeywordHook(templatePath, 'team 3 agents fix lint');
    const pluginResult = runKeywordHook(pluginPath, 'team 3 agents fix lint');

    expect(templateResult).toEqual({ continue: true, suppressOutput: true });
    expect(pluginResult).toEqual({ continue: true, suppressOutput: true });
  });
});
