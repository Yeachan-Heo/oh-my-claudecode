import { describe, expect, it } from 'vitest';
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
});
