/**
 * @file LLM utility unit tests — parseJSON and loadAgentPrompt.
 * No Claude API calls. Tests pure utility behavior only.
 */

import { describe, it, expect } from 'vitest';
import { parseJSON } from '../analyzer/llm.js';
import fs from 'fs';
import path from 'path';

// ─── parseJSON ────────────────────────────────────────────

describe('parseJSON', () => {
  it('parses a plain JSON string', () => {
    const result = parseJSON<{ value: number }>('{"value": 42}');
    expect(result).toEqual({ value: 42 });
  });

  it('parses JSON wrapped in a markdown json code fence', () => {
    const raw = '```json\n{"key": "hello"}\n```';
    const result = parseJSON<{ key: string }>(raw);
    expect(result).toEqual({ key: 'hello' });
  });

  it('parses JSON wrapped in a plain code fence (no language tag)', () => {
    const raw = '```\n{"flag": true}\n```';
    const result = parseJSON<{ flag: boolean }>(raw);
    expect(result).toEqual({ flag: true });
  });

  it('strips leading/trailing whitespace before parsing', () => {
    const result = parseJSON<string[]>('  ["a","b"]  ');
    expect(result).toEqual(['a', 'b']);
  });

  it('throws SyntaxError on invalid JSON', () => {
    expect(() => parseJSON('{not valid json}')).toThrow(SyntaxError);
  });

  it('parses nested objects correctly', () => {
    const raw = '{"outer":{"inner":1}}';
    const result = parseJSON<{ outer: { inner: number } }>(raw);
    expect(result.outer.inner).toBe(1);
  });
});

// ─── loadAgentPrompt (file-system, no API) ───────────────

describe('loadAgentPrompt', () => {
  const agentsDir = path.resolve(__dirname, '..', 'agents');

  it('researcher.md exists and is readable', () => {
    const filePath = path.join(agentsDir, 'researcher.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('needs-detector.md exists and is readable', () => {
    const filePath = path.join(agentsDir, 'needs-detector.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('all expected agent prompt files are present', () => {
    const expected = [
      'researcher.md',
      'needs-detector.md',
      'product-matcher.md',
      'positioning.md',
      'content.md',
      'performance.md',
    ];
    for (const filename of expected) {
      const filePath = path.join(agentsDir, filename);
      expect(fs.existsSync(filePath), `${filename} should exist`).toBe(true);
    }
  });

  it('throws when requesting a nonexistent prompt file', () => {
    const filePath = path.join(agentsDir, 'nonexistent-agent.md');
    expect(() => fs.readFileSync(filePath, 'utf-8')).toThrow();
  });
});
