/**
 * scripts/lib/jev-state-mask.mjs: the mask every Jev point's state goes through before it is sent or logged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { JevStateFieldOmittedError, JevStateMaskError, MAX_STATE_DEPTH, MAX_STATE_NODES, SECRET_PATH, WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

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
    const long = 'a'.repeat(MAX + WINDOW_MARGIN + 100);
    expect(maskJevState({ t: long }, { maxChars: MAX }).t).toHaveLength(MAX + WINDOW_MARGIN);
    expect(maskJevState({ t: long }).t).toHaveLength(long.length);
    const edge = 'a'.repeat(MAX + WINDOW_MARGIN);
    expect(maskJevState({ t: edge }, { maxChars: MAX }).t).toBe(edge);
  });

  it('hands maskSecrets at most maxChars plus the margin characters of a string (a structure check, no clock)', () => {
    const long = ('password ' + 'x'.repeat(30)).repeat(20_000);
    const out = maskJevState({ t: long }, { maxChars: MAX }).t;
    expect(out.length).toBeLessThanOrEqual(MAX + WINDOW_MARGIN);
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
    const out = maskJevState({ ['k'.repeat(5000)]: 1 }, { maxChars: MAX });
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

  it('masks the unterminated first parts of a JWT whose last part is beyond the margin', () => {
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
