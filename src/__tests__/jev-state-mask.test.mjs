/**
 * scripts/lib/jev-state-mask.mjs: the mask every Jev point's state goes through before it is sent or logged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeCase, checkCase, seededRandom } from './jev-state-mask-cases.mjs';
import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { JevStateFieldOmittedError, JevStateMaskError, MAX_STATE_DEPTH, MAX_STATE_NODES, RUN_EXTENSION, SECRET_PATH, TOKEN_CHAR, WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const GHP = 'ghp_' + 'A'.repeat(36);
const AKIA = 'AKIA' + 'B'.repeat(16);

describe('maskJevState: secrets in strings', () => {
  it.each([
    ['a GitHub token', `deploy with ${GHP} now`, GHP],
    ['an AWS access key', `id ${AKIA}`, AKIA],
    ['a password flag', 'mysql --password hunter2zzQ', 'hunter2zzQ'],
    ['an assignment', 'export API_TOKEN=s3cr3tvalue1', 's3cr3tvalue1'],
  ])('masks %s', (_name, text, secret) => {
    const out = maskJevState({ prompt: text });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it.each(['cat ~/.ssh/id_ed25519', 'source /srv/app/.env', 'cat /root/.aws/credentials'])('omits the line that names %s', (line) => {
    const out = maskJevState({ prompt: `first\n${line}\nlast` });
    expect(out.prompt).toBe('first\n[line omitted: secret path]\nlast');
  });

  it('omits a private key block and leaves the other lines', () => {
    const out = maskJevState({ t: 'a\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\nb' });
    expect(out.t).not.toContain('MIIEvQIBADANBg');
    expect(out.t.startsWith('a\n')).toBe(true);
    expect(out.t.endsWith('\nb')).toBe(true);
  });

  it('leaves a plain string alone', () => {
    expect(maskJevState({ a: 'fix the build', b: ['x', 1, true, null] })).toEqual({ a: 'fix the build', b: ['x', 1, true, null] });
  });
});

describe('maskJevState: keys that name a secret', () => {
  it.each(['password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'api_key', 'apiKey', 'api-key', 'accessKey', 'access_key', 'privateKey', 'clientSecret', 'client-secret', 'authorization', 'Cookie', 'credentials', 'credential', 'accessToken', 'AWS_SECRET_ACCESS_KEY'])(
    'replaces the value under %s',
    (key) => {
      expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
      expect(maskJevState({ [key]: ['a', 'b'] })).toEqual({ [key]: '***' });
      expect(maskJevState({ [key]: { nested: 'x' } })).toEqual({ [key]: '***' });
      expect(maskJevState({ [key]: 123456 })).toEqual({ [key]: '***' });
    },
  );

  it('keeps booleans and null under such a key', () => {
    expect(maskJevState({ password: true, token: null })).toEqual({ password: true, token: null });
  });

  it('keeps token counters and unrelated keys', () => {
    const state = { totalTokens: 1234, input_tokens: 5, 'output-tokens': 6, passenger: 'x', keyboard: 'y', tokenizer: 'z' };
    expect(maskJevState(state)).toEqual(state);
  });

  it('masks the values that the maintainer used on #5064', () => {
    expect(maskJevState({ accessTokens: ['tok_hunter2zz'], refreshTokens: 'hunter2zz' })).toEqual({ accessTokens: '***', refreshTokens: '***' });
    expect(maskJevState({ refreshTokens: ['hunter2zz'], accessTokens: 'tok_hunter2zz' })).toEqual({ refreshTokens: '***', accessTokens: '***' });
  });

  it('keeps a number under a key that ends with tokens even when it names a secret word', () => {
    expect(maskJevState({ secret_tokens: 7 })).toEqual({ secret_tokens: 7 });
  });
});

describe('maskJevState: keys that are secret paths', () => {
  it('replaces the key with a marker, unique per key', () => {
    const out = maskJevState({ '/home/u/.ssh/id_ed25519': 'a', '/home/v/.ssh/id_rsa': 'b', ok: 'c' });
    expect(Object.keys(out)).toEqual(['[key omitted: path]', '[key omitted: path] #2', 'ok']);
    expect(Object.values(out)).toEqual(['a', 'b', 'c']);
  });
});

describe('maskJevState: JSON semantics', () => {
  it('does not change its input and returns a new value', () => {
    const state = { a: { password: 'x', list: [`t ${GHP}`] } };
    const copy = JSON.parse(JSON.stringify(state));
    const out = maskJevState(state);
    expect(state).toEqual(copy);
    expect(out).not.toBe(state);
    expect(out.a).not.toBe(state.a);
  });

  it('honors toJSON, drops functions, symbols and undefined in objects, nulls them in arrays', () => {
    const out = maskJevState({
      when: new Date(0),
      custom: { toJSON: () => ({ token: 'abc', n: 1 }) },
      f() {},
      s: Symbol('x'),
      u: undefined,
      list: [() => 1, undefined, Symbol('y'), NaN, 2],
    });
    expect(out).toEqual({ when: '1970-01-01T00:00:00.000Z', custom: { token: '***', n: 1 }, list: [null, null, null, null, 2] });
    expect(Object.keys(out)).toEqual(['when', 'custom', 'list']);
  });

  it('passes a primitive state through', () => {
    expect(maskJevState(undefined)).toBeUndefined();
    expect(maskJevState(`x ${GHP}`)).not.toContain(GHP);
    expect(maskJevState(null)).toBeNull();
  });

  it('keeps an own __proto__ key as data', () => {
    const state = JSON.parse('{"__proto__": {"a": 1}}');
    const out = maskJevState(state);
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('maskJevState: fail closed', () => {
  it('throws on a cycle', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => maskJevState({ a })).toThrow(JevStateMaskError);
  });

  it('allows the same object twice (not a cycle)', () => {
    const shared = { x: 1 };
    expect(maskJevState({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('throws beyond the depth limit and accepts the limit', () => {
    const nest = (n) => { let v = 'leaf'; for (let i = 0; i < n; i++) v = { v }; return v; };
    expect(() => maskJevState(nest(MAX_STATE_DEPTH + 1))).toThrow(JevStateMaskError);
    expect(() => maskJevState(nest(MAX_STATE_DEPTH))).not.toThrow();
  });

  it('throws beyond the node limit', () => {
    expect(() => maskJevState(new Array(MAX_STATE_NODES + 1).fill(1))).toThrow(JevStateMaskError);
    expect(() => maskJevState(new Array(MAX_STATE_NODES - 1).fill(1))).not.toThrow();
  });

  it('throws when toJSON throws, and on a BigInt', () => {
    expect(() => maskJevState({ x: { toJSON() { throw new Error('boom'); } } })).toThrow(JevStateMaskError);
    expect(() => maskJevState({ get x() { throw new Error('boom'); } })).toThrow(JevStateMaskError);
    expect(() => maskJevState({ x: 1n })).toThrow(JevStateMaskError);
  });
});

describe('maskJevState: more secret keys, counters, ids', () => {
  it.each(['passwords', 'secrets', 'cookies', 'api_keys', 'apiKeys', 'passphrase', 'bearer'])('replaces the value under %s', (key) => {
    expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
  });

  it.each(['token_count', 'tokenCount', 'tokenBudget', 'token_usage', 'pass_count', 'passCount', 'secretCount', 'password_length', 'cookie_count', 'authorizationCount', 'pwd_len', 'credentialsCount', 'secret-size', 'tokenSize'])(
    'keeps the number under the counter key %s',
    (key) => {
      expect(maskJevState({ [key]: 12 })).toEqual({ [key]: 12 });
    },
  );

  it('still masks a number or a string under a secret key that is no counter', () => {
    expect(maskJevState({ password: 1234, token_count: 'abc' })).toEqual({ password: '***', token_count: '***' });
  });

  it('leaves a UUID under session_id and sessionId, a git hash and cwd alone', () => {
    const uuid = '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10';
    const sha = '2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2';
    const cwd = '/work/worktrees/feature-oauth-refresh-rotation-2026-abcdef0123';
    expect(maskJevState({ session_id: uuid, sessionId: uuid, cwd, task: `Revert commit ${sha} now` })).toEqual({ session_id: uuid, sessionId: uuid, cwd, task: `Revert commit ${sha} now` });
  });

  it('does not exempt a UUID under another key, and still checks cwd for a secret path', () => {
    const uuid = '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10';
    expect(maskJevState({ other: `key ${uuid}` })).toEqual({ other: 'key ***' });
    expect(() => maskJevState({ cwd: '/home/u/.ssh/id_ed25519' })).toThrow(JevStateFieldOmittedError);
    expect(maskJevState({ cwd: '/work/a\n/home/u/.ssh/id_ed25519' })).toEqual({ cwd: '/work/a\n[line omitted: secret path]' });
  });

  it.each([
    'token=' + 'a1b2c3d4e5f6'.repeat(3) + 'a1b2',
    'export API_KEY=2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2',
    'MY_SERVICE_KEY=2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2',
    'Authorization: token 2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2',
  ])('masks a 40-character hex value after %s', (text) => {
    const out = maskJevState({ t: text }).t;
    expect(out).not.toMatch(/[0-9a-f]{20}/);
    expect(out).toContain('***');
  });

  it('masks a 40-character hex value under a secret key', () => {
    expect(maskJevState({ token: '2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2' })).toEqual({ token: '***' });
  });
});

describe('maskJevState: a string that is a secret path whole', () => {
  it.each(['cat ~/.ssh/id_ed25519', '/srv/app/.env', 'Do not touch the .env handling.', '  /home/u/.aws/credentials  '])('throws JevStateFieldOmittedError for %s', (text) => {
    expect(() => maskJevState({ task: text })).toThrow(JevStateFieldOmittedError);
    expect(() => maskJevState({ list: ['ok', text] })).toThrow(JevStateMaskError);
  });

  it('throws for a multi-line string whose every line names a secret path', () => {
    expect(() => maskJevState({ t: '/a/.env\n\n/b/.ssh/id_rsa\n' })).toThrow(JevStateFieldOmittedError);
  });

  it('goes on with a partly omitted string and with an empty one', () => {
    expect(maskJevState({ t: 'fix the build\ncat /a/.env' })).toEqual({ t: 'fix the build\n[line omitted: secret path]' });
    expect(maskJevState({ t: '', u: '   ' })).toEqual({ t: '', u: '   ' });
  });
});

describe('maskJevState: secret paths of any project', () => {
  it.each(['/srv/app/secrets/db.txt', '/run/secrets/x', './secrets/a', '/home/u/credentials', '~/credentials', '/data/passwords.txt', '/data/passwords.csv', '/vault/passwords.kdbx', '/vault/passwords', 'passwords.txt'])(
    'omits a line that names %s',
    (path) => {
      expect(maskJevState({ t: `first\ncat ${path}\nlast` })).toEqual({ t: 'first\n[line omitted: secret path]\nlast' });
    },
  );

  it.each([
    'ctx.credentials',
    'this.credentials = x',
    'credentials.ts',
    'src/credentials.ts',
    'getCredentials()',
    'src/passwords.ts',
    'passwords.test.mjs',
    'secretsManager',
    'mySecrets.ts',
    'the secrets are kept elsewhere',
    'hasla.txt',
  ])('does not take %s for a secret path', (text) => {
    expect(SECRET_PATH.test(`a ${text} b`)).toBe(false);
    expect(maskJevState({ t: `a ${text} b` }).t).not.toContain('[line omitted');
  });
});

describe('maskJevState: second pass changes nothing', () => {
  it('is idempotent on the states of these tests', () => {
    const ghp = 'ghp_' + 'A'.repeat(36);
    const states = [
      { prompt: `use ${ghp}\ncat /home/u/.ssh/id_ed25519`, config: { password: 'hunter2zzQ', totalTokens: 1234 } },
      { '~/.ssh/id_ed25519': 'x' },
      { '/home/u/.ssh/id_ed25519': 'a', '/home/v/.ssh/id_rsa': 'b', '/x/.env': 'c', ok: 'd' },
      { token: 'a', secret_tokens: 7, token_count: 3, passwords: ['a', 'b'], t: 'mysql --password hunter2zzQ' },
      { t: 'a\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\nb' },
      { t: 'Authorization: Bearer abcdefghijklmnop and AKIA' + 'B'.repeat(16), u: 'https://user:pw@host/x' },
      { session_id: '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10', cwd: '/work/a', list: [1, null, true, 'x'] },
      { t: 'x\n/run/secrets/x\ny' },
    ];
    for (const state of states) {
      const once = maskJevState(state);
      expect(maskJevState(once)).toEqual(once);
    }
  });
});

describe('maskJevState: the window', () => {
  const MAX = 200;
  it('cuts a string longer than maxChars plus the margin before it is masked, and only then', () => {
    const long = 'a '.repeat((MAX + WINDOW_MARGIN + 100) / 2);
    expect(maskJevState({ t: long }, { maxChars: MAX }).t).toHaveLength(MAX + WINDOW_MARGIN);
    expect(maskJevState({ t: long }).t).toHaveLength(long.length);
    const edge = 'a '.repeat((MAX + WINDOW_MARGIN) / 2);
    expect(maskJevState({ t: edge }, { maxChars: MAX }).t).toBe(edge);
  });

  it('hands maskSecrets at most maxChars plus the margin characters of a string (a structure check, no clock)', () => {
    const long = ('password ' + 'x'.repeat(30)).repeat(20_000);
    const out = maskJevState({ t: long }, { maxChars: MAX }).t;
    // the cut moves to the end of a run of token characters, at most RUN_EXTENSION further
    expect(out.length).toBeLessThanOrEqual(MAX + WINDOW_MARGIN + RUN_EXTENSION);
  });

  it('masks a secret that starts just before the edge of the window whole, not in part', () => {
    const ghp = 'ghp_' + 'A'.repeat(36);
    const key = 'sk-ant-' + 'B'.repeat(40);
    for (const secret of [ghp, key, 'AKIA' + 'C'.repeat(16)]) {
      for (const before of [MAX - 5, MAX - 1, MAX]) {
        const text = ' '.repeat(before) + secret + ' tail ' + 'z '.repeat(1000);
        const masked = maskJevState({ t: text }, { maxChars: MAX }).t.slice(0, MAX);
        expect(masked).not.toMatch(/(?:ghp_|sk-ant-|AKIA)[A-Za-z0-9]/);
      }
    }
  });

  it('masks a private key block that starts 100 characters before the edge to the end of the cut, so none of it goes out', () => {
    const body = ('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC' + 'x'.repeat(14)).repeat(40); // about 2600 characters
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const text = 'a'.repeat(MAX - 100) + '\n' + block + '\nafter';
    const sent = maskJevState({ t: text }, { maxChars: MAX }).t.slice(0, MAX);
    expect(sent).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj');
    expect(sent).toContain('-----BEGIN RSA PRIVATE KEY-----***');
  });

  it('cuts a long key too', () => {
    const out = maskJevState({ ['k '.repeat(2500)]: 1 }, { maxChars: MAX });
    expect(Object.keys(out)[0]).toHaveLength(MAX + WINDOW_MARGIN);
  });
});

describe('maskJevState: what the cut removes', () => {
  const MAX = 200;
  const sentOf = (value, key = 't') => maskJevState({ [key]: value }, { maxChars: MAX })[key].slice(0, MAX);

  it('masks URL credentials whose "@" is beyond the margin', () => {
    const text = 'x '.repeat(10) + 'https://user:' + 'A'.repeat(300) + 'z'.repeat(400) + '@host/path';
    expect(sentOf(text)).toBe('x '.repeat(10) + 'https://user:***');
    expect(sentOf(text)).not.toContain('AAAA');
  });

  it('masks an unterminated URL userinfo that starts at the edge of the window', () => {
    const text = 'a'.repeat(MAX - 20) + 'ftp://bob:' + 'p'.repeat(2000) + '@host';
    expect(sentOf(text)).not.toMatch(/p{3}/);
  });

  it('masks the unterminated userinfo in a key that was cut', () => {
    const key = '//user:' + 'q'.repeat(900);
    const [name] = Object.keys(maskJevState({ [key]: 1 }, { maxChars: MAX }));
    expect(name).toBe('//user:***');
  });

  it('masks a JWT whose last part is beyond the margin', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'B'.repeat(900) + '.sig12345678';
    expect(sentOf('a ' + jwt)).toBe('a eyJ***');
  });

  it('leaves a string that was not cut and a cut text without an unterminated URL alone', () => {
    expect(maskJevState({ t: 'see https://host:8080/x and //a:b/c' }, { maxChars: MAX }).t).toBe('see https://host:8080/x and //a:b/c');
    expect(maskJevState({ t: 'see https://host:8080/x' }, { maxChars: MAX }).t).toBe('see https://host:8080/x');
    const long = 'see https://host:8080/x ' + 'w '.repeat(500);
    expect(maskJevState({ t: long }, { maxChars: MAX }).t).toBe(long.slice(0, MAX + WINDOW_MARGIN));
    // without maxChars nothing is cut, so a URL without "@" is no credentials, as in compaction
    expect(maskJevState({ t: 'https://user:abc' }).t).toBe('https://user:abc');
  });
});

describe('maskJevState: a string whose sent part is a secret path whole', () => {
  const MAX = 200;
  const SEC = '/home/u/.ssh/id_ed25519';

  it('throws when the first maxChars characters are the marker and blank lines and the text is in the margin', () => {
    const text = SEC + '\n' + ' \n'.repeat(150) + 'plain text that nobody sends';
    expect(() => maskJevState({ t: text }, { maxChars: MAX })).toThrow(JevStateFieldOmittedError);
  });

  it('counts a marker that the edge of the window cut short', () => {
    const text = 'x'.repeat(MAX - 10) + '\n' + SEC + '\n' + 'plain text';
    // the first maxChars of the masked text are a line of x and part of the marker: sent, not omitted
    expect(() => maskJevState({ t: text }, { maxChars: MAX })).not.toThrow();
    const only = ' '.repeat(MAX - 10) + '\n' + SEC + '\n' + 'plain text in the margin '.repeat(5);
    expect(() => maskJevState({ t: only }, { maxChars: MAX })).toThrow(JevStateFieldOmittedError);
  });

  it('sends a string with plain text in the first maxChars characters', () => {
    const text = 'plain text\n' + SEC + '\n' + ' \n'.repeat(300);
    expect(maskJevState({ t: text }, { maxChars: MAX }).t.startsWith('plain text\n[line omitted: secret path]')).toBe(true);
  });

  it('judges the whole text without maxChars, as before', () => {
    expect(maskJevState({ t: SEC + '\n' + ' \n'.repeat(150) + 'plain text' }).t).toContain('plain text');
  });
});

// The class of the findings on the window cut: what a string without the window hides, a string with it must hide
// in the part that is sent, wherever the cut falls (the secret starts before, at or after the edge of the
// window, with and without a text before it that the mask shortens).
describe('maskJevState: a window never shows what the whole string hides', () => {
  const MAX = 700;
  // a small deterministic generator, so a failure names the same input every time
  const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const rnd = (alphabet, n, next) => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = LOWER.toUpperCase();
  const ALNUM = LOWER + UPPER + '0123456789';
  const B64URL = ALNUM + '-_';
  const PUNCT = LOWER + '!#$%^&()-_+~';
  // a string that is a secret path whole is not sent at all: that hides it too
  const maskedText = (value, opts) => { try { return maskJevState({ t: value }, opts).t; } catch (error) { if (error instanceof JevStateFieldOmittedError) return ''; throw error; } };
  const maskedKey = (value, opts) => Object.keys(maskJevState({ [value]: 1 }, opts))[0];
  const grams = (secret) => { const out = new Set(); for (let i = 0; i + 6 <= secret.length; i++) out.add(secret.slice(i, i + 6)); return out; };

  // [rule, builder: (next) => { text, secret }]
  const cases = [
    ['URL with punctuation and an "@" far away', (n) => { const secret = rnd(PUNCT, 600, n); return { text: `https://user:${secret}@host/x`, secret }; }],
    ['JWT', (n) => { const secret = rnd(B64URL, 600, n); return { text: `eyJ${rnd(B64URL, 20, n)}.${secret}.${rnd(B64URL, 43, n)}`, secret }; }],
    ['long token with the digit far away', (n) => { const secret = rnd(LOWER + UPPER, 700, n) + '7' + rnd(LOWER, 30, n); return { text: secret, secret }; }],
    ['AKIA', (n) => { const secret = rnd(UPPER, 16, n); return { text: `id AKIA${secret} end`, secret }; }],
    ['sk-', (n) => { const secret = rnd(B64URL, 60, n); return { text: 'sk-ant-' + secret, secret }; }],
    ['ghp_', (n) => { const secret = rnd(ALNUM, 40, n); return { text: 'ghp_' + secret, secret }; }],
    ['KEY=', (n) => { const secret = rnd(ALNUM, 40, n); return { text: `export API_KEY=${secret}`, secret }; }],
    ['authorization:', (n) => { const secret = rnd(ALNUM, 60, n); return { text: `Authorization: Bearer ${secret}`, secret }; }],
    ['cookie', (n) => { const secret = rnd(ALNUM, 60, n); return { text: `Cookie: sid=${secret}`, secret }; }],
    ['--password', (n) => { const secret = rnd(ALNUM, 30, n); return { text: `run --password ${secret} now`, secret }; }],
    ['mysql -p', (n) => { const secret = rnd(ALNUM, 30, n); return { text: `mysql -u root -p${secret}`, secret }; }],
    ['private key block', (n) => { const secret = Array.from({ length: 28 }, () => rnd(B64URL, 64, n)).join('\n'); return { text: `-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----`, secret }; }],
    ['a value before a secret path in the same line', () => ({ text: `echo hunter2 > ${'x '.repeat(350)}/home/u/.ssh/id_ed25519`, secret: 'hunter2' })],
  ];
  const offsets = [];
  for (let o = MAX - 40; o <= MAX + 560; o += 40) offsets.push(o);
  const shrink = 'Q9'.repeat(300); // a 600-character token that the mask turns into ***

  const build = (text, offset, shrinks) => {
    const head = shrinks ? shrink + ' ' : '';
    const fill = 'w '.repeat(Math.ceil((offset - head.length) / 2)).slice(0, offset - head.length);
    return head + fill + text + ' tail ' + 'w '.repeat(900);
  };

  it('hides every secret of the grid in the sent part of a string and of a key', () => {
    let secrets = 0;
    let assertions = 0;
    for (const [rule, make] of cases) {
      for (const shrinks of [false, true]) {
        for (const offset of offsets) {
          const { text, secret } = make(seeded(offset * 7 + (shrinks ? 1 : 0)));
          const input = build(text, offset, shrinks);
          const whole = maskedText(input);
          const wholeKey = maskedKey(input);
          const gs = [...grams(secret)];
          // the reference hides it (the case is a real secret of its rule)
          expect(gs.filter((g) => whole.includes(g)), `${rule} reference string, offset ${offset}`).toEqual([]);
          expect(gs.filter((g) => wholeKey.includes(g)), `${rule} reference key, offset ${offset}`).toEqual([]);
          const sent = maskedText(input, { maxChars: MAX }).slice(0, MAX);
          const key = maskedKey(input, { maxChars: MAX });
          expect(gs.filter((g) => sent.includes(g)), `${rule} string, offset ${offset}, shrink ${shrinks}`).toEqual([]);
          expect(gs.filter((g) => key.includes(g)), `${rule} key, offset ${offset}, shrink ${shrinks}`).toEqual([]);
          secrets++;
          assertions += 4;
        }
      }
    }
    // 13 rules x 2 (shortened or not) x 16 offsets, each as a string and as a key
    expect(secrets).toBe(13 * 2 * 16);
    expect(assertions).toBe(secrets * 4);
  });
});

describe('maskJevState: the tail of a cut text', () => {
  const MAX = 200;
  const sentOf = (value) => maskJevState({ t: value }, { maxChars: MAX }).t.slice(0, MAX);

  it('masks a token that the cut crosses, whose digit comes after the cut', () => {
    const text = ' '.repeat(190) + 'A'.repeat(600) + '1' + 'B'.repeat(100) + ' end';
    expect(sentOf(text)).not.toMatch(/A{3}/);
    expect(maskJevState({ ['k '.repeat(10) + 'A'.repeat(700) + '1' + 'B'.repeat(10)]: 1 }, { maxChars: MAX })).toBeDefined();
  });

  it('keeps a text before such a token when the mask has shortened an earlier token', () => {
    const text = 'Q9'.repeat(300) + ' ' + ' '.repeat(60) + 'A'.repeat(600) + '1' + 'B'.repeat(100);
    expect(sentOf(text)).not.toMatch(/A{3}/);
  });

  it('does not take the window away from text without spaces or from a long paragraph', () => {
    // Chinese text without spaces (written with escapes)
    const cjk = '\u8fd9\u662f\u4e00\u4e2a\u6ca1\u6709\u7a7a\u683c\u7684\u5f88\u957f\u7684\u4e2d\u6587\u6bb5\u843d\uff0c'.repeat(200);
    expect(sentOf(cjk)).toBe(cjk.slice(0, MAX));
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(60);
    expect(sentOf(english)).toBe(english.slice(0, MAX));
  });

  it('masks URL credentials with punctuation whose "@" is beyond the margin', () => {
    const text = 'x '.repeat(20) + 'https://user:pa!ss#' + 'w'.repeat(30) + '$%^&' + 'z'.repeat(800) + '@host/x';
    expect(sentOf(text)).toBe('x '.repeat(20) + 'https://user:***');
  });

  it('omits the last line of a cut text when its secret path is beyond the cut', () => {
    const text = 'first line\necho hunter2 > ' + 'x '.repeat(400) + '~/.ssh/id_ed25519\nlast';
    expect(sentOf(text)).toBe('first line\n[line omitted: secret path]');
    expect(sentOf(text)).not.toContain('hunter2');
  });

  it('leaves the last line alone when it names no secret path, and a complete line at the cut', () => {
    const text = 'first line\necho hello ' + 'x '.repeat(400) + 'end\nlast';
    expect(sentOf(text).startsWith('first line\necho hello x x')).toBe(true);
    const exact = 'a '.repeat((MAX + WINDOW_MARGIN) / 2 - 1) + '\n/home/u/.ssh/id_rsa';
    expect(maskJevState({ t: exact }, { maxChars: MAX }).t.startsWith('a a a')).toBe(true);
  });

  it('judges the last line on the original text when the line before it is part of a private key block', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n'.repeat(5) + '-----END RSA PRIVATE KEY-----\n';
    const text = block + 'echo hunter2 > ' + 'x '.repeat(400) + '~/.ssh/id_ed25519';
    expect(sentOf(text)).not.toContain('hunter2');
  });
});

describe('maskJevState: a run of token characters that the cut crosses', () => {
  const MAX = 200;
  const sentOf = (value) => maskJevState({ t: value }, { maxChars: MAX }).t.slice(0, MAX);

  it('follows a run to its end, so that a plain long run is sent as it is', () => {
    const run = 'a'.repeat(MAX + WINDOW_MARGIN + 100);
    expect(maskJevState({ t: run }, { maxChars: MAX }).t).toBe(run);
  });

  it('replaces a run that is longer than RUN_EXTENSION past the cut by ***', () => {
    const text = ' '.repeat(190) + 'A'.repeat(MAX + WINDOW_MARGIN + RUN_EXTENSION + 10) + '1';
    expect(sentOf(text)).toBe(' '.repeat(190) + '***');
  });

  it('does not take the window of a long text with no white space and a token character at the cut', () => {
    const text = 'x'.repeat(MAX + WINDOW_MARGIN + 3000);
    expect(sentOf(text)).toBe('x'.repeat(MAX));
  });
});

describe('maskJevState: key names with acronyms and glued prefixes', () => {
  it.each(['DBPassword', 'APIToken', 'APIKey', 'dbpassword', 'userpassword', 'apitoken', 'accesstoken', 'authtoken', 'clientsecret', 'mypassphrase', 'usercredentials', 'password2', 'token1', 'secret_v2', 'Pass2', 'PRIVATEKEY', 'secretsManager', 'cookieJar'])(
    'replaces the value under %s',
    (key) => {
      expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
    },
  );

  it.each(['tokenizer', 'secretary', 'passwordless', 'tokens_used', 'bypass', 'compass', 'passenger', 'passes', 'passed', 'XMLHttpRequest', 'userId', 'HTMLParser', 'keyboard'])(
    'leaves the value under %s',
    (key) => {
      expect(maskJevState({ [key]: 'plain value' })).toEqual({ [key]: 'plain value' });
    },
  );

  it('keeps the counters and the markers out of the key check', () => {
    expect(maskJevState({ DBPasswordLength: 12, APITokenCount: 3, input_tokens: 5 })).toEqual({ DBPasswordLength: 12, APITokenCount: 3, input_tokens: 5 });
    const once = maskJevState({ '/home/u/.ssh/id_rsa': 'x', '/x/.env': 'y' });
    expect(maskJevState(once)).toEqual(once);
  });
});

describe('maskJevState: plural token keys', () => {
  it.each(['accessTokens', 'refreshTokens', 'idTokens', 'apiTokens', 'authTokens', 'refresh_tokens', 'tokens'])('replaces a string or an array under %s', (key) => {
    expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
    expect(maskJevState({ [key]: ['a1b2c3', 'd4e5f6'] })).toEqual({ [key]: '***' });
  });

  it('keeps a number under a key that ends with tokens, and leaves passes, passed and passes: 3 alone', () => {
    expect(maskJevState({ max_tokens: 4096, totalTokens: 7, input_tokens: 5, accessTokens: 3, tokens: 12 })).toEqual({ max_tokens: 4096, totalTokens: 7, input_tokens: 5, accessTokens: 3, tokens: 12 });
    expect(maskJevState({ passes: 3, passed: 'yes', passes_total: 2 })).toEqual({ passes: 3, passed: 'yes', passes_total: 2 });
  });

  it('masks a string under a key that ends with tokens (a counter key holds a number)', () => {
    expect(maskJevState({ max_tokens: 'inherit' })).toEqual({ max_tokens: '***' });
  });
});

describe('maskJevState: names that collide after masking', () => {
  it('numbers the keys that become the same marker, and never overwrites a key that has the numbered name', () => {
    const state = { '/a/.ssh/id_rsa': 1, '/b/.ssh/id_rsa': 2, '[key omitted: path] #2': 'literal', '/c/.ssh/id_rsa': 3 };
    const out = maskJevState(state);
    expect(Object.keys(out)).toEqual(['[key omitted: path]', '[key omitted: path] #2', '[key omitted: path] #2 #2', '[key omitted: path] #3']);
    expect(Object.values(out)).toEqual([1, 2, 'literal', 3]);
  });

  it('numbers many colliding keys in order (the next number is kept per name)', () => {
    const state = {};
    for (let i = 0; i < 300; i++) state[`/h${i}/.ssh/id_rsa`] = i;
    const keys = Object.keys(maskJevState(state));
    expect(keys).toHaveLength(300);
    expect(keys[0]).toBe('[key omitted: path]');
    expect(keys[299]).toBe('[key omitted: path] #300');
    expect(new Set(keys).size).toBe(300);
  });
});

describe('maskJevState: values that stand beside their names', () => {
  it.each([
    [{ name: 'DB_PASSWORD', value: 'hunter2zzQ' }, { name: 'DB_PASSWORD', value: '***' }],
    [{ key: 'apiToken', value: 'hunter2zzQ' }, { key: 'apiToken', value: '***' }],
    [{ Name: 'accessTokens', Value: 'hunter2zzQ' }, { Name: 'accessTokens', Value: '***' }],
    [{ ParameterKey: 'dbPassword', ParameterValue: 'hunter2zzQ' }, { ParameterKey: 'dbPassword', ParameterValue: '***' }],
    [{ name: 'LOG_LEVEL', value: 'debug' }, { name: 'LOG_LEVEL', value: 'debug' }],
    [{ name: 'token_count', value: 5 }, { name: 'token_count', value: 5 }],
  ])('pair %j', (input, expected) => {
    expect(maskJevState(input)).toEqual(expected);
  });

  it.each([
    [['Authorization', 'Basic abc123'], ['Authorization', '***']],
    [['X-Api-Key', 'hunter2zzQ'], ['X-Api-Key', '***']],
    [['Cookie', 'a=b'], ['Cookie', '***']],
    [['pass', 'fail'], ['pass', 'fail']],
    [['name', 'value'], ['name', 'value']],
  ])('tuple %j', (input, expected) => {
    expect(maskJevState({ headers: [input] }).headers[0]).toEqual(expected);
  });

  it('masks a header under a key that is no secret name', () => {
    expect(maskJevState({ headers: { Authorization: 'Basic abc123', Accept: 'text/html' } })).toEqual({ headers: { Authorization: '***', Accept: 'text/html' } });
  });

  it.each([
    [['--password', 'hunter2zzQ'], ['--password', '***']],
    [['run', '--token', 'hunter2zzQ', 'x'], ['run', '--token', '***', 'x']],
    [['--api-key', 'hunter2zzQ'], ['--api-key', '***']],
    [['mysql', '-u', 'root', '-p', 'hunter2zzQ'], ['mysql', '-u', 'root', '-p', '***']],
    [['sshpass', '-p', 'hunter2zzQ', 'ssh', 'host'], ['sshpass', '-p', '***', 'ssh', 'host']],
    [['curl', '-u', 'user:hunter2zzQ'], ['curl', '-u', 'user:***']],
    [['curl', '--user', 'u:hunter2zzQ'], ['curl', '--user', 'u:***']],
    [['-u', 'user:hunter2zzQ'], ['-u', 'user:***']],
    [['mysql', '-u', 'root', '-phunter2zzQ', 'db'], ['mysql', '-u', 'root', '-p***', 'db']],
    [['sudo', 'mysqldump', '-phunter2zzQ'], ['sudo', 'mysqldump', '-p***']],
    [['sshpass', '-phunter2zzQ', 'ssh', 'host'], ['sshpass', '-p***', 'ssh', 'host']],
    [['curl', '-u', 'useronly'], ['curl', '-u', 'useronly']],
    [['docker', 'login', '-p', 'hunter2zzQ'], ['docker', 'login', '-p', 'hunter2zzQ']],
    [['docker', 'run', '-p', '8080:80'], ['docker', 'run', '-p', '8080:80']],
    [['ssh', '-p', '2222', 'host'], ['ssh', '-p', '2222', 'host']],
  ])('arguments %j', (input, expected) => {
    expect(maskJevState({ argv: input }).argv).toEqual(expected);
  });
});

describe('maskJevState: an array of arguments hides what the same command line hides as a string', () => {
  const SECRET = 'hunter2zzQ';
  const lines = [
    ['curl', '-u', `user:${SECRET}`, 'http://h'],
    ['curl', '--user', `u:${SECRET}`],
    ['-u', `user:${SECRET}`],
    ['run', '--password', SECRET, 'x'],
    ['run', '--passwd', SECRET],
    ['run', '--pass', SECRET],
    ['run', '--token', SECRET],
    ['run', '--secret', SECRET],
    ['run', '--api-key', SECRET],
    ['run', '--apikey', SECRET],
    ['run', '--access-token', SECRET],
    ['run', '--auth-token', SECRET],
    ['run', '--client-secret', SECRET],
    ['mysql', '-u', 'root', `-p${SECRET}`, 'db'],
    ['mariadb', `-p${SECRET}`],
    ['mysqldump', `-p${SECRET}`, 'db'],
    ['mysqladmin', '-u', 'root', `-p${SECRET}`, 'status'],
    ['sshpass', '-p', SECRET, 'ssh', 'host'],
    ['sshpass', `-p${SECRET}`, 'ssh', 'host'],
  ];
  it.each(lines.map((argv) => [argv.join(' '), argv]))('%s', (_line, argv) => {
    const asString = maskJevState({ t: argv.join(' ') }).t;
    const asArray = JSON.stringify(maskJevState({ argv }).argv);
    // what the string does not let out, the array does not let out either
    expect(asString).not.toContain(SECRET);
    expect(asArray).not.toContain(SECRET);
  });

  it('leaves alone what the string leaves alone', () => {
    for (const argv of [['docker', 'login', '-p', SECRET], ['curl', '-u', 'useronly'], ['ssh', '-p', '2222', 'host']]) {
      expect(maskJevState({ t: argv.join(' ') }).t).toBe(argv.join(' '));
      expect(maskJevState({ argv }).argv).toEqual(argv);
    }
  });
});

describe('maskJevState: the tail class holds what the rules take', () => {
  // Every printable ASCII character that a rule of maskSecrets takes inside a secret that has a minimum length or a
  // context further along the same string must be a token character, so that the cut can be moved to the end of the run.
  const T = 'ZQZQZQZQ';
  const A = (n) => 'A'.repeat(n);
  const rules = {
    bearer: (c) => `bearer ${A(8)}${c}${T}`,
    sk: (c) => `sk-ant-${A(16)}${c}${T}`,
    ghp: (c) => `ghp_${A(12)}${c}${T}`,
    github_pat: (c) => `github_pat_${A(12)}${c}${T}`,
    glpat: (c) => `glpat-${A(12)}${c}${T}`,
    xox: (c) => `xoxb-${A(12)}${c}${T}`,
    sk_live: (c) => `sk_live_${A(20)}${c}${T}`,
    hf: (c) => `hf_${A(20)}${c}${T}`,
    npm: (c) => `npm_${A(20)}${c}${T}`,
    akia: (c) => `AKIA${A(8)}${c}ZQZQZQZ`,
    jwt1: (c) => `eyJ${A(8)}${c}${T}.${A(10)}.${A(10)}`,
    jwt2: (c) => `eyJ${A(10)}.${A(8)}${c}${T}.${A(10)}`,
    jwt3: (c) => `eyJ${A(10)}.${A(10)}.${A(8)}${c}${T}`,
    long: (c) => `A1${A(20)}${c}${T}${T}`,
  };
  it('has every character that a rule takes (the URL rule takes more and has its own tail rule)', () => {
    const missing = [];
    for (const [name, build] of Object.entries(rules)) {
      for (let code = 0x21; code <= 0x7e; code++) {
        const c = String.fromCharCode(code);
        if (!maskSecrets(build(c)).includes('ZQZQ') && !TOKEN_CHAR.test(c)) missing.push(`${name}: ${c}`);
      }
    }
    expect(missing).toEqual([]);
    expect(TOKEN_CHAR.test('~')).toBe(true);
    expect(TOKEN_CHAR.test('\u4e2d')).toBe(false);
  });
});

describe('maskJevState: random cases against the mask without a window', () => {
  it('hides in the sent part what the mask without a window hides, for 400 cases of a fixed seed', () => {
    const next = seededRandom(20261113);
    const counts = { ok: 0, gap: 0, error: 0 };
    for (let i = 0; i < 400; i++) {
      const c = makeCase(next);
      const r = checkCase(maskJevState, c);
      if (r.ok) counts.ok++;
      else if (r.gap) counts.gap++;
      else counts.error++;
      expect(r.error, `case ${i}: ${c.kind}, maxChars ${c.maxChars}, shows ${r.shown}`).toBeUndefined();
    }
    expect(counts.ok).toBeGreaterThan(380);
  });
});

describe('SECRET_PATH', () => {
  // Everything the compaction expression catches is caught here too (this one adds patterns).
  function compactionPath() {
    const source = readFileSync(join(root, 'hooks', 'jev-compaction.mjs'), 'utf8');
    const start = source.indexOf('const SECRET_START');
    const end = source.indexOf("].join('|'), 'i');", start) + "].join('|'), 'i');".length;
    expect(start).toBeGreaterThan(0);
    return new Function(source.slice(start, end).replace('const SECRET_PATH =', 'return'))();
  }

  it('catches every path of a corpus that the compaction expression catches, and every one of the corpus of the compaction tests', () => {
    const original = compactionPath();
    const tests = readFileSync(join(root, 'src', '__tests__', 'jev-compaction-module.test.mjs'), 'utf8');
    const quoted = [...tests.matchAll(/'([^'\n]{3,120})'/g)].map((m) => m[1]);
    const corpus = [
      ...quoted,
      '/home/u/.ssh/id_rsa', '~/.ssh/id_ed25519', 'old_id_rsa', 'id_rsa.bak', 'backup.ssh/key', '/home/u/.git-credentials',
      '/home/u/.config/gh/hosts.yml', '/home/u/.claude/.credentials.json', '/root/.aws/credentials', '/home/u/.netrc',
      '/srv/app/.env', '/srv/app/.env.production.local', 'prod.env', 'my-app.env', 'edit .env, then', '/repo/.env:2:',
      '/home/u/.ssh/known_hosts', '/home/u/.ssh/id_rsa.pub', '/srv/.env.example', 'ctx.env', 'ctx.app.env', '.sshuttle/x',
    ];
    let caught = 0;
    for (const text of corpus) {
      if (original.test(text)) {
        caught++;
        expect(SECRET_PATH.test(text), text).toBe(true);
      }
    }
    expect(caught).toBeGreaterThan(15);
  });
});
