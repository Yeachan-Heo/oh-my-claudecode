import { describe, it, expect } from 'vitest';
import { parseJsonc, stripJsoncComments } from '../jsonc.js';

describe('stripJsoncComments', () => {
  it('returns plain JSON unchanged', () => {
    const input = '{"key": "value"}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('strips single-line comments', () => {
    const input = '{\n  // this is a comment\n  "key": "value"\n}';
    const result = stripJsoncComments(input);
    expect(result).not.toContain('//');
    expect(result).toContain('"key": "value"');
  });

  it('strips multi-line comments', () => {
    const input = '{\n  /* multi\n     line */\n  "key": "value"\n}';
    const result = stripJsoncComments(input);
    expect(result).not.toContain('/*');
    expect(result).not.toContain('*/');
    expect(result).toContain('"key": "value"');
  });

  it('preserves comment-like content inside strings', () => {
    const input = '{"url": "http://example.com"}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('preserves double-slash inside string values', () => {
    const input = '{"path": "a // b"}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('preserves block-comment-like content inside strings', () => {
    const input = '{"note": "/* not a comment */"}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{"msg": "say \\"hello\\""}';
    const result = stripJsoncComments(input);
    expect(result).toBe(input);
  });

  it('strips trailing single-line comment after value', () => {
    const input = '{"key": 42 // trailing comment\n}';
    const result = stripJsoncComments(input);
    expect(result).toContain('"key": 42 ');
    expect(result).not.toContain('trailing comment');
  });

  it('handles empty input', () => {
    expect(stripJsoncComments('')).toBe('');
  });

  it('handles input with only comments', () => {
    const result = stripJsoncComments('// just a comment');
    expect(result.trim()).toBe('');
  });
});

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses JSON with single-line comments', () => {
    const input = '{\n  // comment\n  "a": 1\n}';
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it('parses JSON with multi-line comments', () => {
    const input = '{\n  /* comment */\n  "a": 1\n}';
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it('parses JSON with trailing commas stripped via comment removal', () => {
    // This tests that comment stripping works before JSON.parse
    const input = '{\n  "a": 1\n  // "b": 2\n}';
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it('throws on invalid JSON after comment stripping', () => {
    expect(() => parseJsonc('{invalid}')).toThrow();
  });

  it('handles arrays with comments', () => {
    const input = '[\n  1, // first\n  2  // second\n]';
    expect(parseJsonc(input)).toEqual([1, 2]);
  });

  it('handles nested objects with comments', () => {
    const input = `{
      // top-level comment
      "config": {
        /* nested comment */
        "enabled": true
      }
    }`;
    expect(parseJsonc(input)).toEqual({ config: { enabled: true } });
  });
});
