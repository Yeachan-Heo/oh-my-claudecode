/* global performance */
/**
 * Tests of the opt-in mask of secrets written in prose (secretProseMask in scripts/lib/jev-state-mask.mjs,
 * OMC_JEV_MASK_PROSE=1) and of its use through maskJevState. Every value is invented.
 */

import { describe, expect, it } from 'vitest';

import { RUN_EXTENSION, WINDOW_MARGIN, maskJevState, secretProseMask } from '../../scripts/lib/jev-state-mask.mjs';

const ON = { OMC_JEV_MASK_PROSE: '1' };
const prose = secretProseMask(ON);

const SENTENCES = [
  ['Login admin, password Abc12345, verified.', 'Login admin, password ***, verified.'],
  ['The password for the panel is Zaq12wsx, it works.', 'The password for the panel is ***, it works.'],
  ['In the config file client_secret Xy9-pQ7_rT2 works.', 'In the config file client_secret *** works.'],
  ['Phone PIN 482913 entered.', 'Phone PIN *** entered.'],
  ['The API key is sk9Xq2LmP7, saved.', 'The API key is ***, saved.'],
  ['token ghx7Kp2Qa9 is still valid', 'token *** is still valid'],
  ['Set the password to Abc12345 and retry', 'Set the password to *** and retry'],
  ['The passphrase was horse7battery', 'The passphrase was ***'],
  ['PASSCODE = 90210', 'PASSCODE = ***'],
  ['The secret: hunter2zz', 'The secret: ***'],
  // The end of a sentence stays.
  ['Phone PIN 482913.', 'Phone PIN ***.'],
  ['The PIN of the card is 4829.', 'The PIN of the card is ***.'],
  ['The password is 12345678!', 'The password is ***!'],
  ['password Abc12345.', 'password ***.'],
  // Digits alone on a line or in a tab field of their own, after any secret word.
  ['token\n482913', 'token\n***'],
  ['token\t482913\tok', 'token\t***\tok'],
  // A secret word among the words that follow an earlier one is read as a secret word too.
  ['secret password Abc12345', 'secret password ***'],
  ['Pass the token password is Abc12345', 'Pass the token password is ***'],
  ['token a1-token Abc12345', 'token *** ***'],
  // A value in escaped quotes.
  ['print("token abc12345") ok', 'print("token ***") ok'],
  ['password \\"Abc12345\\" set', 'password \\"***\\" set'],
];

const PLAIN = [
  'Token limit exceeded, retrying in a minute.',
  'The password is too short, 12 characters required.',
  'Changed the PIN codes on three phones.',
  'Tokens used: 1200 of 5000.',
  'Passwords were changed yesterday.',
  'The password field is required.',
  'Tests: 37/37 green, 60 s.',
  'File src/app/main.ts has 120 lines, commit 8dc2d53.',
  'The API key is set in an environment variable.',
  'secret_held 0, secret_skipped 3',
  'Token limit 2024.',
  'Changed PIN 12.',
  'max_tokens: 4096',
  'token count: 128000',
  'token 4096',
  'password: v2',
  // A link word counts only as a whole word: "analysis" does not end in a link.
  'secret analysis abc1',
  // Four words between the secret word and the value are too many.
  'token that we got from them is abc12345',
  'mytoken abc12345',
];

describe('secretProseMask: the switch', () => {
  it.each([[{}], [{ OMC_JEV_MASK_PROSE: '' }], [{ OMC_JEV_MASK_PROSE: '0' }], [{ OMC_JEV_MASK_PROSE: 'true' }], [{ OMC_JEV_MASK_PROSE_WORDS: 'token' }]])(
    'is off for %j',
    (env) => {
      expect(secretProseMask(env)).toBeUndefined();
    },
  );

  it('is on for 1, with or without spaces around it', () => {
    expect(secretProseMask({ OMC_JEV_MASK_PROSE: ' 1 ' })('password Abc12345')).toBe('password ***');
  });

  it('without it maskJevState leaves every sentence as it was', () => {
    const state = { notes: SENTENCES.map(([text]) => text).filter((text) => !/[:=]/.test(text)) };
    expect(maskJevState(state, { prose: secretProseMask({}) })).toEqual(state);
    expect(maskJevState(state)).toEqual(state);
  });
});

describe('secretProseMask: what it masks', () => {
  it.each(SENTENCES)('%j', (text, masked) => {
    expect(prose(text)).toBe(masked);
  });

  it.each(PLAIN)('leaves %j as it is', (text) => {
    expect(prose(text)).toBe(text);
    expect(maskJevState({ note: text }, { prose })).toEqual(maskJevState({ note: text }));
  });

  it('runs on every string and key of a state, which stays valid JSON', () => {
    const state = { 'phone PIN 482913': 'ok', a: { b: ['x "password Abc12345" y', 'Phone PIN 482913.', 'plain'] }, c: 'The password is Zaq12wsx\\"', port: 5433 };
    const masked = maskJevState(state, { prose });
    expect(masked).toEqual({ 'phone PIN ***': 'ok', a: { b: ['x "password ***" y', 'Phone PIN ***.', 'plain'] }, c: 'The password is ***\\"', port: 5433 });
    expect(JSON.parse(JSON.stringify(masked))).toEqual(masked);
  });

  it('hides the value in every plain shape of a corpus and keeps the state valid JSON', () => {
    const words = ['password', 'Passwd', 'token', 'PIN', 'secret', 'api_key', 'API key', 'client-secret', 'passphrase'];
    const separators = [' ', ': ', '=', ' to ', ' is ', ' was ', '\n', '\t', ' = '];
    const values = ['Abc12345', 'Zaq12wsx9', '482913', 'ab12cd34ef'];
    const wraps = [(t) => t, (t) => `"${t}"`, (t) => `'${t}'`, (t) => `run "${t}"`, (t) => `${t}.`, (t) => `{${t}}`, (t) => `[${t}]`];
    const leaks = [];
    let cases = 0;
    for (const word of words) for (const separator of separators) for (const value of values) for (const wrap of wraps) {
      const state = { a: [wrap(`${word}${separator}${value}`)] };
      const sent = JSON.stringify(maskJevState(state, { prose }));
      cases += 1;
      JSON.parse(sent);
      // Digits alone count after a password or PIN word, or on a line or tab field of their own.
      const digitsKept = /^\d+$/.test(value) && !/^(?:password|passwd|PIN)$/i.test(word) && !/[\n\t]/.test(separator);
      if (!digitsKept && sent.includes(value)) leaks.push(sent);
    }
    expect({ cases, leaks: leaks.slice(0, 5) }).toEqual({ cases: 2268, leaks: [] });
  });
});

describe('secretProseMask: with the other rules and the window', () => {
  it('runs after the other rules, so that a known key shape keeps its prefix', () => {
    const cmd = 'token sk-ant-api03-Zz9yY8xX7wW6vV5uU4tT3 ok';
    expect(maskJevState({ cmd }, { prose })).toEqual({ cmd: 'token sk-ant-*** ok' });
  });

  // A long token before the value is masked to "***", which brings the edge of the window into what is sent.
  it.each([['Ab!c12345'], ['Abcdefgh!1'], ['Ab:c@d#12345']])('sends no part of the value %j that the window would cut', (value) => {
    const maxChars = 100;
    let masked = 0;
    for (let fill = WINDOW_MARGIN; fill <= WINDOW_MARGIN + maxChars; fill++) {
      const cmd = `k ${'A1'.repeat(fill).slice(0, fill)} password ${value} tail`;
      const sent = maskJevState({ cmd }, { maxChars, prose }).cmd.slice(0, maxChars);
      expect(sent, String(fill)).not.toContain('Ab');
      if (sent.includes('password ***')) masked += 1;
    }
    expect(masked).toBeGreaterThan(0);
  });

  // No secret word here: the two cases show what the cut itself keeps of a run that "!" splits into short tokens.
  const before = `k ${'A1'.repeat(280)} see `;

  it('keeps a run of value characters that ends soon after the cut', () => {
    const run = `ref!${'c1!'.repeat(30)}end`;
    expect(maskJevState({ cmd: `${before}${run} tail` }, { maxChars: 100, prose }).cmd).toBe(`k *** see ${run}`);
  });

  it('replaces the whole of a run of value characters that goes on too far beyond the cut', () => {
    const cmd = `${before}ref!${'c1!'.repeat(RUN_EXTENSION)}`;
    expect(maskJevState({ cmd }, { maxChars: 100, prose }).cmd).toBe('k *** see ***');
  });
});

// The words of the test are invented and not ASCII, as a configured language would be.
const WORD = 'gl\u00fcrb';
const LINK = 'v\u00e6r';

describe('secretProseMask: words of another language', () => {
  const added = secretProseMask({ ...ON, OMC_JEV_MASK_PROSE_WORDS: ` ${WORD} , zonk key,`, OMC_JEV_MASK_PROSE_LINKS: `${LINK}` });

  it('masks a value after an added word, in any letter case', () => {
    expect(added(`${WORD} Zaq12wsx`)).toBe(`${WORD} ***`);
    expect(added(`GL\u00dcRB: Zaq12wsx`)).toBe('GL\u00dcRB: ***');
    expect(added(`The zonk  key sk9Xq2LmP7 ok`)).toBe('The zonk  key *** ok');
  });

  it('reads words between only with a built-in or added link word right before the value', () => {
    expect(added(`${WORD} zib florp ${LINK} Zaq12wsx.`)).toBe(`${WORD} zib florp ${LINK} ***.`);
    expect(added(`${WORD} zib florp is Zaq12wsx`)).toBe(`${WORD} zib florp is ***`);
    expect(added(`${WORD} zib florp Zaq12wsx`)).toBe(`${WORD} zib florp Zaq12wsx`);
    expect(prose(`password zib florp ${LINK} Zaq12wsx`)).toBe(`password zib florp ${LINK} Zaq12wsx`);
  });

  it('takes digits alone after an added word', () => {
    expect(added(`${WORD} 482913`)).toBe(`${WORD} ***`);
  });

  it('knows the added word only as a whole word and only with the variable', () => {
    expect(added(`x${WORD} Zaq12wsx`)).toBe(`x${WORD} Zaq12wsx`);
    expect(added(`${WORD}\u00f6 Zaq12wsx`)).toBe(`${WORD}\u00f6 Zaq12wsx`);
    expect(prose(`${WORD} Zaq12wsx`)).toBe(`${WORD} Zaq12wsx`);
  });

  it('reads an added entry as text, not as an expression', () => {
    const dotted = secretProseMask({ ...ON, OMC_JEV_MASK_PROSE_WORDS: 'k.w+,(x' });
    expect(dotted('k.w+ Zaq12wsx and (x Zaq12wsx')).toBe('k.w+ *** and (x ***');
    expect(dotted('kaww Zaq12wsx')).toBe('kaww Zaq12wsx');
  });
});

describe('secretProseMask: time', () => {
  const added = secretProseMask({ ...ON, OMC_JEV_MASK_PROSE_WORDS: WORD, OMC_JEV_MASK_PROSE_LINKS: LINK });
  it.each([
    ['password '],
    ['token a '],
    ['password is '],
    ['pin '],
    ['password\n'],
    ['token aaaaaaaaaaaaaaa '],
    ['a'.repeat(100) + ' '],
    ['='.repeat(50)],
    ['token-1'],
    ['token-'],
    ['password' + ' '.repeat(40)],
    ['token \\\\\\\\\\\\\\\\'],
    ['pin 1111.'],
    [`${WORD} ${LINK} `],
  ])('grows linearly with a long run of %j', (piece) => {
    const text = piece.repeat(Math.ceil(400_000 / piece.length));
    const start = performance.now();
    added(text);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('reads a long value once, and a long run of dots inside it', () => {
    for (const text of [`password a1${'.'.repeat(400_000)}b`, `password a1${'b'.repeat(400_000)}`, `token 1-${'token-1'.repeat(60_000)}`]) {
      const start = performance.now();
      added(text);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});
