import { describe, it, expect } from 'vitest';
import { parseJsonc, stripJsoncComments } from '../jsonc.js';

describe('parseJsonc - trailing commas', () => {
  it('tolerates a trailing comma in an object', () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 });
  });

  it('tolerates a trailing comma in an array', () => {
    expect(parseJsonc('[1,2,]')).toEqual([1, 2]);
  });

  it('tolerates trailing commas in nested structures', () => {
    const input = `{
      "list": [1, 2, 3,],
      "obj": { "x": true, },
    }`;
    expect(parseJsonc(input)).toEqual({
      list: [1, 2, 3],
      obj: { x: true },
    });
  });

  it('tolerates a trailing comma followed by whitespace and newlines', () => {
    const input = '{\n  "a": 1,\n  "b": 2,\n}';
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });
});

describe('parseJsonc - string preservation', () => {
  it('preserves a comma inside a string value', () => {
    expect(parseJsonc('{"a":"1,"}')).toEqual({ a: '1,' });
  });

  it('does not strip a comma-then-brace sequence inside a string', () => {
    // The literal text "x,}" must survive intact as a string value.
    expect(parseJsonc('{"a":"x,}"}')).toEqual({ a: 'x,}' });
  });

  it('preserves a trailing-comma-like pattern inside a string', () => {
    expect(parseJsonc('{"a":"[1,2,]"}')).toEqual({ a: '[1,2,]' });
  });
});

describe('parseJsonc - comment stripping still works', () => {
  it('strips single-line comments', () => {
    const input = `{
      // this is a comment
      "a": 1
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it('strips multi-line comments', () => {
    const input = `{
      /* block
         comment */
      "a": 1
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  it('does not strip // inside a string value', () => {
    expect(parseJsonc('{"url":"http://example.com"}')).toEqual({
      url: 'http://example.com',
    });
  });

  it('handles comments and trailing commas together', () => {
    const input = `{
      "a": 1, // trailing comment
      "b": 2, /* another */
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });
});

describe('stripJsoncComments - trailing comma removal', () => {
  it('removes a trailing comma before a closing brace', () => {
    expect(stripJsoncComments('{"a":1,}')).toBe('{"a":1}');
  });

  it('removes a trailing comma before a closing bracket', () => {
    expect(stripJsoncComments('[1,2,]')).toBe('[1,2]');
  });
});
