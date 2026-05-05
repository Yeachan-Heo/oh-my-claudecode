import { describe, it, expect } from 'vitest';
import { parseJsonc, stripJsoncComments } from '../jsonc.js';

describe('stripJsoncComments', () => {
  it('strips single-line comments', () => {
    const input = '{\n  "key": "value" // this is a comment\n}';
    const result = stripJsoncComments(input);
    expect(result).toContain('"key": "value"');
    expect(result).not.toContain('this is a comment');
  });

  it('strips multi-line comments', () => {
    const input = '{\n  /* comment */\n  "key": "value"\n}';
    const result = stripJsoncComments(input);
    expect(result).toContain('"key": "value"');
    expect(result).not.toContain('comment');
  });

  it('preserves strings containing comment-like content', () => {
    const input = '{"url": "http://example.com"}';
    const result = stripJsoncComments(input);
    expect(result).toContain('http://example.com');
  });

  it('preserves strings with // inside quotes', () => {
    const input = '{"path": "C://Users//test"}';
    const result = stripJsoncComments(input);
    expect(result).toContain('C://Users//test');
  });

  it('handles escaped quotes in strings', () => {
    const input = '{"msg": "say \\"hello\\""}';
    const result = stripJsoncComments(input);
    expect(result).toBe(input);
  });

  it('handles empty input', () => {
    expect(stripJsoncComments('')).toBe('');
  });

  it('handles input with no comments', () => {
    const input = '{"key": "value"}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('handles multiple single-line comments', () => {
    const input = '{\n  // first\n  "a": 1,\n  // second\n  "b": 2\n}';
    const result = stripJsoncComments(input);
    expect(result).not.toContain('first');
    expect(result).not.toContain('second');
    expect(result).toContain('"a": 1');
    expect(result).toContain('"b": 2');
  });

  it('handles multi-line comment spanning lines', () => {
    const input = '{\n  /*\n   * block\n   * comment\n   */\n  "key": 1\n}';
    const result = stripJsoncComments(input);
    expect(result).not.toContain('block');
    expect(result).toContain('"key": 1');
  });

  it('handles comment at end of file without newline', () => {
    const input = '{"key": 1} // trailing';
    const result = stripJsoncComments(input);
    expect(result).toContain('"key": 1');
    expect(result).not.toContain('trailing');
  });
});

describe('parseJsonc', () => {
  it('parses valid JSON', () => {
    expect(parseJsonc('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('parses JSONC with single-line comments', () => {
    const input = '{\n  // comment\n  "key": "value"\n}';
    expect(parseJsonc(input)).toEqual({ key: 'value' });
  });

  it('parses JSONC with multi-line comments', () => {
    const input = '{\n  /* comment */\n  "key": 42\n}';
    expect(parseJsonc(input)).toEqual({ key: 42 });
  });

  it('parses JSONC with trailing commas stripped by comments', () => {
    const input = '{\n  "a": 1,\n  "b": 2 // no trailing comma issue\n}';
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  it('throws on invalid JSON after stripping comments', () => {
    expect(() => parseJsonc('{invalid}')).toThrow();
  });

  it('parses arrays', () => {
    expect(parseJsonc('[1, 2, 3] // array')).toEqual([1, 2, 3]);
  });

  it('parses nested objects with comments', () => {
    const input = '{\n  "outer": {\n    // inner comment\n    "inner": true\n  }\n}';
    expect(parseJsonc(input)).toEqual({ outer: { inner: true } });
  });
});
