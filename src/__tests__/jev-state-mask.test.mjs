/**
 * scripts/lib/jev-state-mask.mjs: the mask every Jev point's state goes through before it is sent or logged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeCase, checkCase, seededRandom } from './jev-state-mask-cases.mjs';
import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { JevStateFieldOmittedError, JevStateMaskError, KEY_OMITTED, LINE_EXTENSION, MAX_STATE_CHARS, MAX_STATE_DEPTH, MAX_STATE_NODES, PATH_TAIL, RUN_EXTENSION, SECRET_PATH, TOKEN_CHAR, WINDOW_MARGIN, maskJevState, normalizeKey, treatment } from '../../scripts/lib/jev-state-mask.mjs';

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

  it('leaves a UUID under session_id and sessionId at the top of the state, a git hash and a short cwd alone', () => {
    const uuid = '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10';
    const sha = '2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2';
    const cwd = '/work/worktrees/feature-oauth';
    expect(maskJevState({ session_id: uuid, sessionId: uuid, cwd, task: `Revert commit ${sha} now` })).toEqual({ session_id: uuid, sessionId: uuid, cwd, task: `Revert commit ${sha} now` });
  });

  it('masks cwd like any other string: a token and a long directory name go, and a secret path is still refused', () => {
    const uuid = '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10';
    expect(maskJevState({ other: `key ${uuid}` })).toEqual({ other: 'key ***' });
    expect(maskJevState({ cwd: '/tmp/' + GHP })).toEqual({ cwd: '/tmp/ghp_***' });
    expect(maskJevState({ cwd: '/work/worktrees/feature-oauth-refresh-rotation-2026-abcdef0123' })).toEqual({ cwd: '/work/worktrees/***' });
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

  it('numbers 20000 colliding keys in well under a second (the numbering is linear, not a rescan from #2 for every key)', () => {
    const state = {};
    for (let i = 0; i < 20000; i++) state[`/run/secrets/key-${i}`] = i;
    const start = performance.now();
    const keys = Object.keys(maskJevState(state));
    const duration = performance.now() - start;
    expect(keys).toHaveLength(20000);
    expect(keys[19999]).toBe('[key omitted: path] #20000');
    expect(new Set(keys).size).toBe(20000);
    // linear: tens of milliseconds; the rescan took 52 s
    expect(duration).toBeLessThan(3000);
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
    [['pass', 'hunter2zzQ'], ['pass', '***']],
    [['name', 'value'], ['name', 'value']],
  ])('tuple %j', (input, expected) => {
    expect(maskJevState({ headers: [input] }).headers[0]).toEqual(expected);
  });

  it('preserves counter numbers in two-element tuples', () => {
    expect(maskJevState({ usage: [['input_tokens', 1234]] })).toEqual({ usage: [['input_tokens', 1234]] });
    expect(maskJevState({ data: [['token_count', 5], ['token_budget', 100]] })).toEqual({ data: [['token_count', 5], ['token_budget', 100]] });
  });

  it('still masks secret strings under secret keys in two-element tuples', () => {
    expect(maskJevState({ creds: [['password', 'hunter2zzQ']] })).toEqual({ creds: [['password', '***']] });
    expect(maskJevState({ data: [['api_key', 'secret123']] })).toEqual({ data: [['api_key', '***']] });
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

describe('maskJevState: oversized keys should not cause performance issues', () => {
  it('handles very long all-uppercase keys without quadratic backtracking', () => {
    // A 50,000-character all-uppercase key should not cause 8+ second hangs
    const longKey = 'A'.repeat(50000);
    const start = Date.now();
    const result = maskJevState({ [longKey]: 'value' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    expect(result).toEqual({ [longKey]: 'value' });
  });

  it('classifies single-letter acronym prefixes as secrets', () => {
    // Single-letter uppercase followed by lowercase should split: XApiKey -> X_Api_Key -> x_api_key
    expect(maskJevState({ XApiKey: 'hunter2' })).toEqual({ XApiKey: '***' });
    expect(maskJevState({ XPrivateKey: 'secret' })).toEqual({ XPrivateKey: '***' });
    expect(maskJevState({ XAuthorization: 'bearer' })).toEqual({ XAuthorization: '***' });
  });

  it('classifies long labels in name/value pairs as secrets', () => {
    // Long secret names (>200 chars) should still be classified without length guard
    const longSecret = 'DB_PASSWORD_' + 'A'.repeat(200);
    const result = maskJevState([{ name: longSecret, value: 'hunter2zzQ' }]);
    expect(result[0].value).toBe('***');
  });

  it('recognizes Windows executable suffixes of the command word', () => {
    // Commands with .exe, .bat, .COM suffixes should be recognized for password masking
    expect(maskJevState({ cmd: ['mysql.exe', '-phunter2'] })).toEqual({ cmd: ['mysql.exe', '-p***'] });
    expect(maskJevState({ cmd: ['mysqldump.bat', '-phunter2'] })).toEqual({ cmd: ['mysqldump.bat', '-p***'] });
    expect(maskJevState({ cmd: ['mysqladmin.COM', '-phunter2'] })).toEqual({ cmd: ['mysqladmin.COM', '-p***'] });
  });

  it('keeps a key made of unterminated marker prefixes as it is, and fast', () => {
    const markerKey = '[key omitted: '.repeat(10000);
    const start = performance.now();
    const result = maskJevState({ [markerKey]: 'value' });
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(1000);
    expect(Object.keys(result)).toEqual([markerKey]);
    expect(result[markerKey]).toBe('value');
  });
});

describe('maskJevState: the name of a key', () => {
  it.each(['api.key', 'x.api.key', 'stripe.api.key', 'aws.secret.access.key', 'private.key', 'access.key', 'x/api/key', 'API.KEY'])(
    'a word set apart by a dot or a slash still names a secret: %s',
    (key) => {
      expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
    },
  );

  it.each(['[key omitted: password]', '[line omitted: password]', '[key omitted: token] x', 'x [line omitted: api_key]'])(
    'a key that only looks like one of our markers keeps its words: %s',
    (key) => {
      expect(maskJevState({ [key]: 'hunter2zzQ' })).toEqual({ [key]: '***' });
    },
  );

  it('takes out the two markers themselves, so a second pass changes nothing', () => {
    expect(normalizeKey('[key omitted: path] #2')).toBe(' #2');
    expect(normalizeKey('[line omitted: secret path]')).toBe('');
    const once = maskJevState({ '/run/secrets/a': 'plain', '/run/secrets/b': 'plain', 'ok': 'plain' });
    expect(Object.keys(once)).toEqual(['[key omitted: path]', '[key omitted: path] #2', 'ok']);
    expect(maskJevState(once)).toEqual(once);
  });

  it('classifies a key of any length: the words are found beyond the first 1000 characters', () => {
    for (const key of ['A'.repeat(1001) + 'PrivateKey', 'a'.repeat(5000) + 'ApiKey', 'X'.repeat(3000) + 'Password', '_'.repeat(2000) + 'token']) {
      expect(maskJevState({ [key]: 'hunter2zzQ' }), key.slice(-12)).toEqual({ [key]: '***' });
      expect(maskJevState({ env: [{ name: key, value: 'hunter2zzQ' }] }).env[0].value, key.slice(-12)).toBe('***');
    }
    expect(maskJevState({ ['A'.repeat(5000)]: 'plain value' })).toEqual({ ['A'.repeat(5000)]: 'plain value' });
  });

  it('splits words as the regular expressions it replaced did, on every ASCII key of a seeded corpus', () => {
    const reference = (key) => key.replace(/\[(?:key|line) omitted: [^\]]*\]/g, '').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const next = seededRandom(20261117);
    const alphabet = 'aAbBxXyY09_- .Zz';
    for (const key of ['XApiKey', 'DBPassword', 'APIToken', 'HTTPServer', 'getHTTPResponseCode', 'a1B2c3D', 'ABC', 'aBC', 'AbC', 'X', '']) expect(normalizeKey(key), key).toBe(reference(key));
    for (let i = 0; i < 3000; i++) {
      let key = '';
      for (let j = Math.floor(next() * 14); j > 0; j--) key += alphabet[Math.floor(next() * alphabet.length)];
      expect(normalizeKey(key), JSON.stringify(key)).toBe(reference(key));
    }
  });
});

describe('maskJevState: the cost of a key grows with its length and no more', () => {
  const SHAPES = {
    'one capital letter repeated': (n) => 'A'.repeat(n),
    'humps': (n) => 'aB'.repeat(n / 2),
    'a capital before a small letter': (n) => 'Ab'.repeat(n / 2),
    'digits before capitals': (n) => '0A'.repeat(n / 2),
    'separators': (n) => '_'.repeat(n),
    'unterminated key markers': (n) => '[key omitted: '.repeat(Math.ceil(n / 14)),
    'unterminated line markers': (n) => '[line omitted: secret path'.repeat(Math.ceil(n / 26)),
    'a strong word repeated': (n) => 'password'.repeat(n / 8),
    'a weak word and digits': (n) => 'pass1'.repeat(n / 5),
    'a weak word set apart by dots': (n) => 'api.key.'.repeat(n / 8),
  };
  const best = (run) => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      times.push(performance.now() - start);
    }
    return Math.min(...times);
  };

  it.each(Object.keys(SHAPES))('%s: as a key, as the name of a pair and as an argument', (name) => {
    // as the resolvers call it: with the excerpt limit, so a string is cut before the text rules see it
    const options = { maxChars: 200 };
    for (const mask of [(key) => maskJevState({ [key]: 'v' }, options), (key) => maskJevState({ name: key, value: 'v' }, options), (key) => maskJevState({ argv: ['run', key, `${key}=x`] }, options)]) {
      const small = best(() => mask(SHAPES[name](25000)));
      const large = best(() => mask(SHAPES[name](100000)));
      // four times the length: a linear cost is about four times, a quadratic one sixteen; the bounds leave room for a slow machine
      expect(large).toBeLessThan(12 * Math.max(small, 2) + 100);
      expect(large).toBeLessThan(2000);
    }
  });
});

describe('maskJevState: several names beside one value', () => {
  it.each([
    [{ key: 'password', name: 'token_count', value: 123456 }],
    [{ name: 'token_count', key: 'password', value: 123456 }],
    [{ value: 123456, name: 'token_count', key: 'password' }],
    [{ name: 'token_count', value: 123456, parameter_key: 'api_key' }],
    [{ parameter_key: 'token_count', name: 'client_secret', value: 123456 }],
  ])('a secret name wins over a counter name, whatever the order: %j', (input) => {
    expect(maskJevState(input).value).toBe('***');
  });

  it('keeps a number when every name is a counter, and a string under a counter name that is also a secret', () => {
    expect(maskJevState({ name: 'token_count', key: 'input_tokens', value: 5 }).value).toBe(5);
    expect(maskJevState({ key: 'input_tokens', name: 'token_count', value: 'text' }).value).toBe('***');
  });

  it('does the same for a pair of two elements that other rules have classified', () => {
    expect(maskJevState({ t: ['--password', 5] }).t).toEqual(['--password', '***']);
    expect(maskJevState({ t: ['token_count', 5] }).t).toEqual(['token_count', 5]);
    expect(maskJevState({ t: ['--token', 5] }).t).toEqual(['--token', '***']);
  });
});

describe('maskJevState: an argument is one value, white space and quotes included', () => {
  it.each([
    [['curl', '-u', 'user:prefix hunter2zzQ'], ['curl', '-u', 'user:***']],
    [['curl', '-u', 'user: x y'], ['curl', '-u', 'user:***']],
    [['curl', '-u', 'user:a "b" \'c\''], ['curl', '-u', 'user:***']],
    [['curl', '-u', ':only a password'], ['curl', '-u', ':***']],
    [['curl', '-u', 'my user:pass word'], ['curl', '-u', 'my user:***']],
    [['curl', '--user=user:pre fix'], ['curl', '--user=user:***']],
    [['curl', '--user=useronly'], ['curl', '--user=useronly']],
    [['run', '--password=a b c'], ['run', '--password=***']],
    [['run', '--token=a b', '--api-key=c d'], ['run', '--token=***', '--api-key=***']],
    [['run', '--password-file=/etc/x y'], ['run', '--password-file=/etc/x y']],
    [['mysql', '-phunter 2zzQ'], ['mysql', '-p***']],
    [['mysql', '-p"a b"'], ['mysql', '-p***']],
    [['mariadb-dump', '-phunter2zzQ', 'db'], ['mariadb-dump', '-p***', 'db']],
    [['C:\\Program Files\\MySQL\\bin\\mysql.exe', '-phunter2zzQ'], ['C:\\Program Files\\MySQL\\bin\\mysql.exe', '-p***']],
    [['mysql', '-p'], ['mysql', '-p']],
    [['mysql_upgrade', '-phunter2zzQ'], ['mysql_upgrade', '-phunter2zzQ']],
  ])('%j', (input, expected) => {
    expect(maskJevState({ argv: input }).argv).toEqual(expected);
  });

  it('hides in an array what the same command line hides as a string, for each command word and each way to give a credential', () => {
    const SECRET = 'hunter2zzQ';
    const commands = ['mysql', '/usr/bin/mysql', 'mysql.exe', 'C:\\bin\\mysql.exe', 'mariadb', 'mariadb-dump', 'mysqldump.bat', 'mysqladmin', 'sshpass', 'sudo mysql', 'docker exec db mysql'];
    const credentials = [['-p' + SECRET], ['-p', SECRET], ['-u', 'root', '-p' + SECRET], ['-u', 'root', '-p', SECRET], ['--password', SECRET], ['--password=' + SECRET], ['--user', 'u:' + SECRET], ['--user=u:' + SECRET], ['-u', 'u:' + SECRET], ['--token=' + SECRET], ['--api-key', SECRET], ['--passwd=' + SECRET]];
    let checked = 0;
    for (const command of commands) {
      for (const credential of credentials) {
        for (const tail of [[], ['db']]) {
          const argv = [...command.split(' '), ...credential, ...tail];
          if (maskJevState({ t: argv.join(' ') }).t.includes(SECRET)) continue;
          expect(JSON.stringify(maskJevState({ argv }).argv), argv.join(' ')).not.toContain(SECRET);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('maskJevState: the program of a command is read from the end of its argument, whatever the window', () => {
  const MAX = 200;
  const CAP = MAX + WINDOW_MARGIN;
  const SECRET = 'hunter2zzQ';
  // what is sent: every string cut to maxChars, as the resolvers do after the mask
  const sentOf = (argv, options) => maskJevState({ argv }, options).argv.map((item) => (typeof item === 'string' ? item.slice(0, MAX) : item));
  // a path of exactly `length` characters that ends in `program`: many directories, or one long directory name
  const programPath = (program, length, sep, deep) => {
    const room = length - program.length - 1;
    const dirs = Math.floor(room / 2);
    const path = deep ? 'd'.repeat(room - 2 * dirs) + sep + ('d' + sep).repeat(dirs) + program : 'd'.repeat(room) + sep + program;
    expect(path).toHaveLength(length);
    return path;
  };
  // [name, what follows the program, what is sent of it]; `db` after each, so that no argv is a pair of two elements
  const positions = [
    ['-p SECRET', ['-p', SECRET, 'db'], ['-p', '***', 'db']],
    ['-pSECRET', [`-p${SECRET}`, 'db'], ['-p***', 'db']],
    ['-u root -p SECRET', ['-u', 'root', '-p', SECRET, 'db'], ['-u', 'root', '-p', '***', 'db']],
    ['-u root -pSECRET', ['-u', 'root', `-p${SECRET}`, 'db'], ['-u', 'root', '-p***', 'db']],
    ['--password SECRET', ['--password', SECRET, 'db'], ['--password', '***', 'db']],
    ['--password=SECRET', [`--password=${SECRET}`, 'db'], ['--password=***', 'db']],
    ['-u user:SECRET', ['-u', `user:${SECRET}`, 'db'], ['-u', 'user:***', 'db']],
    ['--user=user:SECRET', [`--user=user:${SECRET}`, 'db'], ['--user=user:***', 'db']],
    ['a URL with user:SECRET@host', [`https://user:${SECRET}@host`, 'db'], ['https://user:***@host', 'db']],
  ];
  const programs = ['mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'mariadb-dump', 'mysql.exe', 'sshpass'];
  const lengths = [MAX - 1, MAX, CAP, CAP + 1, PATH_TAIL, 100_000];
  const before = { none: [], sudo: ['sudo'], 'a number and a long argument': [7, 'a/'.repeat(CAP)] };

  it('hides what the mask without a window hides, for a program path of every length around the window, each program, each place of the secret and each prefix', () => {
    let cells = 0;
    for (const program of programs) {
      for (const length of lengths) {
        for (const sep of ['/', '\\']) {
          for (const deep of [true, false]) {
            const path = programPath(program, length, sep, deep);
            for (const [prefixName, prefix] of Object.entries(before)) {
              for (const [position, rest, expected] of positions) {
                const argv = [...prefix, path, ...rest];
                const label = `${program} ${length} ${sep} ${deep} / ${prefixName} / ${position}`;
                const skip = prefix.length + 1;
                // the mask without a window is the reference for what is hidden...
                expect(sentOf(argv).slice(skip), `${label}: without a window`).toEqual(expected);
                // ...and a window hides all of it too, never less
                const windowed = sentOf(argv, { maxChars: MAX });
                expect(windowed.slice(skip), label).toEqual(expected);
                expect(JSON.stringify(windowed), label).not.toContain(SECRET);
                cells++;
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(programs.length * lengths.length * 2 * 2 * Object.keys(before).length * positions.length);
  });

  it('does the same for a program that is a path with the command as its base name and a separator close to the end, at any length', () => {
    for (const length of [CAP + 1, 100_000, 2_000_000]) {
      const argv = ['x'.repeat(length) + '/mysql', '-p', SECRET, 'db'];
      expect(sentOf(argv, { maxChars: MAX }).slice(1)).toEqual(['-p', '***', 'db']);
      expect(sentOf(argv).slice(1)).toEqual(['-p', '***', 'db']);
    }
  });

  describe('an argument that is longer than PATH_TAIL and has no separator in its last PATH_TAIL characters', () => {
    const argvOf = (first) => [first, '-p', SECRET, 'db'];
    // the base name is the whole of `/mysqlzzz...`: not a program of the family when it is read whole, so the mask without a window leaves the -p alone
    const longName = (n) => '/usr/bin/mysql' + 'z'.repeat(n);

    it('is the end of the base name that is read, so a separator inside the last PATH_TAIL characters decides exactly', () => {
      // the separator is the first of the last PATH_TAIL characters: the base name is z...z, no program, the -p stays in both
      const exact = '/' + 'z'.repeat(PATH_TAIL - 1);
      expect(exact.length).toBe(PATH_TAIL);
      expect(sentOf(argvOf('x'.repeat(5000) + exact), { maxChars: MAX })[2]).toBe(SECRET);
      expect(sentOf(argvOf('x'.repeat(5000) + exact))[2]).toBe(SECRET);
    });

    it('is taken for a program: the window hides more than the whole argument would (fail closed)', () => {
      const argv = argvOf(longName(PATH_TAIL + 10));
      expect(sentOf(argv)[2]).toBe(SECRET);
      expect(sentOf(argv, { maxChars: MAX })[2]).toBe('***');
      // one character more than the separator can be seen in: no separator in the last PATH_TAIL characters
      const noSeparator = '/' + 'z'.repeat(PATH_TAIL);
      expect(sentOf(argvOf('x'.repeat(5000) + noSeparator))[2]).toBe(SECRET);
      expect(sentOf(argvOf('x'.repeat(5000) + noSeparator), { maxChars: MAX })[2]).toBe('***');
      expect(sentOf(argvOf('mysql.' + 'z'.repeat(5000)))[2]).toBe('***');
      expect(sentOf(argvOf('mysql.' + 'z'.repeat(5000)), { maxChars: MAX })[2]).toBe('***');
    });

    it('is no program when a window leaves the argument whole or its end shows the base name', () => {
      expect(sentOf(argvOf('/usr/bin/' + 'z'.repeat(PATH_TAIL - 20)), { maxChars: MAX })[2]).toBe(SECRET);
      expect(sentOf(argvOf('/usr/bin/' + 'z'.repeat(5000) + '/ls'), { maxChars: MAX })[2]).toBe(SECRET);
      expect(sentOf(argvOf('/usr/bin/' + 'z'.repeat(5000) + '/mysqlx'), { maxChars: MAX })[2]).toBe(SECRET);
    });
  });

  it('reads no more than PATH_TAIL characters of the end of an argument (a structure check, no clock)', () => {
    const seen = [];
    const original = String.prototype.lastIndexOf;
    String.prototype.lastIndexOf = function lastIndexOf(...args) {
      seen.push(String(this).length);
      return original.apply(this, args);
    };
    try {
      maskJevState({ argv: ['z'.repeat(3_000_000), '/' + 'd/'.repeat(1_000_000) + 'mysql', 'x'.repeat(500_000) + '/ls', '-p', SECRET, 'db'] }, { maxChars: MAX });
    } finally {
      String.prototype.lastIndexOf = original;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(Math.max(PATH_TAIL, CAP));
  });

  it('pays for the end of the arguments it reads: the budget counts it, so many long arguments are refused, fast', () => {
    // each argument is read twice (its window and its mask) and its end once more: 4808 + 4808 + 4096 characters
    const argv = (n) => ({ argv: Array.from({ length: n }, () => 'z'.repeat(5000) + '/d') });
    expect(maskJevState(argv(250), { maxChars: MAX }).argv).toHaveLength(250);
    const start = performance.now();
    expect(() => maskJevState(argv(350), { maxChars: MAX })).toThrow(new RegExp(`more than ${MAX_STATE_CHARS} characters`));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('maskJevState: a token in the path of a URL is masked like any other', () => {
  const TOKEN = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'; // 36 letters and digits
  it.each([
    [`https://hooks.slack.com/services/T0123/B0123/${TOKEN}`],
    [`GET /api/${TOKEN}/items`],
    [`https://api.example.com/bot${TOKEN}/getMe`],
    [`/${TOKEN}`],
    [`see /srv/app/${TOKEN}/log`],
  ])('%s', (text) => {
    for (const masked of [maskJevState(text), maskJevState({ t: text }).t, maskSecrets(text)]) {
      expect(masked).not.toContain(TOKEN);
      expect(masked).toContain('***');
    }
  });
});

// What a key name can change, key by key, level by level. A key name makes the value under it a secret (at any depth), makes
// a number a counter (a number stays at any depth), and lets an exact UUID through under session_id and sessionId at the top
// of the state. It never lets a string skip a rule of the text mask: every expected value below is written out, not computed
// by the mask, and the secret is also looked for in the JSON of each result.
describe('maskJevState: what a key name can change, by key, depth and parent', () => {
  const UUID_VALUE = '8f14e45f-ceea-4672-8a3e-5e1b6f3d2a10';
  const MIXED = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'; // 36 letters and digits, no prefix
  const SK = 'sk-' + 'a1b2c3d4e5f6'.repeat(2);
  // [label, input value, what it becomes under a key that names nothing secret, the secret that must not survive]
  const VALUES = [
    ['a plain path', '/work/proj/src', '/work/proj/src', null],
    ['a path with a ghp token', '/tmp/' + GHP, '/tmp/ghp_***', GHP],
    ['a path with an sk token', '/tmp/' + SK, '/tmp/sk-***', SK],
    ['a path with a long mixed component', '/tmp/' + MIXED, '/tmp/***', MIXED],
    ['a long mixed token', MIXED, '***', MIXED],
    ['a UUID', UUID_VALUE, '***', UUID_VALUE],
  ];
  // The places of a key, as the keys and indexes from the top of the state down to the object that holds it: its parent
  // is the state itself (depth 0), state.toolInput and state.tool_input (the input of a tool call), an array of
  // objects, or a nested object; depth is the number of steps.
  const PLACES = [
    ['the state', []],
    ['state.toolInput', ['toolInput']],
    ['state.tool_input', ['tool_input']],
    ['state.toolInput.a', ['toolInput', 'a']],
    ['state.toolInput.a.b', ['toolInput', 'a', 'b']],
    ['state.toolInput.items[0]', ['toolInput', 'items', 0]],
    ['state.items[0]', ['items', 0]],
    ['state.items[0].a', ['items', 0, 'a']],
    ['state.candidates[0]', ['candidates', 0]],
    ['state.config', ['config']],
    ['state.config.a', ['config', 'a']],
    ['state.config.a.b', ['config', 'a', 'b']],
  ];
  // The state that has the object `leaf` at the place.
  const at = (place, leaf) => place.reduceRight((inner, step) => (typeof step === 'number' ? [inner] : { [step]: inner }), leaf);

  const cases = (keys, values, expectedFor) => {
    const rows = [];
    for (const key of keys) {
      for (const [valueLabel, input, , secret] of values) {
        for (const [placeLabel, place] of PLACES) {
          rows.push([`${key} = ${valueLabel} in ${placeLabel}`, key, input, place, expectedFor(key, input, place), secret]);
        }
      }
    }
    return rows;
  };

  const check = (_label, key, input, place, expected, secret) => {
    const out = maskJevState(at(place, { [key]: input }));
    expect(out).toEqual(at(place, { [key]: expected }));
    // the one value that is let through on purpose (a UUID under session_id at the top) is its own expected value
    if (secret && expected !== input) expect(JSON.stringify(out)).not.toContain(secret);
  };

  const plainBecomes = new Map(VALUES.map(([, input, becomes]) => [input, becomes]));

  // cwd is masked like any other string everywhere, the top of the state too (a path with a token has the token masked).
  // session_id and sessionId keep an exact UUID at the top of the state only; any other value is masked like any string.
  // The key name `session-id` is no session id key.
  const SESSION_KEYS = ['session_id', 'sessionId'];
  it.each(cases(['cwd', 'session_id', 'sessionId', 'session-id', 'sessionid', 'directory'], VALUES, (key, input, place) => (
    SESSION_KEYS.includes(key) && place.length === 0 && input === UUID_VALUE ? UUID_VALUE : plainBecomes.get(input)
  )))('%s', check);

  // A counter key keeps a number at every place and masks anything else under it, whatever it holds.
  const COUNTER_KEYS = ['tokens', 'totalTokens', 'token_count', 'max_tokens'];
  it.each(cases(COUNTER_KEYS, [['a number', 4096, 4096, null]], () => 4096))('%s', check);
  it.each(cases(COUNTER_KEYS, [...VALUES, ['an array', ['x', GHP], null, GHP], ['an object', { a: GHP }, null, GHP]], () => '***'))('%s', check);

  // A secret key masks its value at every place, a number too.
  it.each(cases(['password', 'api_key', 'accessToken'], [...VALUES, ['a number', 1234, 1234, null]], () => '***'))('%s', check);

  // The bare name "pass" is a secret name in a pair, as it is as a key: the value stands for the same thing at every place.
  it.each(PLACES.flatMap(([label, place]) => VALUES.map(([valueLabel, input, , secret]) => [`${valueLabel} in ${label}`, place, input, secret])))(
    'a pair named pass: %s',
    (_label, place, input, secret) => {
      for (const [shape, expected] of [
        [{ name: 'pass', value: input }, { name: 'pass', value: '***' }],
        [{ key: 'pass', value: input }, { key: 'pass', value: '***' }],
        [['pass', input], ['pass', '***']],
      ]) {
        const out = maskJevState(at(place, { pair: shape }));
        expect(out, JSON.stringify(shape)).toEqual(at(place, { pair: expected }));
        if (secret) expect(JSON.stringify(out)).not.toContain(secret);
      }
    },
  );

  // The one other thing that is let through by shape and not by name (see keepGitHashes): an exact 40 or 64 character hex string.
  it('leaves a git object id at every place, and masks it under a key that names a secret', () => {
    for (const id of ['2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf2', '2bd2a9dbaa4fddce7d93d1ee138cb3c39294bcf22bd2a9dbaa4fddce7d93d1ee']) {
      for (const [, place] of PLACES) {
        expect(maskJevState(at(place, { commit: id, token: id }))).toEqual(at(place, { commit: id, token: '***' }));
      }
    }
  });

  it('reads no id out of a name and value pair or an argument', () => {
    const state = { toolInput: { env: [{ name: 'SESSION', value: UUID_VALUE }, { name: 'session_id', value: UUID_VALUE }], argv: ['run', '--cwd', '/tmp/' + GHP] } };
    expect(maskJevState(state)).toEqual({ toolInput: { env: [{ name: 'SESSION', value: '***' }, { name: 'session_id', value: '***' }], argv: ['run', '--cwd', '/tmp/ghp_***'] } });
  });

  it('is idempotent for every place of cwd and session_id: a second pass changes nothing', () => {
    for (const key of ['cwd', 'session_id']) {
      for (const [, place] of PLACES) {
        for (const [, input] of VALUES) {
          const once = maskJevState(at(place, { [key]: input }));
          expect(maskJevState(once)).toEqual(once);
        }
      }
    }
  });
});

// The order in which what classifies a value is applied: one function (treatment) decides it for the value under a key, in a
// pair of an object, in an array and in a pair of two elements. A label (the name of the value) that names a secret
// replaces the value whole and always wins over a partial argument mode (the credential in part of an element); a counter label
// replaces a string whole too, and a number stays; a partial mode applies only without a label. Every expected value is written out.
describe('maskJevState: the order of the labels and the partial argument modes', () => {
  const S = 'hunter2zzQ';

  it.each([
    [false, undefined, false],
    [false, false, false],
    [false, 'secret', 'secret'],
    [false, 'user', 'user'],
    [false, 'userEquals', 'userEquals'],
    [false, 'secretEquals', 'secretEquals'],
    [false, 'glued', 'glued'],
    ['counter', undefined, 'counter'],
    ['counter', 'secret', 'secret'],
    ['counter', 'user', 'counter'],
    ['counter', 'userEquals', 'counter'],
    ['counter', 'secretEquals', 'counter'],
    ['counter', 'glued', 'counter'],
    ['secret', undefined, 'secret'],
    ['secret', 'secret', 'secret'],
    ['secret', 'user', 'secret'],
    ['secret', 'userEquals', 'secret'],
    ['secret', 'secretEquals', 'secret'],
    ['secret', 'glued', 'secret'],
  ])('label %s, argument mode %s: %s', (label, argument, expected) => {
    expect(treatment(label, argument)).toBe(expected);
  });

  // [what the value is, the value, what it becomes with no label at all (a partial mode, or the text rules)]
  const VALUES = [
    ['a --user argument', `--user=${S}:tail`, `--user=${S}:***`],
    ['a --password argument', `--password=${S}`, '--password=***'],
    ['an --api-key argument', `--api-key=${S}`, '--api-key=***'],
    // no rule of the text mask knows the next four, so they stay without a secret label (the mask removes the shapes it knows and no more)
    ['a user and password with a host', `user:${S}@host`, `user:${S}@host`],
    ['a glued -p without a command', `-p${S}`, `-p${S}`],
    ['a bare value', S, S],
    ['a value with a colon', `${S}:tail`, `${S}:tail`],
  ];
  const LABELS = {
    secret: ['PASSWORD', 'token', 'X-Api-Key', 'Authorization', 'client_secret'],
    counter: ['token_count', 'input_tokens', 'max_tokens'],
    none: ['LOG_LEVEL', 'user', 'curl'],
  };
  // the places where a name stands beside a value: a pair of two elements, in a list too (the shape of an environment), a name and value
  // pair of an object in its three spellings, and the key that holds the value
  const CONTEXTS = {
    'a pair of two elements': (label, value) => [{ t: [label, value] }, (m) => ({ t: [label, m] })],
    'a pair of two elements in a list': (label, value) => [{ t: [[label, value]] }, (m) => ({ t: [[label, m]] })],
    'name and value': (label, value) => [{ name: label, value }, (m) => ({ name: label, value: m })],
    'key and value': (label, value) => [{ key: label, value }, (m) => ({ key: label, value: m })],
    'ParameterKey and ParameterValue': (label, value) => [{ ParameterKey: label, ParameterValue: value }, (m) => ({ ParameterKey: label, ParameterValue: m })],
    'the value under a key': (label, value) => [{ [label]: value }, (m) => ({ [label]: m })],
  };
  const rows = [];
  for (const [kind, labels] of Object.entries(LABELS)) {
    for (const label of labels) {
      for (const [contextName, context] of Object.entries(CONTEXTS)) {
        for (const [valueName, value, unlabeled] of VALUES) {
          rows.push([`${kind} label ${label}: ${valueName} in ${contextName}`, kind, label, contextName, context, value, kind === 'none' ? unlabeled : '***']);
        }
      }
    }
  }

  it.each(rows)('%s', (_name, kind, label, _contextName, context, value, expected) => {
    const [input, expectedFor] = context(label, value);
    const out = maskJevState(input);
    expect(out).toEqual(expectedFor(expected));
    // the secret of a value under a secret or counter label is in no part of the result
    if (kind !== 'none') expect(JSON.stringify(out)).not.toContain(S);
  });

  it('has the grid it says it has', () => {
    // 11 labels x 6 places x 7 values
    expect(rows).toHaveLength(11 * 6 * 7);
  });

  // The partial modes user and glued are not in the grid above: user needs a preceding element that is -u or --user, and glued a
  // preceding command word, which a pair of two elements has as its name. Neither -u nor --user names a secret, so user cannot meet a
  // label; glued can, with a command word that is also a name (the cells with mysql.password below), and the table of treatment
  // above covers every label against every mode.
  it('applies the same partial mode in an array of arguments of any length, with no label', () => {
    for (const [, value, unlabeled] of VALUES) {
      expect(maskJevState({ t: ['run', 'x', value] }).t).toEqual(['run', 'x', unlabeled]);
      expect(maskJevState({ t: [['run', 'x', value]] }).t).toEqual([['run', 'x', unlabeled]]);
    }
  });

  it.each([
    [['-u', `root:${S}`], ['-u', 'root:***']],
    [['--user', `root:${S}`], ['--user', 'root:***']],
    [['mysql', `-p${S}`], ['mysql', '-p***']],
    [['--password', S], ['--password', '***']],
    [['--password', 5], ['--password', '***']],
    [[`--user=root:${S}`, 'x'], ['--user=root:***', 'x']],
    [['mysql', '-p', S], ['mysql', '-p', '***']],
    [['curl', '-u', `root:${S}`], ['curl', '-u', 'root:***']],
    // the first of two elements is a name, whatever it is made of: this one names a secret
    [[`--password=${S}`, 'x'], ['--password=***', '***']],
    // a command word that is also a name: the glued -p of the second element is a partial mode, the name decides over it
    [['mysql.password', `-p${S}`], ['mysql.password', '***']],
    [['mysql.token_count', `-p${S}`], ['mysql.token_count', '***']],
  ])('an array of arguments, the partial modes and the name of a pair: %j', (input, expected) => {
    expect(maskJevState({ a: input }).a).toEqual(expected);
  });

  it('keeps a number under a counter label and under no label, and masks it under a secret label', () => {
    for (const make of Object.values(CONTEXTS)) {
      for (const [label, expected] of [['token_count', 4096], ['LOG_LEVEL', 4096], ['PASSWORD', '***']]) {
        const [input, expectedFor] = make(label, 4096);
        expect(maskJevState(input), `${label}`).toEqual(expectedFor(expected));
      }
    }
  });

  it('masks an array or an object under a counter label whole, and under a secret label', () => {
    for (const label of ['token_count', 'PASSWORD']) {
      expect(maskJevState({ t: [label, [S]] }).t).toEqual([label, '***']);
      expect(maskJevState({ name: label, value: { a: S } })).toEqual({ name: label, value: '***' });
    }
  });

  it('is idempotent for every cell of the grid: a second pass changes nothing', () => {
    for (const [, , , , context, value] of rows) {
      const [input] = context(LABELS.secret[0], value);
      const once = maskJevState(input);
      expect(maskJevState(once)).toEqual(once);
    }
  });
});

// The class of the findings on the cost before the timeout: the work of the mask is the window, whatever the input. Every string is
// read up to its window (maxChars + WINDOW_MARGIN, and LINE_EXTENSION of its tail), a name longer than the window is not read, and all
// the reads of one state are paid for from one budget (MAX_STATE_CHARS).
describe('maskJevState: the cost is the window, not the input', () => {
  const MAX = 200;
  const WORDS = 'the quick brown fox jumps over the lazy dog and runs away from the farm ';
  const repeatTo = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const BIG = 32 * 1024 * 1024;
  const SHAPES = {
    'one line of words': () => ({ prompt: repeatTo(WORDS, BIG) }),
    'one line of path-like text': () => ({ prompt: repeatTo('/srv/app/dir/', BIG) }),
    'one line with a secret path far beyond the cut': () => ({ prompt: 'first line\nnote ' + repeatTo('x ', BIG) + '/home/u/.ssh/id_rsa' }),
    'a long key': () => ({ [repeatTo(WORDS, BIG)]: 'v' }),
    'a long name of a pair': () => ({ name: repeatTo('k', BIG), value: 'v' }),
    'a long first element of a pair of two elements': () => ({ t: [repeatTo('k', BIG), 'v'] }),
    'long arguments of a command': () => ({ argv: ['mysql', repeatTo('a', BIG / 8), '-u', `${repeatTo('b', BIG / 8)}:x`, `--user=${repeatTo('c', BIG / 8)}:y`, `-p${repeatTo('d', BIG / 8)}`] }),
    'a long path of a program': () => ({ argv: [repeatTo('d/', BIG) + 'mysql', '-p', 'hunter2zzQ', 'db'] }),
    'a long argument with no separator before -p': () => ({ argv: [repeatTo('a', BIG), '-p', 'hunter2zzQ', 'db'] }),
    'many long arguments': () => ({ argv: Array.from({ length: 40 }, () => repeatTo('d/', BIG / 40) + 'x') }),
    'long strings at several places': () => ({ a: { b: [repeatTo(WORDS, BIG / 4), repeatTo(WORDS, BIG / 4)] }, c: repeatTo(WORDS, BIG / 4) }),
  };

  it.each(Object.keys(SHAPES))('%s: 32 MiB take milliseconds, not the length of the input', (name) => {
    const state = SHAPES[name]();
    // the best of three runs (the mask does not change its input): a pause of the machine in one run is no cost of the mask
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      maskJevState(state, { maxChars: MAX });
      times.push(performance.now() - start);
    }
    // about 5 ms; the mask without the bound took 0.5 to 2.5 s for these (a linear cost), so this leaves room for a slow machine
    expect(Math.min(...times)).toBeLessThan(150);
  });

  it('hands no rule more than the window of a string and its tail (a structure check, no clock)', () => {
    const seen = [];
    const original = SECRET_PATH.test;
    SECRET_PATH.test = function test(text) {
      seen.push(text.length);
      return original.call(this, text);
    };
    try {
      maskJevState({ prompt: repeatTo(WORDS, 3_000_000), [repeatTo(WORDS, 3_000_000)]: 1, list: [repeatTo('/a/', 3_000_000)] }, { maxChars: MAX });
    } finally {
      delete SECRET_PATH.test;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(MAX + WINDOW_MARGIN + LINE_EXTENSION);
  });

  describe('the last line of a cut text', () => {
    const CUT = MAX + WINDOW_MARGIN;
    const lead = 'first line\necho hunter2 > ';
    const textWithPathAt = (past) => lead + repeatTo('x ', CUT + past - lead.length) + '~/.ssh/id_ed25519\nlast';
    const sentOf = (text) => maskJevState({ t: text }, { maxChars: MAX }).t.slice(0, MAX);

    it('omits the line when its secret path starts within LINE_EXTENSION past the cut', () => {
      for (const past of [1, 100, LINE_EXTENSION - 40]) expect(sentOf(textWithPathAt(past)), `${past}`).toBe('first line\n[line omitted: secret path]');
    });

    it('sends the line when its secret path starts beyond that: nothing of the path is sent, and the rest of the line is not read', () => {
      // the one bound of the mask that is not fail closed (see HOOKS.md): the part of the line that is sent stays, where the mask without a window omits the whole line
      const text = textWithPathAt(LINE_EXTENSION + 200);
      const sent = sentOf(text);
      expect(sent.startsWith('first line\necho hunter2 > x x')).toBe(true);
      expect(SECRET_PATH.test(sent)).toBe(false);
      expect(maskJevState({ t: text }).t).not.toContain('hunter2');
    });
  });

  describe('a name longer than the window', () => {
    const CAP = MAX + WINDOW_MARGIN;
    // one word per two characters: a run of token characters at the cut would be followed to its end, a name with spaces is cut where it is
    const longName = () => repeatTo('k ', CAP + 1);
    const opts = { maxChars: MAX };

    it('is not read and names a secret: the value under a long key is masked and the key is cut', () => {
      const out = maskJevState({ [longName()]: 'plain value', short: 'plain value' }, opts);
      const [first] = Object.keys(out);
      expect(first).toHaveLength(CAP);
      expect(out[first]).toBe('***');
      expect(out.short).toBe('plain value');
      expect(Object.values(maskJevState({ [longName()]: 7 }, opts))).toEqual(['***']);
    });

    it('is the same for the name of a pair and the first of two elements', () => {
      expect(maskJevState({ name: longName(), value: 'plain value' }, opts).value).toBe('***');
      expect(maskJevState({ ParameterKey: longName(), ParameterValue: 'plain value' }, opts).ParameterValue).toBe('***');
      expect(maskJevState({ t: [longName(), 'plain value'] }, opts).t[1]).toBe('***');
      expect(maskJevState({ t: [longName(), 7] }, opts).t[1]).toBe('***');
    });

    it('is classified in full when it fits the window, and without a window whatever its length', () => {
      const fits = repeatTo('k', CAP - 'password'.length) + 'password';
      expect(fits).toHaveLength(CAP);
      expect(maskJevState({ [fits]: 'plain value' }, opts)[fits]).toBe('***');
      const plain = repeatTo('k', CAP);
      expect(maskJevState({ [plain]: 'plain value' }, opts)[plain]).toBe('plain value');
      expect(maskJevState({ t: [plain, 'plain value'] }, opts).t[1]).toBe('plain value');
      expect(maskJevState({ t: [longName(), 'plain value'] }).t[1]).toBe('plain value');
    });

    it('turns a long key that names a secret path in its first window into the marker', () => {
      const key = `/home/u/.ssh/id_rsa ${repeatTo('k', CAP * 3)}`;
      expect(Object.keys(maskJevState({ [key]: 1 }, opts))).toEqual([KEY_OMITTED]);
    });
  });

  describe('the budget of all the reads', () => {
    it('refuses a state of many strings that each fit the window and together need more than MAX_STATE_CHARS, fast', () => {
      const text = repeatTo(WORDS, MAX + WINDOW_MARGIN);
      const state = { a: Array.from({ length: Math.ceil(MAX_STATE_CHARS / (MAX + WINDOW_MARGIN)) + 100 }, () => text) };
      const start = performance.now();
      expect(() => maskJevState(state, { maxChars: MAX })).toThrow(new RegExp(`more than ${MAX_STATE_CHARS} characters`));
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it('accepts the same state without a window (there is no bound to keep when the whole text is wanted), and a few strings with one', () => {
      const text = repeatTo(WORDS, 1000);
      expect(maskJevState({ a: Array.from({ length: 10 }, () => text) }, { maxChars: MAX }).a).toHaveLength(10);
      expect(maskJevState({ a: Array.from({ length: 6000 }, () => text) }).a).toHaveLength(6000);
    });

    it('does not refuse a state because of a large window that the caller asked for', () => {
      const big = 1_200_000;
      const text = repeatTo(WORDS, big - 10_000);
      const out = maskJevState({ a: [text, text, text, text] }, { maxChars: big });
      expect(out.a.map((t) => t.length)).toEqual([text.length, text.length, text.length, text.length]);
    });

    it('refuses more keys or more elements than the node limit before any rule reads them', () => {
      const keys = Object.fromEntries(Array.from({ length: MAX_STATE_NODES + 1 }, (_, i) => [`key${i}`, 1]));
      expect(() => maskJevState(keys, { maxChars: MAX })).toThrow(/nodes/);
      expect(() => maskJevState(new Array(MAX_STATE_NODES + 1).fill('x'), { maxChars: MAX })).toThrow(/nodes/);
      expect(() => maskJevState(new Array(MAX_STATE_NODES + 1).fill('x'))).toThrow(/nodes/);
    });
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
