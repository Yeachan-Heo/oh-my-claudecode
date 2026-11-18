import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { redactedPrefix, redactedPreview } from '../redact.js';

// A log preview is the start of a longer text. The text must be redacted before it is cut: a key that starts
// shortly before the cut would otherwise be logged as a fragment shorter than the minimum length of its shape.
describe('redactedPreview', () => {
  const SWITCH = 'OMC_REDACT_KEY_SHAPES';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[SWITCH];
    delete process.env[SWITCH];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
  });

  // What the callers did before: cut first, redact later (redactTokens on the log line).
  const cutFirst = (text: string, max: number, cut = text.length): string => {
    const shown = text.slice(0, cut);
    return `${shown.slice(0, max)}${shown.length > max ? '...' : ''}`;
  };

  const thresholds: Array<[prefix: string, min: number]> = [
    ['sk-', 8], ['sk_live_', 16], ['sk_test_', 16], ['rk_', 16], ['AIza', 20], ['gsk_', 20], ['xai-', 20], ['hf_', 20],
  ];

  describe('switch on', () => {
    beforeEach(() => {
      process.env[SWITCH] = '1';
    });

    // The key starts so that exactly one character less than its minimum length lies inside the first 50 characters.
    it.each(thresholds)('%s key that starts just before the cut: masked, not logged as a fragment', (prefix, min) => {
      const filler = 'x'.repeat(50 - prefix.length - (min - 1) - 1) + ' ';
      const text = `${filler}${prefix}${'a'.repeat(min + 25)}`;
      expect(text.slice(0, 50)).toBe(`${filler}${prefix}${'a'.repeat(min - 1)}`);
      expect(redactedPreview(text, 50)).toBe(`${filler}${prefix}****`);
    });

    it('a JWT whose signature is cut to 7 characters: masked', () => {
      const filler = 'x'.repeat(21) + ' ';
      const text = `${filler}eyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(30)}`;
      expect(text.slice(0, 50).endsWith('.ccccccc')).toBe(true);
      expect(redactedPreview(text, 50)).toBe(`${filler}eyJ***`);
    });

    it('a quoted value whose closing quote is cut off: masked', () => {
      const text = `${'x'.repeat(19)} PASSWORD="${'v'.repeat(60)}`;
      expect(redactedPreview(text, 50)).toBe(`${'x'.repeat(19)} PASSWORD="****`);
    });

    it('a Telegram token and an AWS key that the regex rules need in full', () => {
      const telegram = `${'x'.repeat(30)} 123456789:${'A'.repeat(40)}`;
      expect(redactedPreview(telegram, 50)).toBe(`${'x'.repeat(30)} 123456789:****`);
      const aws = `${'x'.repeat(30)} AKIA${'B'.repeat(16)} tail`;
      expect(redactedPreview(aws, 50)).toBe(`${'x'.repeat(30)} AKIA**** tail`);
    });

    it('cuts the masked text, so the preview can show more of the text than the unmasked cut would', () => {
      const text = `${'x'.repeat(10)} hf_${'a'.repeat(100)} and then more text`;
      expect(redactedPreview(text, 50)).toBe(`${'x'.repeat(10)} hf_**** and then more text`);
      expect(redactedPreview('y'.repeat(80), 50)).toBe(`${'y'.repeat(50)}...`);
    });

    it('types only `cut` characters: a longer text is cut after redaction at that length too', () => {
      const text = `${'x'.repeat(24)} hf_${'a'.repeat(40)}`;
      expect(redactedPreview(text, 50, 40)).toBe(`${'x'.repeat(24)} hf_****`);
      expect(redactedPreview(`${'z '.repeat(60)}`, 50, 30)).toBe('z '.repeat(15));
      expect(redactedPreview('z'.repeat(60), 50, 55)).toBe(`${'z'.repeat(50)}...`);
    });
  });

  describe.each([undefined, '', '0', 'true'])('switch off (%s): the text is cut as before', (value) => {
    beforeEach(() => {
      if (value === undefined) delete process.env[SWITCH];
      else process.env[SWITCH] = value;
    });

    it('returns exactly what cutting first returns, including the fragment of a key at the cut', () => {
      const texts = [
        `${'x'.repeat(28)} hf_${'a'.repeat(40)}`,
        `${'x'.repeat(30)} xoxb-${'1'.repeat(40)} tail`,
        `${'x'.repeat(30)} 123456789:${'A'.repeat(40)}`,
        `${'x'.repeat(19)} PASSWORD="${'v'.repeat(60)}`,
        `${'x'.repeat(21)} eyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(30)}`,
        'short text',
        'y'.repeat(50),
        'y'.repeat(51),
        '',
      ];
      for (const text of texts) {
        for (const cut of [undefined, 0, 10, 40, 50, 51, 500]) {
          expect(redactedPreview(text, 50, cut)).toBe(cutFirst(text, 50, cut));
        }
      }
      expect(redactedPreview(texts[0], 50)).toBe(`${'x'.repeat(28)} hf_${'a'.repeat(18)}...`);
    });
  });
});

describe('redactedPrefix', () => {
  const SWITCH = 'OMC_REDACT_KEY_SHAPES';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[SWITCH];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
  });

  const text = `${'x'.repeat(277)} hf_${'a'.repeat(40)}`; // character 300 falls 19 characters into the key

  it('switch on: the text is redacted before it is cut', () => {
    process.env[SWITCH] = '1';
    expect(redactedPrefix(text, 300)).toBe(`${'x'.repeat(277)} hf_****`);
    expect(redactedPrefix(text, 10)).toBe('x'.repeat(10));
    expect(redactedPrefix('short', 300)).toBe('short');
  });

  it.each([undefined, '', '0', 'true'])('switch off (%s): the first characters, as they are', (value) => {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
    expect(redactedPrefix(text, 300)).toBe(text.slice(0, 300));
    expect(redactedPrefix(text, 300)).toBe(`${'x'.repeat(277)} hf_${'a'.repeat(19)}`);
  });

  describe('finish: a transformation that adds syntax runs on the redacted text, before the cut', () => {
    const doubleBackslashes = (value: string): string => value.replace(/\\/g, '\\\\');
    const quoted = 'PASSWORD="start\\"sensitive-suffix" tail';

    it('switch on: the text is redacted as written, then transformed, then cut', () => {
      process.env[SWITCH] = '1';
      expect(redactedPrefix(quoted, 300, doubleBackslashes)).toBe('PASSWORD="****" tail');
      expect(redactedPrefix(quoted, 12, doubleBackslashes)).toBe('PASSWORD="**');
      expect(redactedPrefix('a\\b', 300, doubleBackslashes)).toBe('a\\\\b'); // nothing to redact: only transformed
      // a cut after the transformation sees the longer text
      expect(redactedPrefix('a\\b', 3, doubleBackslashes)).toBe('a\\\\');
    });

    it.each([undefined, '', '0', 'true'])('switch off (%s): transformed and cut, not redacted', (value) => {
      if (value === undefined) delete process.env[SWITCH];
      else process.env[SWITCH] = value;
      expect(redactedPrefix(quoted, 300, doubleBackslashes)).toBe(doubleBackslashes(quoted));
      expect(redactedPrefix(quoted, 12, doubleBackslashes)).toBe(doubleBackslashes(quoted).slice(0, 12));
    });

    it('without finish nothing changes', () => {
      process.env[SWITCH] = '1';
      expect(redactedPrefix(quoted, 300)).toBe(redactedPrefix(quoted, 300, (value) => value));
      expect(redactedPreview(quoted, 12, quoted.length)).toBe(redactedPreview(quoted, 12, quoted.length, (value) => value));
    });

    it('redactedPreview passes finish on and cuts the transformed text', () => {
      process.env[SWITCH] = '1';
      expect(redactedPreview(quoted, 50, 500, doubleBackslashes)).toBe('PASSWORD="****" tail');
      expect(redactedPreview('a\\bcd', 4, 500, doubleBackslashes)).toBe('a\\\\b...');
    });
  });
});
