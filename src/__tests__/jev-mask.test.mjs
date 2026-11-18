/* global performance */
/**
 * Tests for maskSecrets in scripts/lib/jev-mask.mjs and its copy in scripts/lib/shell-checks.mjs: time linear in the
 * text length on the shapes that used to take seconds (one rule rescanning the same text from every start), and the
 * masking those rules keep.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { maskSecrets as shellChecksMaskSecrets } from '../../scripts/lib/shell-checks.mjs';

const readSource = (file) => readFileSync(new URL(`../../scripts/lib/${file}`, import.meta.url), 'utf8');
// The constants and the function that read the names and the pairs, from the field names to the end of pairParts.
const sharedRules = (source) => {
  const from = source.indexOf('// Field names in other languages.');
  const named = source.indexOf('function pairParts(', from);
  return source.slice(from, source.indexOf('\n}\n', named) + 3);
};
const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

// The field names in other languages, and each of their forms: precomposed, decomposed (base letter and combining mark), plain ASCII,
// upper case, and with every non-ASCII character as a JSON `\uXXXX` escape.
const LOCAL_FIELD_NAMES = ['hasło', 'klucz', 'sekret', 'passwort', 'kennwort', 'contraseña'];
const escapeNonAscii = (text) => [...text].map((ch) => (ch.charCodeAt(0) > 127 ? String.raw`\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch)).join('');
const nameForms = (name) => {
  const composed = name.normalize('NFC');
  const decomposed = composed.normalize('NFD');
  return [...new Set([
    composed,
    decomposed,
    composed.toUpperCase(),
    decomposed.toUpperCase(),
    decomposed.replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l'),
    escapeNonAscii(composed),
    escapeNonAscii(decomposed),
    escapeNonAscii(composed.toUpperCase()),
    escapeNonAscii(decomposed.toUpperCase()),
  ])];
};

// Keys that start with something a word rule masks (a credential-shaped prefix), with what that rule leaves of such a key: the field
// rules read the key from the text as it was, so the value under it is masked whatever the prefix rule makes of the key itself.
// [label, the prefix, what joins it to the name, the key as the prefix rule leaves it, only in jev-mask.mjs]
const PREFIX_KEYS = [
  ['sk-', 'sk-proj-abcdefghijklm', '_', (k) => k.replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/, '$1***')],
  ['sk-ant-', 'sk-ant-abcdefghijklm', '_', (k) => k.replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/, '$1***')],
  ['ghp_', 'ghp_abcdefghijklmnop', '_', (k) => k.replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/, '$1***')],
  ['github_pat_', 'github_pat_abcdefghijklmnop', '_', (k) => k.replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/, '$1***')],
  ['glpat-', 'glpat-abcdefghijklmnop', '_', (k) => k.replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/, '$1***')],
  ['xoxb-', 'xoxb-abcdefghijklm', '-', (k) => k.replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/, '$1***')],
  ['AKIA', 'AKIAIOSFODNN7EXAMPLE', '-', (k) => k.replace(/\bAKIA[0-9A-Z]{16}\b/, 'AKIA***')],
  ['JWT', 'eyJabcdefgh.abcdefgh.abcdefgh', '_', (k) => k.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'eyJ***')],
  ['bearer', 'bearer abcdefghijklm', '-', (k) => k.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/i, '$1***')],
  ['long mixed string', 'abcdefghijklmnopqrstuvwxyz012345', '_', (k) => k.replace(/(^|[^A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/, '$1***')],
  ['hf_', 'hf_abcdefghijklmnopqrst', '_', (k) => k.replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/, '$1***'), true],
  ['sk_live_', 'sk_live_abcdefghijklmnopqrst', '_', (k) => k.replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/, '$1***'), true],
];
// The kinds whose rule reads `=` (and the letters after it) as part of the token: what stays in front of it, and the characters it reads.
const WORD_RULES = { bearer: ['bearer ', /[A-Za-z0-9._~+/=-]/, 'bearer *** next'], 'long mixed string': ['', /[A-Za-z0-9+_-]/, '****** next'] };
const serializeOnce = (text) => JSON.stringify(text).slice(1, -1);
const serializeTwice = (text) => serializeOnce(serializeOnce(text));
const FORMS = [['raw', (t) => t], ['serialized once', serializeOnce], ['serialized twice', serializeTwice]];

// Secret-bearing constructs that a rule reads by their first word (a marker), and ways to wrap them as the value of a named field.
const CONTEXTS = [
  'Cookie: session=hunter2zz',
  'Set-Cookie: sid=hunter2zz; Path=/',
  'Authorization: Basic aHVudGVyMnp6',
  'Authorization: Bearer aHVudGVyMnp6',
  'Proxy-Authorization: Basic aHVudGVyMnp6',
  'bearer aHVudGVyMnp6',
  'mysql -phunter2zz db',
  'mariadb -u root -phunter2zz',
  'sshpass -p hunter2zz ssh host',
  'curl -u alice:hunter2zz x',
  'x-api-key: hunter2zz',
  'DB_PASSWORD: hunter2zz',
  'API_KEY=hunter2zz',
];
const WRAPPERS = [
  (v) => `secret='${v}'`,
  (v) => `password="${v}"`,
  (v) => `token: '${v}'`,
  (v) => `{"secret": "${v}"}`,
  (v) => `hasło='${v}'`,
  (v) => `sekret: "${v}"`,
  (v) => String.raw`secret=\"${v}\"`,
  (v) => JSON.stringify({ command: `export secret='${v}'` }),
];

describe.each([
  ['jev-mask.mjs', maskSecrets],
  ['shell-checks.mjs', shellChecksMaskSecrets],
])('maskSecrets of %s', (_file, mask) => {
  it('masks a text of 100 000 and of 1 000 000 characters in at most 1 ms per 1000 characters, also when one rule matches from every word', () => {
    const shapes = {
      'Authorization: and only spaces': (n) => 'authorization:' + ' '.repeat(n - 14),
      'mysql words without -p': (n) => repeat('mysql ', n),
      'mariadb words without -p': (n) => repeat('mariadb ', n),
      'eyJ- without dots': (n) => repeat('eyJ-', n),
      'password without =': (n) => repeat('password', n),
      'PASSWORD without =': (n) => repeat('PASSWORD', n),
      'KEY without =': (n) => repeat('KEY', n),
      'A_KEY_ without =': (n) => repeat('A_KEY_', n),
      'api_key without =': (n) => repeat('api_key', n),
      'token without =': (n) => repeat('token', n),
      'secret without =': (n) => repeat('secret', n),
      'pass without =': (n) => repeat('pass', n),
      'pwd without =': (n) => repeat('pwd', n),
      'credentials without =': (n) => repeat('credentials', n),
      'hasło without =': (n) => repeat('hasło', n),
      'pair names without a value': (n) => repeat('{"Name":"DB_PASSWORD","a":"b","c":1,', n),
      'pair values without a name': (n) => repeat('"Value":"x","a":"b","c":1,', n),
      'pair values with long strings': (n) => repeat('"Value":"' + 'a'.repeat(300) + '","x":"', n),
      'pair names with long strings': (n) => repeat('"Name":"' + 'a'.repeat(300) + '","x":"' + 'b'.repeat(300) + '",', n),
      'pair fields in one object, masked': (n) => '{' + repeat('"Name":"A_TOKEN","aValue":"x",', n),
      'pair keys and escaped backslashes': (n) => repeat('"k":"\\\\', n),
      'escaped backslashes and quotes': (n) => repeat('\\\\"', n),
      'shell-escaped pair fields, masked': (n) => repeat(String.raw`\\\"Name\\\":\\\"A_KEY\\\",\\\"Value\\\":\\\"x\\\",`, n),
      'pair names with backslash runs': (n) => '{"Name":"' + '\\'.repeat(n) + 'x","Value":"y"}',
      'pair values with whitespace tails, masked': (n) => '{"Name":"DB_PASSWORD","Value":"' + ' '.repeat(n),
      'premature closing quotes before a newline': (n) => repeat('"k":"abc', n) + '\nz',
      'BEGIN with only spaces': (n) => '-----BEGIN' + ' '.repeat(n),
      'BEGIN words with repeated spaces': (n) => repeat('-----BEGIN  A1   B2  ', n),
      'pair names alone': (n) => repeat('"name":"a",', n),
      'a pair value with an opening quote': (n) => repeat('"Name":"A_TOKEN","Value":"', n),
      '4 hyphens and BEGIN words': (n) => repeat('---- BEGIN SSH2 ENCRYPTED ', n),
      'BEGIN PRIVATE without KEY': (n) => repeat('-----BEGIN A1 B2 PRIVATE ', n),
      'contraseña without =': (n) => repeat('contraseña', n),
      'password and serialized newlines without a separator': (n) => 'password' + String.raw`\n`.repeat(n / 2),
      'password and serialized vertical tabs without a separator': (n) => 'password' + String.raw`\u000b`.repeat(n / 6),
      'password: and serialized newlines, masked': (n) => 'password:' + String.raw`\n`.repeat(n / 2),
      'password: a: and spaces, masked': (n) => 'password: a:' + ' '.repeat(n),
      'password: a and spaces before an equals sign, masked': (n) => 'password: a' + ' '.repeat(n) + '= x',
      'hasło and a backslash run': (n) => 'hasło' + '\\'.repeat(n),
      'hasło and serialized tabs and backslashes': (n) => 'hasło' + repeat(String.raw`\\\t\\\\`, n),
      'hasło and serialized newlines before a colon, masked': (n) => 'hasło' + String.raw`\n`.repeat(n / 2) + ':',
      'hasło= and a run of escaped quotes, masked': (n) => 'hasło=' + String.raw`\"`.repeat(n / 2),
      'serialized newlines between names and separators, masked': (n) => repeat(String.raw`password\n\n:\n\n"x"\n`, n),
      'label words and spaces, masked': (n) => repeat('password: a: ', n),
      'pair names and serialized vertical tabs': (n) => '"a"' + String.raw`\u000b`.repeat(n / 6),
      'pair names and serialized form feeds, masked': (n) => '{"Name":"DB_PASSWORD"' + String.raw`\f`.repeat(n / 2) + ',"Value":"x"}',
      'BEGIN and one long word': (n) => '-----BEGIN ' + 'A'.repeat(n),
      'a key of escapes without a separator': (n) => repeat(String.raw`\u0061`, n),
      'words with an escape and no separator': (n) => repeat(String.raw`p\u0061ss `, n),
      'escaped keys, separators and values, masked': (n) => repeat(String.raw`p\u0061ssword:x `, n),
      'a long word and then an escape': (n) => 'a'.repeat(n) + String.raw`\u0061`,
      'a word and then a backslash run': (n) => 'abc' + '\\'.repeat(n) + 'x',
      'whitespace escapes between letters': (n) => repeat(String.raw`p\u0020`, n),
      'BEGIN with long words glued to PRIVATE': (n) => repeat('-----BEGIN AAAAAAAAAAAAAAAAPRIVATE ', n),
      'non-ASCII letters without a separator': (n) => repeat('ł', n),
      'non-ASCII letters and escapes without a separator': (n) => repeat('ł\\u0061', n),
      'a long non-ASCII word and then an escape': (n) => 'ł'.repeat(n) + String.raw`\u0061`,
      'non-ASCII escaped keys, separators and values, masked': (n) => repeat(String.raw`hasł\u006f:x `, n),
      'non-ASCII pair prefixes, masked': (n) => '{' + repeat('"paramètre-name":"A_TOKEN","paramètre-value":"x",', n),
      'non-ASCII pair names alone': (n) => repeat('"paramètre-name":"a",', n),
      'a word ending in padding and assignments, masked': (n) => repeat("API_KEY=YWJjZA== DB_PASSWORD='x' ", n),
      'words ending in one equals sign and labels, masked': (n) => repeat('KEY=a= b: ', n),
      'labels and quoted assignments, masked': (n) => repeat("secret: a: b='", n),
      'escaped keys under a localized parent, masked': (n) => repeat('hasło:\n  "p\\u0061ssword": "x"\n', n),
      'unterminated pair values with brackets, masked': (n) => '{"Name":"DB_PASSWORD","Value":"' + repeat('a}b]', n),
      'long keys before a localized word, masked': (n) => repeat('service_01234567890123456789_klucz:x ', n),
      'a label and one long word, masked': (n) => 'KEY=: ' + 'x'.repeat(n),
      'labels and words that hold a keyword, masked': (n) => repeat('KEY=: xxxxxxxxxxKEYxxxxxxxxx ', n),
      'a label and a long word that holds a keyword and a quote, masked': (n) => 'KEY=: ' + 'x'.repeat(n) + 'KEY"',
      // One long word that holds a keyword over and over: the rule that decides whether the next word is a key reads it once.
      'a label and a word of repeated localized keywords, masked': (n) => 'KEY=: ' + repeat('klucz', n),
      'a label and a word of repeated PASS, masked': (n) => 'KEY=: ' + repeat('PASS', n),
      'a label and a run of backslashes, masked': (n) => 'KEY=: ' + '\\'.repeat(n),
      'a label, a word and a word of repeated keywords, masked': (n) => 'secret=a: ' + repeat('klucz', n),
      'a serialized label, a word and a word of repeated keywords, masked': (n) => String.raw`secret=\"a: ` + repeat('klucz', n),
      'a label and a word of repeated keywords with escapes, masked': (n) => 'KEY=: ' + repeat(String.raw`\u0061klucz`, n),
      'a localized label and a word of repeated keywords, masked': (n) => 'hasło=: ' + repeat('klucz', n),
      'a localized label, a word and a word of repeated PASS, masked': (n) => 'klucz: a: ' + repeat('PASS', n),
      'a localized label and a run of backslashes, masked': (n) => 'sekret=: ' + '\\'.repeat(n),
      'a serialized localized label and a word of repeated keywords, masked': (n) => String.raw`hasło=\"a: ` + repeat('klucz', n),
      // The class of the closing characters inside quotes and of the forms of a name: each is read once.
      'a name and a run of backslashes': (n) => 'X_KEY' + '\\'.repeat(n),
      'a name and serialized quotes, masked': (n) => 'X_KEY' + String.raw`\"`.repeat(n / 2) + ':x',
      'a quoted value with separators, masked': (n) => "KEY='" + repeat('a;b|c)', n),
      'a quoted value of a localized name with commas and braces, masked': (n) => 'hasło="' + repeat('a,b}c', n),
      'quoted values with brackets and commas, masked': (n) => repeat('hasło="a},b" klucz=\'a;b\' ', n),
      'an open pair value with brackets and commas, masked': (n) => '{"Name":"DB_PASSWORD","Value":"' + repeat('},', n),
      'an open pair value with quotes, brackets and commas, masked': (n) => '{"Name":"DB_PASSWORD","Value":"' + repeat('"x},', n),
      'an open serialized pair value with brackets and commas, masked': (n) => String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"` + repeat('},', n),
      'pair values opened and cut by brackets, masked': (n) => repeat('{"Name":"DB_PASSWORD","Value":"a}', n),
      'a decomposed name and combining marks': (n) => 'contrasen' + '\u0303'.repeat(n),
      'decomposed names without a separator': (n) => repeat('contrasen\u0303a', n),
      'a label and a word of repeated decomposed names, masked': (n) => 'KEY=: ' + repeat('contrasen\u0303a', n),
      'a padded assignment and words of decomposed names, masked': (n) => repeat('API_KEY=YWJjZA== contrasen\u0303a=x ', n),
      'a quote and spaces, masked': (n) => 'password="' + ' '.repeat(n),
      'misread closes before brackets, masked': (n) => '{"Name":"DB_PASSWORD","Value":"abc"' + repeat('x\\"},', n),
      'misread closes before brackets after backslash runs, masked': (n) => '{"Name":"DB_PASSWORD","Value":"abc"d' + repeat('\\\\\\\\"},', n),
      'serialized misread closes before brackets, masked': (n) => String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"` + repeat('x\\\\\\"},', n),
      // The class of a key read whole: a quoted key with punctuation, spaces or escapes, an apostrophe key, a key after a whitespace escape.
      'escaped keys that name a secret, one after another, masked': (n) => repeat(String.raw`KEY\u0079:`, n),
      'localized escaped keys one after another, masked': (n) => repeat(String.raw`hasło\u0079:`, n),
      'apostrophe keys that name a secret, one after another, masked': (n) => repeat("'password':", n),
      'quoted keys with punctuation, masked': (n) => repeat('"a:b:password":"x",', n),
      'one long quoted key that names a secret, masked': (n) => '{"' + repeat('a:', n) + 'password":"x"}',
      'one long quoted key that is never closed': (n) => '{"' + repeat('a b ', n),
      'one long quoted key of escapes, masked': (n) => '{"' + repeat(String.raw`pa\u0020`, n) + 'password":"x"}',
      'a long quoted key of backslashes': (n) => '{"' + '\\'.repeat(n) + '":"x"}',
      'escaped quotes in a key, masked': (n) => '{"' + repeat('a\\"b', n) + 'password":"x"}',
      'deeply serialized quoted keys, masked': (n) => repeat(String.raw`\\\"a:password\\\":\\\"x\\\",`, n),
      'quoted keys of repeated secret words, masked': (n) => repeat('"passwordtokenkey":"x",', n),
      // The key of a pair field read whole, whatever stands in front of its selector, and the escapes that end a key.
      'pair fields with namespaced keys, masked': (n) => '{' + repeat('"ns:name":"A_TOKEN","ns:value":"x",', n),
      'serialized pair fields with namespaced keys, masked': (n) => repeat(String.raw`\"ns:name\":\"A_TOKEN\",\"ns:value\":\"x\",`, n),
      'pair fields with keys of spaces and slashes, masked': (n) => '{' + repeat('"a b/name":"A_TOKEN","a b/value":"x",', n),
      'two long pair keys of punctuation before the selector, masked': (n) => {
        const prefix = repeat('!: / ', n / 2);
        return `{"${prefix}name":"A_TOKEN","${prefix}value":"x"}`;
      },
      'a pair key of punctuation before the selector, without its pair': (n) => '{"' + repeat('!: / ', n) + 'name":"A_TOKEN","value":"x"}',
      'a key that ends in many serialized line breaks, masked': (n) => '{"password' + String.raw`\n`.repeat(n / 2) + '":"x"}',
      'a key that ends in escaped backslashes and letters, masked': (n) => '{"password' + String.raw`\\\\n`.repeat(n / 5) + '":"x"}',
      'a key of many serialized tabs, masked': (n) => '{"password' + String.raw`\tx`.repeat(n / 3) + 'token":"x"}',
      'serialized tabs before escaped keys, masked': (n) => repeat(String.raw`\tp\u0061ssword=x `, n),
      'serialized tabs before escaped keys without a separator': (n) => repeat(String.raw`\tp\u0061ss`, n),
      'serialized plain keys that name a secret, masked': (n) => repeat(String.raw`{\"X_KEY\":\"x\"},`, n),
      'apostrophe keys': (n) => repeat("'a b': ", n),
      'apostrophe keys, masked': (n) => repeat(String.raw`'m\u0079:p\u0061ssword': 'x' `, n),
      'an apostrophe and a long run': (n) => "'" + 'a'.repeat(n),
      'apostrophes in prose': (n) => repeat("don't it's ", n),
      'apostrophes and spaces': (n) => repeat("' ", n),
      'many assignments, masked': (n) => repeat('password=x ', n),
      'whitespace escapes before escaped keys, masked': (n) => repeat(String.raw`my\u0020p\u0061ssword=x `, n),
      'a backslash run before a whitespace escape, masked': (n) => '\\'.repeat(n) + String.raw`u0020password=x`,
      'whitespace escapes without a key': (n) => repeat(String.raw`\u0020`, n),
      'a localized label and a run of backslashes before a quote, masked': (n) => 'hasło=' + '\\'.repeat(n) + '"',
      'a serialized label and a run of backslashes before a quote, masked': (n) => String.raw`\"hasło\":\"a` + '\\'.repeat(n) + '"',
    };
    for (const n of [100_000, 1_000_000]) {
      for (const [name, make] of Object.entries(shapes)) {
        const text = make(n);
        // The fastest of up to three runs, in the smaller of the wall time and the CPU time of the run: a busy runner (other test files
        // on the same cores) stretches the wall time and not the CPU time, and the threads of the garbage collector stretch the CPU time
        // and not the wall time.
        let best = Infinity;
        for (let run = 0; run < 3 && best >= n / 1000; run++) {
          const t0 = performance.now();
          const cpu0 = process.cpuUsage();
          const out = mask(text);
          const cpu = process.cpuUsage(cpu0);
          // The shapes named quote or masked are masked (their values are read); the others pass unchanged.
          if (!/quote|masked/.test(name)) expect(out).toBe(text);
          best = Math.min(best, performance.now() - t0, (cpu.user + cpu.system) / 1000);
        }
        expect(best, `${name}, ${n} characters: ${Math.round(best)} ms`).toBeLessThan(n / 1000);
      }
    }
  }, 600_000);

  it('keeps what the Authorization, mysql, JWT and KEY= rules mask', () => {
    const cases = [
      ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer ***'],
      ['Proxy-Authorization:   token   xyz', 'Proxy-Authorization:   token   ***'],
      ['authorization:\tbearerXYZ', 'authorization:\tbearer***'],
      ['authorization: basic', 'authorization: ***'],
      ['Authorization: "quoted"', 'Authorization: "quoted"'],
      ['mysql -uroot -pS3cret db', 'mysql -uroot -p*** db'],
      ['mysql -p"quoted" -pSecond', 'mysql -p"quoted" -p***'],
      ['mysql db\n-pS3cret', 'mysql db\n-p***'],
      ['mysql a\nmysql -pB', 'mysql a\nmysql -p***'],
      ['mysql db; echo -pX', 'mysql db; echo -pX'],
      ['mysql a | mysql -pB', 'mysql a | mysql -p***'],
      ['mysql mysql -pX', 'mysql mysql -p***'],
      ['mysqldump -pA db && mysql -pB', 'mysqldump -p*** db && mysql -p***'],
      ['mysqladmin -pB ping', 'mysqladmin -p*** ping'],
      ['mariadb -u r -pB', 'mariadb -u r -p***'],
      ['eyJaaaaaaaa.bbbbbbbb.cccccccc', 'eyJ***'],
      ['id=eyJ-eyJaaaaaaaa.bbbbbbbb.cccccccc!', 'id=eyJ***!'],
      ['eyJaa.eyJbbbbbbbb.cccccccc.dddddddd', 'eyJaa.eyJ***'],
      ['eyJaaaaaaaa.bbbbbbbb', 'eyJaaaaaaaa.bbbbbbbb'],
      ['eyJaaaaaaaa.bbbbbbbb.cc', 'eyJaaaaaaaa.bbbbbbbb.cc'],
      ['DB_PASSWORD=hunter2', 'DB_PASSWORD=***'],
      ['db_pass: x', 'db_pass: ***'],
      ['my_pwd=abc', 'my_pwd=***'],
      ['x=PASSWORD=abc', 'x=PASSWORD=***'],
      ['passwordpassword=1', 'passwordpassword=***'],
      ['export GITHUB_TOKEN="abc"', 'export GITHUB_TOKEN="***"'],
      ["cfg['client_secret'] = 'v1'", "cfg['client_secret'] = '***'"],
      ['KEY KEY: v', 'KEY KEY: ***'],
      ['name=value', 'name=value'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
  });

  it('masks PEM, PGP and SSH2 private key blocks, with 4 or 5 hyphens, and leaves other BEGIN lines', () => {
    const body = 'bGluZTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w\nbGluZTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w';
    const keys = [
      ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'],
      ['-----BEGIN RSA  PRIVATE KEY-----', '-----END RSA  PRIVATE KEY-----'],
      ['-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
      ['-----BEGIN RSAPRIVATE KEY-----', '-----END RSAPRIVATE KEY-----'],
      ['-----BEGIN PGP PRIVATE KEY BLOCK-----\n', '=abCD\n-----END PGP PRIVATE KEY BLOCK-----'],
      ['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nProc-Type: 4,ENCRYPTED', '---- END SSH2 ENCRYPTED PRIVATE KEY ----'],
    ];
    for (const [begin, end] of keys) {
      for (const text of [`before\n${begin}\n${body}\n${end}\nafter`, `before\n${begin}\n${body}`]) {
        const out = mask(text);
        expect({ text, out: out.includes('bGluZTEy') }).toEqual({ text, out: false });
        expect(out.startsWith('before\n' + begin.split('\n')[0])).toBe(true);
      }
    }
    const pair = '{"Name":"DB_KEY","Value":"-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----"}';
    expect(mask(pair).includes('bGluZTEy')).toBe(false);
    // A body that no other rule masks (short, one word), and a type word glued to PRIVATE, as the rule before it also read.
    for (const type of ['', 'RSA ', 'RSA', 'OPENSSH ']) {
      const text = `-----BEGIN ${type}PRIVATE KEY-----\nhunter2zz\n-----END ${type}PRIVATE KEY-----`;
      expect({ text, left: mask(text).includes('hunter2zz') }).toEqual({ text, left: false });
    }
    for (const text of ['-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', '-----BEGIN CERTIFICATE-----\nabc', '---- BEGIN SSH2 PUBLIC KEY ----\nabc']) {
      expect(mask(text)).toBe(text);
    }
  });

  it('masks the value of a name/value pair whose name is a secret, and leaves other pairs', () => {
    const cases = [
      ['{"Name":"DB_PASSWORD","Value":"hunter2zz"}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"/prod/db","Type":"SecureString","Value":"s3cr3tVal"}', '{"Name":"/prod/db","Type":"SecureString","Value":"***"}'],
      ['{"Value":"s3cr3tVal","Name":"api_key"}', '{"Value":"***","Name":"api_key"}'],
      ['{"Value": "two words", "Type": "SecureString", "Name": "/p"}', '{"Value": "***", "Type": "SecureString", "Name": "/p"}'],
      ['[{"Name":"A_TOKEN","Value":"t0k3n"},{"Name":"REGION","Value":"eu-west-1"}]', '[{"Name":"A_TOKEN","Value":"***"},{"Name":"REGION","Value":"eu-west-1"}]'],
      ['{"Name":"A_TOKEN","Value":"***"}', '{"Name":"A_TOKEN","Value":"***"}'],
      ['{"Name":"A_TOKEN","aValue":"hunter2zz"}', '{"Name":"A_TOKEN","aValue":"***"}'],
      ['{"aValue":"hunter2zz","Name":"A_TOKEN"}', '{"aValue":"***","Name":"A_TOKEN"}'],
      ['{"Name":"A_TOKEN","aName":"plain","aValue":"public"}', '{"Name":"A_TOKEN","aName":"plain","aValue":"public"}'],
      ['{"Name":"REGION","aValue":"public"}', '{"Name":"REGION","aValue":"public"}'],
      ['{"N\\u0061me":"DB_PASSWORD","Value":"hunter2zz"}', '{"N\\u0061me":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","V\\u0061lue":"hunter2zz"}', '{"Name":"DB_PASSWORD","V\\u0061lue":"***"}'],
      [String.raw`{\"N\\u0061me\":\"DB_PASSWORD\",\"Value\":\"hunter2zz\"}`, String.raw`{\"N\\u0061me\":\"DB_PASSWORD\",\"Value\":\"***\"}`],
      ['{"parameter-name":"DB_PASSWORD","parameter-value":"hunter2zz"}', '{"parameter-name":"DB_PASSWORD","parameter-value":"***"}'],
      [String.raw`{\"parameter-name\":\"DB_PASSWORD\",\"parameter-value\":\"hunter2zz\"}`, String.raw`{\"parameter-name\":\"DB_PASSWORD\",\"parameter-value\":\"***\"}`],
      ['{"a.name":"DB_PASSWORD","a.value":"hunter2zz","b.value":"public"}', '{"a.name":"DB_PASSWORD","a.value":"***","b.value":"public"}'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\n  \"Value\": \"hunter2zz\"\n}`, String.raw`{\"Name\":\"DB_PASSWORD\",\n  \"Value\": \"***\"\n}`],
      [String.raw`{"Name"\n:\n"DB_PASSWORD",\r\n"Value"\t:\t"hunter2zz"}`, String.raw`{"Name"\n:\n"DB_PASSWORD",\r\n"Value"\t:\t"***"}`],
      ['{"k":"abc"z\n"Name":"DB_PASSWORD","Value":"x"}', '{"k":"abc"z\n"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"Value":"abc"def ghi","Name":"DB_PASSWORD"}', '{"Value":"***","Name":"DB_PASSWORD"}'],
      [String.raw`{\"Value\":\"abc\"def ghi\",\"Name\":\"DB_PASSWORD\"}`, String.raw`{\"Value\":\"***\",\"Name\":\"DB_PASSWORD\"}`],
      ['{"Name":"DB_PASSWORD","Value":"abc"def ghi"}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"def ghi\"}`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"}`],
      ['{"Name":"DB_PASS","Value":"hunter2zz"}', '{"Name":"DB_PASS","Value":"***"}'],
      ['{"Name":"DB_PASS\\u0057ORD","Value":"hunter2zz"}', '{"Name":"DB_PASS\\u0057ORD","Value":"***"}'],
      [String.raw`{\"Name\":\"DB_PASS\\u0057ORD\",\"Value\":\"hunter2zz\"}`, String.raw`{\"Name\":\"DB_PASS\\u0057ORD\",\"Value\":\"***\"}`],
      ['{"Name":"\\u0044B_\\u004bEY","Value":"hunter2zz"}', '{"Name":"\\u0044B_\\u004bEY","Value":"***"}'],
      [String.raw`curl -d \"{\\\"Name\\\":\\\"DB_PASSWORD\\\",\\\"Value\\\":\\\"hunter2zz\\\"}\" x`, String.raw`curl -d \"{\\\"Name\\\":\\\"DB_PASSWORD\\\",\\\"Value\\\":\\\"***\\\"}\" x`],
      ['{"oldName":"REGION","newName":"DB_PASSWORD","oldValue":"public","newValue":"secretactual"}', '{"oldName":"REGION","newName":"DB_PASSWORD","oldValue":"public","newValue":"***"}'],
      ['{"oldValue":"public","newValue":"secretactual","oldName":"REGION","newName":"DB_PASSWORD"}', '{"oldValue":"public","newValue":"***","oldName":"REGION","newName":"DB_PASSWORD"}'],
      ['{"Name":"DB_PASSWORD","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"Value":"hunter2zz"}', '{"Name":"DB_PASSWORD","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"Value":"***"}'],
      ['{"Value":"hunter2zz","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"Name":"DB_PASSWORD"}', '{"Value":"***","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"Name":"DB_PASSWORD"}'],
      ['{"Name":"A_TOKEN","Meta":{"k":"v"},"Value":"hunter2zz"}', '{"Name":"A_TOKEN","Meta":{"k":"v"},"Value":"hunter2zz"}'],
      ['{"command":"aws ssm put-parameter --cli-input-json \'{\\"Name\\":\\"DB_PASSWORD\\",\\"Value\\":\\"hunter2zz\\"}\'"}', '{"command":"aws ssm put-parameter --cli-input-json \'{\\"Name\\":\\"DB_PASSWORD\\",\\"Value\\":\\"***\\"}\'"}'],
      ['{\\"Name\\":\\"/prod/db\\",\\"Type\\":\\"SecureString\\",\\"Value\\":\\"a b\\\\\\"c\\"}', '{\\"Name\\":\\"/prod/db\\",\\"Type\\":\\"SecureString\\",\\"Value\\":\\"***\\"}'],
      ['{"Name":"DB_PASSWORD","Value":"' + 'A'.repeat(4001) + '"}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Value":"' + 'A'.repeat(4001), '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"' + 'x'.repeat(300) + '_PASSWORD","Value":"hunter2zz"}', '{"Name":"' + 'x'.repeat(300) + '_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Description":"' + 'd'.repeat(500) + '","Value":"hunter2zz"}', '{"Name":"DB_PASSWORD","Description":"' + 'd'.repeat(500) + '","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Value":"a \\"quoted\\" word"}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"oldValue":"public","oldName":"REGION","newValue":"secretactual","newName":"DB_PASSWORD"}', '{"oldValue":"public","oldName":"REGION","newValue":"***","newName":"DB_PASSWORD"}'],
      ['{"oldName":"DB_PASSWORD","oldValue":"secretactual","newName":"REGION","newValue":"public"}', '{"oldName":"DB_PASSWORD","oldValue":"***","newName":"REGION","newValue":"public"}'],
      ['{"Value":"secretactual","Type":"SecureString","Name":"/p"},{"Value":"public","Name":"REGION"}', '{"Value":"***","Type":"SecureString","Name":"/p"},{"Value":"public","Name":"REGION"}'],
      ['{"Name":"/prod/db","Type":"String","Value":"plain"}', '{"Name":"/prod/db","Type":"String","Value":"plain"}'],
      ['{"Name":"REGION","Value":"eu-west-1"}', '{"Name":"REGION","Value":"eu-west-1"}'],
      ['{"Name":"DB_PASSWORD","Value":123456}', '{"Name":"DB_PASSWORD","Value":***}'],
      ['{"Value":123456,"Name":"DB_PASSWORD"}', '{"Value":***,"Name":"DB_PASSWORD"}'],
      ['{"Name":"DB_PASSWORD","Value":true,"x":1}', '{"Name":"DB_PASSWORD","Value":***,"x":1}'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":123456}`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":***}`],
      [String.raw`{\"Value\":123456,\"Name\":\"DB_PASSWORD\"}`, String.raw`{\"Value\":***,\"Name\":\"DB_PASSWORD\"}`],
      ['{"Name":"REGION","Value":123456}', '{"Name":"REGION","Value":123456}'],
      ['{"Name":"hasło","Value":"hunter2zz"}', '{"Name":"hasło","Value":"***"}'],
      ['{"Name":"has\\u0142o","Value":"hunter2zz"}', '{"Name":"has\\u0142o","Value":"***"}'],
      ['{"Name":"KLUCZ_API","Value":"hunter2zz"}', '{"Name":"KLUCZ_API","Value":"***"}'],
      ['{"Name":"contraseña","Value":"hunter2zz"}', '{"Name":"contraseña","Value":"***"}'],
      ['{"Name":"contrasen\\u0303a","Value":"hunter2zz"}', '{"Name":"contrasen\\u0303a","Value":"***"}'],
      ['{"Value":"hunter2zz","Name":"sekret"}', '{"Value":"***","Name":"sekret"}'],
      [String.raw`{\"Name\":\"kennwort\",\"Value\":\"hunter2zz\"}`, String.raw`{\"Name\":\"kennwort\",\"Value\":\"***\"}`],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // The same pair with the delimiters escaped at higher depths (JSON string, shell-escaped, and so on up to 255 backslashes).
    for (const depth of [1, 2, 3, 4, 5, 8]) {
      const q = '\\'.repeat(2 ** depth - 1) + '"';
      const pair = (value) => `{${q}Name${q}:${q}DB_PASSWORD${q},${q}Value${q}:${q}${value}${q}}`;
      expect({ depth, out: mask(pair('hunter2zz')) }).toEqual({ depth, out: pair('***') });
      // The value is a number: no quotes around it, so no quotes are put back.
      const bare = (value) => `{${q}Name${q}:${q}DB_PASSWORD${q},${q}Value${q}:${value}}`;
      expect({ depth, out: mask(bare('123456')) }).toEqual({ depth, out: bare('***') });
    }
  });

  it('masks the value of a pair whose name field is Key and of a pair whose value field is Val, raw and serialized, and leaves other pairs', () => {
    // [text, masked, masked when the text is the value of a JSON string]. In the raw text the `*KEY=` rule also masks the value of a "Key"
    // field; inside a JSON string the quote before the colon is escaped and only the pair rule masks (the value field, never the name).
    const cases = [
      ['{"Key":"DB_PASSWORD","Value":"hunter2zz"}', '{"Key":"***","Value":"***"}', '{"Key":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Val":"hunter2zz"}', '{"Name":"DB_PASSWORD","Val":"***"}', '{"Name":"DB_PASSWORD","Val":"***"}'],
      ['{"Key":"DB_PASSWORD","Val":"hunter2zz"}', '{"Key":"***","Val":"***"}', '{"Key":"DB_PASSWORD","Val":"***"}'],
      ['{"Val":"hunter2zz","Key":"DB_PASSWORD"}', '{"Val":"***","Key":"***"}', '{"Val":"***","Key":"DB_PASSWORD"}'],
      ['{"Value":"hunter2zz","Key":"DB_PASSWORD"}', '{"Value":"***","Key":"***"}', '{"Value":"***","Key":"DB_PASSWORD"}'],
      ['{"Key":"DB_PASSWORD","Val":123456}', '{"Key":"***","Val":***}', '{"Key":"DB_PASSWORD","Val":***}'],
      ['{"Name":"DB_PASSWORD","Val":true,"x":1}', '{"Name":"DB_PASSWORD","Val":***,"x":1}', '{"Name":"DB_PASSWORD","Val":***,"x":1}'],
      ['{"Val":123456,"Key":"DB_PASSWORD"}', '{"Val":***,"Key":"***"}', '{"Val":***,"Key":"DB_PASSWORD"}'],
      [
        '{"oldKey":"REGION","newKey":"DB_PASSWORD","oldVal":"public","newVal":"hunter2zz"}',
        '{"oldKey":"***","newKey":"***","oldVal":"public","newVal":"***"}',
        '{"oldKey":"REGION","newKey":"DB_PASSWORD","oldVal":"public","newVal":"***"}',
      ],
      [
        '[{"Key":"A_TOKEN","Val":"t0k3n"},{"Key":"REGION","Val":"eu-west-1"}]',
        '[{"Key":"***","Val":"***"},{"Key":"***","Val":"eu-west-1"}]',
        '[{"Key":"A_TOKEN","Val":"***"},{"Key":"REGION","Val":"eu-west-1"}]',
      ],
      ['{"Key":"REGION","Val":"eu-west-1"}', '{"Key":"***","Val":"eu-west-1"}', '{"Key":"REGION","Val":"eu-west-1"}'],
      ['{"Key":"REGION","Value":"eu-west-1"}', '{"Key":"***","Value":"eu-west-1"}', '{"Key":"REGION","Value":"eu-west-1"}'],
      ['{"Name":"REGION","Val":"eu-west-1"}', '{"Name":"REGION","Val":"eu-west-1"}', '{"Name":"REGION","Val":"eu-west-1"}'],
    ];
    for (const [text, masked, maskedInString] of cases) {
      expect({ text, out: mask(text) }).toEqual({ text, out: masked });
      const inString = JSON.stringify({ command: text });
      expect({ inString, out: mask(inString) }).toEqual({ inString, out: JSON.stringify({ command: maskedInString }) });
    }
    // The same pairs with the delimiters escaped at higher depths (JSON string, shell-escaped, and so on up to 255 backslashes).
    for (const depth of [1, 2, 3, 4, 5, 8]) {
      const q = '\\'.repeat(2 ** depth - 1) + '"';
      const pair = (name, value, label) => `{${q}${name}${q}:${q}DB_PASSWORD${q},${q}${label}${q}:${value}}`;
      for (const [name, label] of [['Key', 'Value'], ['Name', 'Val'], ['Key', 'Val']]) {
        expect({ depth, name, label, out: mask(pair(name, `${q}hunter2zz${q}`, label)) }).toEqual({ depth, name, label, out: pair(name, `${q}***${q}`, label) });
        expect({ depth, name, label, out: mask(pair(name, '123456', label)) }).toEqual({ depth, name, label, out: pair(name, '***', label) });
      }
    }
  });

  it('masks the value after a field name in another language, and leaves prose with the same words', () => {
    const cases = [
      ['hasło: Zaq12wsx', 'hasło: ***'],
      ['Hasło=Zaq12wsx', 'Hasło=***'],
      ['HASŁO = "Zaq12wsx"', 'HASŁO = "***"'],
      ['haslo: abc', 'haslo: ***'],
      ['klucz: abc', 'klucz: ***'],
      ['{"sekret": "abc"}', '{"sekret": "***"}'],
      ['Passwort: abc', 'Passwort: ***'],
      ['kennwort=abc', 'kennwort=***'],
      ['contraseña: abc', 'contraseña: ***'],
      ['Contrasena: abc', 'Contrasena: ***'],
      ["sekret='https://alice:prefix&hunter2zz@example.test/path'", "sekret='***'"],
      ['klucz=https://alice:prefix&hunter2zz@example.test/path x', 'klucz=*** x'],
      ['curl https://alice:prefix&hunter2zz@example.test/path', 'curl https://alice:***@example.test/path'],
      ['contraseña: hunter2zz', 'contraseña: ***'],
      ['{"contrasen\\u0303a":"hunter2zz"}', '{"contrasen\\u0303a":"***"}'],
      ['token: Bearer abcdefghijklmnop1234', 'token: *** ***'],
      ['{"token":"Bearer abcdefghijklmnop1234"}', '{"token":"*** ***"}'],
      ['password: Basic dXNlcjpwYXNz', 'password: *** ***'],
      [String.raw`curl -d '{\"hasło\":\"hunter2zz\"}'`, String.raw`curl -d '{\"hasło\":\"***\"}'`],
      ['{"has\\u0142o":"hunter2zz"}', '{"has\\u0142o":"***"}'],
      ['{"HAS\\u0141O":"hunter2zz"}', '{"HAS\\u0141O":"***"}'],
      ['{"contrase\\u00f1a":"hunter2zz"}', '{"contrase\\u00f1a":"***"}'],
      ['{"contrase\\u00D1a":"hunter2zz"}', '{"contrase\\u00D1a":"***"}'],
      ['hasło jest za krótkie', 'hasło jest za krótkie'],
      ['klucz do pokoju', 'klucz do pokoju'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // A name that the word rules also know (PASS in passwort), in the serialized form: nothing of the value is left.
    for (const text of ['Passwort="hunter2zz"', String.raw`Passwort=\"hunter2zz\"`]) {
      expect({ text, left: mask(text).includes('hunter2zz') }).toEqual({ text, left: false });
    }
  });

  it('reads every name of the list in each of its forms in every rule: alone, beside an assignment before and after it, and as a pair name', () => {
    // The class behind the findings on one spelling of one name: each rule that reads a name must read the same forms of every name.
    const cases = [];
    for (const name of LOCAL_FIELD_NAMES) {
      for (const form of nameForms(name)) {
        for (const separator of ['=', ': ', ' = ', ':']) {
          for (const quote of [(v) => v, (v) => `'${v}'`, (v) => `"${v}"`]) {
            const own = `${form}${separator}`;
            cases.push([`${own}${quote('hunter2zz')}`, `${own}${quote('***')}`]);
            // The assignment before: its value ends in padding (`==`, `=`) or not; only a padded value reads the next word, and leaves it
            // alone when it is a key of its own (it ends in a separator, or a separator follows it). A word with its value attached
            // (`name=value`) is none, so it is read as the value of the padded assignment, as an English name is.
            for (const first of ['YWJjZA==', 'YWJjZA=', 'abcd']) {
              const attached = first !== 'abcd' && /\S$/.test(own) && quote('x') === 'x';
              cases.push([`API_KEY=${first} ${own}${quote('hunter2zz')}`, attached ? 'API_KEY=***' : `API_KEY=*** ${own}${quote('***')}`]);
            }
            cases.push([`${own}${quote('hunter2zz')} API_KEY=YWJjZA==`, `${own}${quote('***')} API_KEY=***`]);
          }
        }
        cases.push([`{"Name":"${form}","Value":"hunter2zz"}`, `{"Name":"${form}","Value":"***"}`]);
        cases.push([`{"${form}":"hunter2zz"}`, `{"${form}":"***"}`]);
      }
    }
    expect(cases.length).toBeGreaterThan(1000);
    const wrong = cases.filter(([text, masked]) => mask(text) !== masked).map(([text, masked]) => ({ text, masked, out: mask(text) }));
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('masks the value of a field whose key has JSON escapes in any of its letters, and leaves other keys', () => {
    const cases = [
      ['{"h\\u0061s\\u0142o":"hunter2zz"}', '{"h\\u0061s\\u0142o":"***"}'],
      ['{"p\\u0061ssword":"hunter2zz"}', '{"p\\u0061ssword":"***"}'],
      ['{"\\u0063lient_s\\u0065cret": "hunter2zz"}', '{"\\u0063lient_s\\u0065cret": "***"}'],
      ['{"DB_P\\u0041SSWORD":"hunter2zz"}', '{"DB_P\\u0041SSWORD":"***"}'],
      ['{"c\\u006fntrase\\u00f1a":"hunter2zz"}', '{"c\\u006fntrase\\u00f1a":"***"}'],
      ['{"k\\u006cucz":"hunter2zz"}', '{"k\\u006cucz":"***"}'],
      ['p\\u0061ssword=hunter2zz', 'p\\u0061ssword=***'],
      [String.raw`{\"h\\u0061s\\u0142o\":\"hunter2zz\"}`, String.raw`{\"h\\u0061s\\u0142o\":\"***\"}`],
      [String.raw`{\n  "h\u0061s\u0142o"\n  :\n  "hunter2zz"\n}`, String.raw`{\n  "h\u0061s\u0142o"\n  :\n  "***"\n}`],
      ['{"n\\u0061me":"value"}', '{"n\\u0061me":"value"}'],
      ['{"\\u0061":"value"}', '{"\\u0061":"value"}'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // As the compaction hook sends it: a string, and a string inside a string.
    for (const raw of ['{"h\\u0061s\\u0142o":"hunter2zz"}', '{"p\\u0061ssword":\n"hunter2zz"}']) {
      let sent = raw;
      for (let level = 1; level <= 3; level++) {
        sent = JSON.stringify(sent).slice(1, -1);
        expect({ raw, level, left: mask(sent).includes('hunter2zz') }).toEqual({ raw, level, left: false });
      }
    }
  });

  it('masks a field name followed by whitespace as JSON writes it into a string (pretty-printed input as sentInputJson sends it)', () => {
    const cases = [
      [String.raw`{\n  "hasło"\n  :\n  "hunter2zz"\n}`, String.raw`{\n  "hasło"\n  :\n  "***"\n}`],
      [String.raw`{"hasło":\n"hunter2zz"}`, String.raw`{"hasło":\n"***"}`],
      [String.raw`{\n  \"hasło\"\n  :\n  \"hunter2zz\"\n}`, String.raw`{\n  \"hasło\"\n  :\n  \"***\"\n}`],
      [String.raw`{\n\t"hasło"\t:\r\n\t"hunter2zz"\r\n}`, String.raw`{\n\t"hasło"\t:\r\n\t"***"\r\n}`],
      [String.raw`{\n  "password"\n  :\n  "hunter2zz"\n}`, String.raw`{\n  "password"\n  :\n  "***"\n}`],
      [String.raw`{\n  "contraseña"\n  :\n  "hunter2zz"\n}`, String.raw`{\n  "contraseña"\n  :\n  "***"\n}`],
      [String.raw`{\n  "has\u0142o"\n  :\n  "hunter2zz"\n}`, String.raw`{\n  "has\u0142o"\n  :\n  "***"\n}`],
      [String.raw`hasło\n=\nhunter2zz`, String.raw`hasło\n=\n***`],
      [String.raw`{"hasło"\f:\u000b"hunter2zz"}`, String.raw`{"hasło"\f:\u000b"***"}`],
      // Whitespace that a JSON writer with ASCII output escapes as \uXXXX, in either case of the hex digits.
      [String.raw`{"password"\u00a0:\u00A0"hunter2zz"}`, String.raw`{"password"\u00a0:\u00A0"***"}`],
      [String.raw`{"hasło"\u3000:\u2028"hunter2zz"}`, String.raw`{"hasło"\u3000:\u2028"***"}`],
      [String.raw`{"hasło"\u0009:\u000a"hunter2zz"}`, String.raw`{"hasło"\u0009:\u000a"***"}`],
      [String.raw`{"hasło"\u0020:\u202f"hunter2zz"}`, String.raw`{"hasło"\u0020:\u202f"***"}`],
      [String.raw`{"hasło"\ufeff:\u205F"hunter2zz"}`, String.raw`{"hasło"\ufeff:\u205F"***"}`],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // The same pretty-printed object serialized once, twice and three times (a string inside a string inside a string): the value is gone.
    for (const name of ['hasło', 'password', 'contraseña']) {
      let sent = `{\n  "${name}"\n  :\n  "hunter2zz"\n}`;
      for (let level = 1; level <= 3; level++) {
        sent = JSON.stringify(sent).slice(1, -1);
        expect({ name, level, left: mask(sent).includes('hunter2zz') }).toEqual({ name, level, left: false });
      }
    }
    // The text itself, written the way the compaction hook sends a tool input: JSON.stringify of a call that holds pretty-printed JSON.
    for (const name of ['hasło', 'password', 'sekret', 'Passwort', 'contraseña', 'client_secret']) {
      const pretty = `{\n  "${name}"\n  :\n  "hunter2zz"\n}`;
      for (const input of [{ command: `curl -d '${pretty}' x` }, { content: pretty }, { command: JSON.stringify({ body: pretty }) }]) {
        const sent = JSON.stringify(input);
        expect({ name, sent, left: mask(sent).includes('hunter2zz') }).toEqual({ name, sent, left: false });
      }
    }
  });

  it('masks what a contextual rule masks also when the first word of a named value is its marker', () => {
    // The named-value rule must not hide the marker (Cookie:, Authorization: Basic, mysql -p, sshpass -p) from the rule that needs it.
    expect(mask("secret='Cookie: session=hunter2zz'")).toBe("secret='***'");
    expect(mask("secret='Authorization: Basic aHVudGVyMnp6'")).toBe("secret='*** ***'");
    expect(mask("password='mysql -phunter2zz'")).toBe("password='*** -p***'");
    expect(mask("token='sshpass -p hunter2zz'")).toBe("token='*** -p ***'");
    const leaks = [];
    for (const context of CONTEXTS) {
      for (const wrap of WRAPPERS) {
        const text = wrap(context);
        const out = mask(text);
        if (/hunter2zz|aHVudGVyMnp6/.test(out)) leaks.push({ text, out });
      }
    }
    expect(leaks).toEqual([]);
  });

  it('masks an assignment that is the first word of the value of a named field, as it is masked on its own', () => {
    const texts = [
      // A file written by a tool: the parent key has a secret name, the child key is the secret.
      JSON.stringify({ file_path: 'values.yaml', content: "secret:\n  password: 'hunter2zz'\n" }),
      JSON.stringify({ content: "token:\n  api_key: 'hunter2zz'\n" }),
      JSON.stringify({ content: "client_secret:\n  DB_PASSWORD: 'hunter2zz'\n" }),
      JSON.stringify({ content: 'secret:\n  API_KEY = hunter2zz\n' }),
      JSON.stringify({ content: "hasło:\n  password: 'hunter2zz'" }),
      JSON.stringify({ command: "echo 'hasło: DB_PASSWORD = hunter2zz'" }),
      JSON.stringify({ content: '{\n  "token"\n  :\n  "DB_PASSWORD = hunter2zz"\n}' }),
      JSON.stringify({ content: '{"password": "API_KEY = hunter2zz"}' }),
      String.raw`{\"password\": \"API_KEY = hunter2zz\"}`,
      // The same as raw text.
      "Nowe hasło:\nDB_PASSWORD='hunter2zz'",
      'hasło: PASSWORD = hunter2zz',
      'hasło=API_KEY=x,hunter2zz',
      'sekret: "x-api-key: \'hunter2zz\'"',
      'Contraseña:\npassword="hunter2zz"',
      'Kennwort:\nDB_PASSWORD="hunter2zz"',
      'Klucz:\n"api_token": "hunter2zz"',
      String.raw`password=\"password: hunter2zz\"`,
      String.raw`secret=\"api_key:'hunter2zz'\"`,
      String.raw`token=\"password = hunter2zz,x\"`,
    ];
    const leaks = texts.filter((text) => mask(text).includes('hunter2zz'));
    expect(leaks).toEqual([]);
  });

  it('masks the next assignment after a value that ends in Base64 padding, and what follows a label', () => {
    // The nested-label arm leaves a following key (a word with a secret name and a separator at its end) to the rule that reads it.
    expect(mask("API_KEY=YWJjZA== DB_PASSWORD='hunter2zz' ./app")).toBe("API_KEY=*** DB_PASSWORD='***' ./app");
    expect(mask("API_KEY=YWJjZA= DB_PASSWORD='hunter2zz' ./app")).toBe("API_KEY=*** DB_PASSWORD='***' ./app");
    expect(mask('API_KEY=YWJjZA== hasło=\'hunter2zz\' ./app')).toBe("API_KEY=*** hasło='***' ./app");
    expect(mask('API_KEY=YWJjZA== hasło="hunter2zz" ./app')).toBe('API_KEY=*** hasło="***" ./app');
    expect(mask('PASS== pass= hunter2zz')).toBe('PASS=*** pass= ***');
    expect(mask('KEY=: KEY: hunter2zz')).toBe('KEY=*** KEY: ***');
    expect(mask('PASS== pass =hunter2zz')).toBe('PASS=*** pass =***');
    expect(mask('API_KEY=YWJjZA== h\\u0061s\\u0142o="hunter2zz" ./app')).toBe('API_KEY=*** h\\u0061s\\u0142o="***" ./app');
    expect(mask('PASS:= KEY":hunter2zz')).toBe('PASS:*** KEY":***');
    for (const text of [
      String.raw`API_KEY=YWJjZA== DB_PASSWORD=\"hunter2zz\" ./app`,
      'API_KEY=YWJjZA== hasło=abc}hunter2zz z ./app',
      'API_KEY=YWJjZA== hasło=abc,hunter2zz z ./app',
      "secret: x-api-key: DB_PASSWORD='hunter2zz'",
      "hasło: x-api-key: DB_PASSWORD='hunter2zz'",
    ]) expect({ text, left: mask(text).includes('hunter2zz') }).toEqual({ text, left: false });
    // A value that follows a label and ends in an equals sign (padding) is still the value: it is masked, also before a closing quote.
    for (const text of ['secret: x-api-key: hunter2zz=', 'secret: x-api-key: YWJjZA=', '{"command":"secret: x-api-key: hunter2zz="}', 'hasło: x-api-key: hunter2zz=']) {
      expect({ text, left: /hunter2zz|YWJjZA/.test(mask(text)) }).toEqual({ text, left: false });
    }
    for (const raw of ["API_KEY=YWJjZA== DB_PASSWORD='hunter2zz' ./app", 'API_KEY=YWJjZA== hasło="hunter2zz" ./app']) {
      let sent = raw;
      for (let level = 1; level <= 3; level++) {
        sent = JSON.stringify(sent).slice(1, -1);
        expect({ raw, level, left: mask(sent).includes('hunter2zz') }).toEqual({ raw, level, left: false });
      }
    }
  });

  it('masks the value of a field key with non-ASCII letters, also when it holds JSON escapes, and of a pair whose prefix has them', () => {
    const cases = [
      ['{"hasł\\u006f":"hunter2zz"}', '{"hasł\\u006f":"***"}'],
      ['{"contrase\\u00f1\\u0061":"hunter2zz"}', '{"contrase\\u00f1\\u0061":"***"}'],
      ['{"contrasen\u0303\\u0061":"hunter2zz"}', '{"contrasen\u0303\\u0061":"***"}'],
      ['{"parame\u0300tre-p\\u0061ss":"hunter2zz"}', '{"parame\u0300tre-p\\u0061ss":"***"}'],
      [String.raw`{\"hasł\\u006f\":\"hunter2zz\"}`, String.raw`{\"hasł\\u006f\":\"***\"}`],
      ['hasł\\u006f: hunter2zz', 'hasł\\u006f: ***'],
      ['{"zażółć\\u0061":"value"}', '{"zażółć\\u0061":"value"}'],
      ['{"ł\\u0061":"value"}', '{"ł\\u0061":"value"}'],
      ['{"paramètre-name":"DB_PASSWORD","paramètre-value":"hunter2zz"}', '{"paramètre-name":"DB_PASSWORD","paramètre-value":"***"}'],
      ['{"paramètre-value":"hunter2zz","paramètre-name":"DB_PASSWORD"}', '{"paramètre-value":"***","paramètre-name":"DB_PASSWORD"}'],
      ['{"parame\u0300tre-name":"DB_PASSWORD","parame\u0300tre-value":"hunter2zz"}', '{"parame\u0300tre-name":"DB_PASSWORD","parame\u0300tre-value":"***"}'],
      [String.raw`{\"paramètre-name\":\"DB_PASSWORD\",\"paramètre-value\":\"hunter2zz\"}`, String.raw`{\"paramètre-name\":\"DB_PASSWORD\",\"paramètre-value\":\"***\"}`],
      ['{"nazwa.parametrów-name":"A_TOKEN","nazwa.parametrów-value":"hunter2zz"}', '{"nazwa.parametrów-name":"A_TOKEN","nazwa.parametrów-value":"***"}'],
      ['{"paramètre-name":"REGION","paramètre-value":"eu-west-1"}', '{"paramètre-name":"REGION","paramètre-value":"eu-west-1"}'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    for (const raw of ['{"hasł\\u006f":"hunter2zz"}', '{"paramètre-name":"DB_PASSWORD","paramètre-value":"hunter2zz"}']) {
      let sent = raw;
      for (let level = 1; level <= 3; level++) {
        sent = JSON.stringify(sent).slice(1, -1);
        expect({ raw, level, left: mask(sent).includes('hunter2zz') }).toEqual({ raw, level, left: false });
      }
    }
  });

  it('classifies a field key before a long string erases it', () => {
    const cases = [
      ['{"service_01234567890123456789_klucz":"hunter2zz"}', '{"***":"***"}'],
      ['{"service_01234567890123456789_hasło":"hunter2zz"}', '{"***ło":"***"}'],
      ['{"service_01234567890123456789_p\\u0061ssword":"hunter2zz"}', '{"service_01234567890123456789_p\\u0061ssword":"***"}'],
      ['{"service_01234567890123456789_h\\u0061s\\u0142o":"hunter2zz"}', '{"service_01234567890123456789_h\\u0061s\\u0142o":"***"}'],
      ['service_01234567890123456789_sekret: hunter2zz', '***: ***'],
      ['{"service_01234567890123456789_name":"public"}', '{"***":"public"}'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    for (const raw of ['{"service_01234567890123456789_klucz":"hunter2zz"}', '{"service_01234567890123456789_p\\u0061ssword":"hunter2zz"}']) {
      let sent = raw;
      for (let level = 1; level <= 3; level++) {
        sent = JSON.stringify(sent).slice(1, -1);
        expect({ raw, level, left: mask(sent).includes('hunter2zz') }).toEqual({ raw, level, left: false });
      }
    }
  });

  it('masks a field whose key has JSON escapes under a localized field, and a field that names a secret inside the value of one', () => {
    const texts = [
      'hasło:\n  "p\\u0061ssword": "hunter2zz"',
      JSON.stringify({ content: 'hasło:\n  "p\\u0061ssword": "hunter2zz"' }),
      JSON.stringify({ command: "printf 'klucz:\\n  \"p\\u0061ssword\": \"hunter2zz\"\\n'" }),
      'Passwort: {"p\\u0061ssword":"hunter2zz"}',
      '{"p\\u0061ssword":"hasło: hunter2zz"}',
      String.raw`{\"p\\u0061ssword\":\"hasło: hunter2zz\"}`,
      'hasło: x-api-key: hunter2zz',
      "hasło: DB_PASSWORD: 'hunter2zz'",
      // A word after a label that is a key of its own is left to the rule that reads it, so its value is masked too.
      'hasło: abc: klucz: hunter2zz',
      'sekret: foo: Passwort: hunter2zz',
      '{"hasło":"abc: klucz: hunter2zz"}',
      'hasło= abc= sekret=hunter2zz',
    ];
    const leaks = texts.filter((text) => mask(text).includes('hunter2zz'));
    expect(leaks).toEqual([]);
    expect(mask('hasło:\n  "p\\u0061ssword": "hunter2zz"')).toBe('hasło:\n  "***"');
    // A key without a secret name under a localized field stays readable on the other side of the value.
    expect(mask('{"hasło":"hunter2zz","region":"eu-west-1"}')).toBe('{"hasło":"***","region":"eu-west-1"}');
  });

  it('masks the rest of a pair value cut off inside its quotes, also past a bracket in the value', () => {
    const cases = [
      ['{"Name":"DB_PASSWORD","Value":"abc}hunter2zz xxx', '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"DB_PASSWORD","Value":"abc]hunter2zz xxx', '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"DB_PASSWORD","Value":"abc}def]hunter2zz', '{"Name":"DB_PASSWORD","Value":"***"'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc}hunter2zz xxx`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"`],
      ['{"Name":"DB_PASSWORD","Value":"abc}hunter2zz xxx","Other":"x"}', '{"Name":"DB_PASSWORD","Value":"***","Other":"x"}'],
      ['{"Value":"abc}hunter2zz ","Name":"DB_PASSWORD"}', '{"Value":"***","Name":"DB_PASSWORD"}'],
      // A premature quote still ends the scan at the bracket that follows the closing quote.
      ['{"Name":"DB_PASSWORD","Value":"abc"def ghi"}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Value":"abc"def ghi"],"Other":"x"', '{"Name":"DB_PASSWORD","Value":"***"],"Other":"x"'],
      // After a quote that was misread as the close, a bracket ends the scan only when the end, another bracket or the next member follows it.
      ['{"Name":"DB_PASSWORD","Value":"abc"def},hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"DB_PASSWORD","Value":"abc"def}],hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"DB_PASSWORD","Value":"abc"def],hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"def},hunter2zz and more`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"`],
      // That bracket must follow a real delimiter or such a follower: an escaped quote or an apostrophe before it is content.
      ['{"Name":"DB_PASSWORD","Value":"abc"def\\"},hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"'],
      ['{"Name":"DB_PASSWORD","Value":"abc"def\'},hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"def\\\"},hunter2zz and more`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"`],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"def'},hunter2zz and more`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"`],
      // A quote that a bracket follows is a close: what comes after the bracket is outside the value (the same as for a value without a misread quote).
      ['{"Name":"DB_PASSWORD","Value":"abc"def"},hunter2zz and more', '{"Name":"DB_PASSWORD","Value":"***"},hunter2zz and more'],
      [String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"abc\"def\"},hunter2zz and more`, String.raw`{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"},hunter2zz and more`],
      [JSON.stringify({ command: '{"Name":"DB_PASSWORD","Value":"abc"def ghi"}' }), JSON.stringify({ command: '{"Name":"DB_PASSWORD","Value":"***"}' })],
      ['{"Name":"DB_PASSWORD","Value":"abc"def}', '{"Name":"DB_PASSWORD","Value":"***"}'],
      ['{"Name":"DB_PASSWORD","Value":"abc"def}]', '{"Name":"DB_PASSWORD","Value":"***"}]'],
      ['[{"Name":"REGION","Value":"abc"def}, {"Name":"DB_PASSWORD","Value":"hunter2zz"}]', '[{"Name":"REGION","Value":"abc"def}, {"Name":"DB_PASSWORD","Value":"***"}]'],
      // A bracket that closes an object ends the scan, so the next object of an array is its own group (a premature quote in the first).
      ['[{"Name":"REGION","Value":"abc"def},{"Name":"DB_PASSWORD","Value":"hunter2zz"}]', '[{"Name":"REGION","Value":"abc"def},{"Name":"DB_PASSWORD","Value":"***"}]'],
      [String.raw`[{\"Name\":\"REGION\",\"Value\":\"abc\"def},{\"Name\":\"DB_PASSWORD\",\"Value\":\"hunter2zz\"}]`, String.raw`[{\"Name\":\"REGION\",\"Value\":\"abc\"def},{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"}]`],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
  });

  it('masks a pair value cut at any length, whatever closes inside it, raw and serialized once and twice, with exact results', () => {
    // The class behind the findings on one closing character: while the quote of a value is open, a bracket, a comma or a parenthesis is
    // content, so a value that the text cuts short is masked to its end, and a value that is complete is masked up to its closing quote.
    const tail = 'hunter2zz and more text';
    const wrong = [];
    let cuts = 0;
    // `"` is a quote inside the value that nothing escapes (a close that was misread); `\"` is one that the value escapes.
    for (const closer of ['}', '}]', '},', '],', ')', '"', String.raw`\"`]) {
      const pairs = [
        `{"Name":"DB_PASSWORD","Value":"abc${closer}${tail}"}`,
        `{"Value":"abc${closer}${tail}","Name":"DB_PASSWORD"}`,
      ];
      for (const [order, pair] of pairs.entries()) {
        let text = pair;
        for (let depth = 0; depth <= 2; depth++) {
          if (depth) text = JSON.stringify({ command: text });
          const q = '\\'.repeat(2 ** depth - 1) + '"';
          const valueAt = text.indexOf(`${q}Value${q}:`) + `${q}Value${q}:`.length;
          const closeAt = text.indexOf(tail) + tail.length;
          expect({ depth, closer, closes: text.startsWith(q, closeAt) }).toEqual({ depth, closer, closes: true });
          // The text cut at every length (as the compaction hook cuts a long input), and uncut. Before the value opens nothing is masked;
          // inside it the value is masked to the cut; after its closing quote, up to that quote. A name that comes after its value is
          // read only when the text is not cut before it.
          const lengths = order ? [text.length] : Array.from({ length: text.length + 1 }, (_, end) => end);
          for (const end of lengths) {
            const cut = text.slice(0, end);
            const expected = end < valueAt + q.length ? cut : text.slice(0, valueAt) + q + '***' + q + text.slice(closeAt + q.length, Math.max(end, closeAt + q.length));
            cuts++;
            if (mask(cut) !== expected) wrong.push({ depth, closer, cut, expected, out: mask(cut) });
          }
        }
      }
    }
    expect(cuts).toBeGreaterThan(1500);
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it('masks a quoted value whole under any name when a separator, bracket, comma or parenthesis is inside the quotes, also when the quote is never closed', () => {
    // The same class as a pair value cut short: while the quote of a value is open, what would end an unquoted word is content.
    const names = ['password', 'DB_PASSWORD', 'X_KEY', 'api_key', 'hasło', 'klucz', 'sekret', 'Passwort', 'contraseña', 'contrasen\u0303a', String.raw`h\u0061s\u0142o`, String.raw`p\u0061ssword`];
    const closers = [',', '}', '},', ']', '],', ')', ';', '&', '|', ')}', ',}'];
    const wrong = [];
    let checked = 0;
    for (const name of names) {
      for (const separator of ['=', ': ', ' = ']) {
        for (const quote of ["'", '"']) {
          for (const closer of closers) {
            const open = `${name}${separator}${quote}`;
            for (const [text, masked] of [
              [`${open}abc${closer}hunter2zz${quote}`, `${open}***${quote}`],
              [`${open}abc${closer}hunter2zz`, `${open}***`],
              [`${open}abc${closer}hunter2zz${quote} next`, `${open}***${quote} next`],
            ]) {
              checked++;
              if (mask(text) !== masked) wrong.push({ text, masked, out: mask(text) });
            }
            // As a tool input is sent (the quotes escaped by the JSON string) and as a JSON key: nothing of the value is left.
            // (A name that only the `KEY=` rule reads is not read when JSON has escaped the quotes around it, as on dev: `X_KEY` stays out of that shape.)
            const escapedKey = name === 'X_KEY' ? [] : [String.raw`{\"${name}\":\"abc${closer}hunter2zz\"}`];
            for (const text of [JSON.stringify({ command: `${open}abc${closer}hunter2zz${quote}` }), `{"${name}":"abc${closer}hunter2zz"}`, ...escapedKey]) {
              checked++;
              if (mask(text).includes('hunter2zz')) wrong.push({ text, out: mask(text) });
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(4000);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('keeps the kind of a token that a prefix rule masks: the long-string rule reads the result of the others, not the original text', () => {
    const cases = [
      ['HEAD-1 key sk-' + 'a1'.repeat(20) + '\nx', 'HEAD-1 key sk-***\nx'],
      ['TAIL-1 ghp_' + 'Zx9'.repeat(10), 'TAIL-1 ghp_***'],
      ['sk-ant-' + 'a1'.repeat(20), 'sk-ant-***'],
      ['xoxb-' + 'a1'.repeat(20), 'xoxb-***'],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIA***'],
      ['eyJabcdefgh.abcdefgh.abcdefgh', 'eyJ***'],
      // A long string that no rule knows is still masked whole.
      ['id ' + 'a1'.repeat(20), 'id ***'],
    ];
    for (const [text, masked] of cases) expect({ text, out: mask(text) }).toEqual({ text, out: masked });
  });

  it('masks a value that only shows once the first value of its field is masked (the second pass reads what the first one made)', () => {
    const cases = [
      ["x-api-key: [}]'= hunter2zz \\u0061", 'x-api-key: *** \\u0061'],
      ["secret: ,'=  hunter2zz passwort\"Name\":\"", 'secret: *** passwort"Name":"'],
      ['DB_PASSWORD=\\\\: Bearer =  hunter2zz PASS', 'DB_PASSWORD=*** PASS'],
    ];
    for (const [text, masked] of cases) expect({ text, out: mask(text) }).toEqual({ text, out: masked });
  });

  it('leaves nothing of a secret-bearing value under any field name, separator, key and value quoting and serialization', () => {
    // The class behind the findings about rule order: a rule that runs before the named-value rule and needs the first word of the
    // value as its marker, a field key that another rule would erase or not read, a separator or quote written as JSON writes it.
    const values = [
      'hunter2zz',
      'Cookie: session=hunter2zz',
      'Set-Cookie: sid=hunter2zz; Path=/',
      'Authorization: Basic aHVudGVyMnp6',
      'Authorization: Bearer aHVudGVyMnp6',
      'bearer aHVudGVyMnp6',
      'mysql -phunter2zz db',
      'sshpass -p hunter2zz ssh host',
      'curl -u alice:hunter2zz x',
      'x-api-key: hunter2zz',
      'DB_PASSWORD: hunter2zz',
      'API_KEY=hunter2zz',
      'https://alice:hunter2zz@example.test/p',
    ];
    const names = ['password', 'hasło', String.raw`h\u0061s\u0142o`, 'service_01234567890123456789_klucz', String.raw`service_01234567890123456789_p\u0061ssword`, 'MY_TOKEN'];
    const separators = [':', '=', ' : ', ': ', ' = ', '\n:\n'];
    const keyQuotes = [(k) => k, (k) => `"${k}"`, (k) => `'${k}'`, (k) => String.raw`\"${k}\"`];
    const valueQuotes = [(v) => v, (v) => `"${v}"`, (v) => `'${v}'`, (v) => String.raw`\"${v}\"`];
    const serializations = [(t) => t, (t) => JSON.stringify(t).slice(1, -1), (t) => JSON.stringify({ command: t })];
    const leaks = [];
    let checked = 0;
    for (const value of values) for (const name of names) for (const separator of separators) for (const keyQuote of keyQuotes) for (const valueQuote of valueQuotes) {
      for (const [index, serialize] of serializations.entries()) {
        // A word rule that needs `\b` before its marker does not see a marker glued to a serialized line break (`\nmysql`): the same on
        // dev, and not what these rules decide.
        if (index && separator === '\n:\n' && /^(?:mysql|sshpass|bearer)/.test(value)) continue;
        const text = serialize(`${keyQuote(name)}${separator}${valueQuote(value)}`);
        checked++;
        if (/hunter2zz|aHVudGVyMnp6/.test(mask(text))) leaks.push(text);
      }
    }
    expect(checked).toBeGreaterThan(15_000);
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  it('masks the value under a key that starts with a credential-shaped prefix, as a key, a nested key, a pair name and an assignment, raw and serialized, with exact results', () => {
    // The class behind the findings about rule order: a rule that rewrites a prefix of a key must not take away what the field rules read.
    const names = ['hasło', 'contraseña', 'passwort', 'kennwort'].flatMap((name) => [name.normalize('NFC'), name.normalize('NFD')]);
    const positions = [
      ['field', (key, value) => `{"${key}":"${value}"}`],
      ['nested key', (key, value) => `{"a":{"${key}":"${value}"},"b":1}`],
      ['pair name', (key, value) => `{"Name":"${key}","Value":"${value}"}`],
      ['assignment', (key, value) => `${key}=${value} next`],
      ['label', (key, value) => `${key}: ${value}`],
    ];
    const wrong = [];
    let checked = 0;
    for (const [label, prefix, joint, leave, onlyJevMask] of PREFIX_KEYS) {
      if (onlyJevMask && _file !== 'jev-mask.mjs') continue;
      for (const name of names) {
        const key = prefix + joint + name;
        for (const [position, make] of positions) {
          for (const [form, serialize] of FORMS) {
            const text = serialize(make(key, 'hunter2zz'));
            let raw = make(leave(key), '***');
            // The bearer and the long string rules read `=` and the letters after it as part of what they mask: where the whole name is
            // made of the characters they read (an ASCII name), the key, the equals sign and the value are masked (the long string rule makes its own
            // `***` of the key and the equals sign, beside that of the value); else what
            // follows the first other character of the name stays, as does the equals sign.
            if (WORD_RULES[label] && position === 'assignment') {
              const [visible, wordChar, whole] = WORD_RULES[label];
              const cut = [...name].findIndex((ch) => !wordChar.test(ch));
              raw = cut < 0 ? whole : `${visible}***${name.slice(cut)}=*** next`;
            }
            const expected = serialize(raw);
            const out = mask(text);
            checked++;
            if (out !== expected || mask(out) !== out) wrong.push({ label, name, position, form, text, out, expected });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(wrong.slice(0, 3)).toEqual([]);
    // The cases of the finding itself.
    expect(mask('{"sk-proj-abcdefghijklm_hasło":"hunter2zz"}')).toBe('{"sk-proj-***ło":"***"}');
    expect(mask('{"ghp_abcdefghijklmnop_hasło":"hunter2zz"}')).toBe('{"ghp_***ło":"***"}');
    expect(mask('{"eyJabcdefgh.abcdefgh.abcdefgh_hasło":"hunter2zz"}')).toBe('{"eyJ***ło":"***"}');
  });

  it('reads a quoted key whole, decoded, before it looks for the separator: punctuation, spaces and escapes in the key are part of it', () => {
    // A key is classified by the word it ends in, as the word rules do for the same key without the escapes: `my pwd` is read by the pair
    // scanner only where the rules that read a word cannot (a serialized key).
    const keys = ['my:password', 'my password', 'x-api-key', 'a.b.c_secret', 'a/b,c-token', 'my:hasło', 'my.contraseña', 'my pwd', 'a b credentials', 'x/y.pass'];
    // The key as written, and with one character at a time written as a JSON escape (a letter, a punctuation mark, a space), and with all.
    const spellings = (key) => {
      const escape = (ch) => String.raw`\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      const chars = [...key.normalize('NFC')];
      return [...new Set([key, ...chars.map((_, i) => chars.map((ch, j) => (i === j ? escape(ch) : ch)).join('')), chars.map(escape).join('')])];
    };
    const shapes = [
      ['an object', (key, value) => `{"${key}":${value}}`],
      ['a field among others', (key, value) => `{"a":1,"${key}":${value},"b":"x"}`],
      ['a nested field', (key, value) => `{"a":{"${key}":${value}}}`],
      ['spaces around the separator', (key, value) => `{"${key}" : ${value}}`],
    ];
    const wrong = [];
    let checked = 0;
    for (const key of keys) {
      for (const spelled of spellings(key)) {
        for (const [shape, make] of shapes) {
          for (const [form, serialize] of FORMS) {
            const text = serialize(make(spelled, '"hunter2zz"'));
            const expected = serialize(make(spelled, '"***"'));
            const out = mask(text);
            checked++;
            if (out !== expected) wrong.push({ key, spelled, shape, form, text, out, expected });
            // A number is masked too (the rules that read a word also take the brace or comma after it).
            if (mask(serialize(make(spelled, '123456'))).includes('123456')) wrong.push({ key, spelled, shape, form, number: true });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(wrong.slice(0, 3)).toEqual([]);
    // The cases of the finding itself.
    expect(mask('{"m\\u0079:p\\u0061ssword":"hunter2zz"}')).toBe('{"m\\u0079:p\\u0061ssword":"***"}');
    expect(mask('{"my\\u0020p\\u0061ssword":"hunter2zz"}')).toBe('{"my\\u0020p\\u0061ssword":"***"}');
    // A key that names no secret keeps its value, with the same punctuation and escapes in it.
    // (`[line omitted: secret path]` is what the compaction hook writes in place of a key that names a secret path.)
    for (const text of ['{"m\\u0079:name":"hunter2zz"}', '{"my pet":"x"}', '{"a:b":"c"}', '{"[line omitted: secret path]":"KEYED-VALUE"}', String.raw`{\"[line omitted: secret path]\":\"KEYED-VALUE\"}`]) {
      expect(mask(text)).toBe(text);
    }
  });

  it('reads the key of a pair field whole: whatever stands in front of its selector (a separator, a space, punctuation, an escape) does not keep the pair from being read', () => {
    // What stands between the namespace and the selector, as it is written in the text: a character, or a JSON escape of one.
    const joints = [':', '/', ' ', '#', '@', ';', ',', '!', '$', '%', '&', '*', '+', '=', '?', '~', '^', '|', '(', ')', '[', ']', '{', '}', '<', '>', "'", '`',
      '.', '-', '_', 'é', 'ł', '日', ': ', '  ', String.raw`\/`, '\\u003a', '\\u0020', String.raw`\t`, String.raw`\n`, String.raw`\\`];
    // [label, the selector of the name, the selector of the value, whether the value field is itself a key that names a secret, whether the
    // rule that reads a word also masks the value of the name field in the raw text (the field is a `Key`)].
    const selectors = [
      ['Name/Value', 'Name', 'Value', false, false],
      ['Type/Value', 'Type', 'Value', false, false],
      ['Key/Val', 'Key', 'Val', false, true],
      ['label/secret', 'label', 'secret', true, false],
    ];
    const wrong = [];
    let checked = 0;
    for (const joint of joints) {
      for (const [label, nameKey, valueKey, secretKey, wordMasksName] of selectors) {
        for (const secretName of [true, false]) {
          for (const nameFirst of [true, false]) {
            for (const [form, serialize] of FORMS) {
              const nameValue = secretName ? 'DB_PASSWORD' : 'REGION';
              const valueText = secretName || secretKey ? 'hunter2zz' : 'eu-west-1';
              const make = (name, value) => {
                const fields = [`"ns${joint}${nameKey}":"${name}"`, `"ns${joint}${valueKey}":"${value}"`];
                return `{${(nameFirst ? fields : fields.reverse()).join(',')}}`;
              };
              // The value is masked when its name is a secret (or when its key is), and the name field keeps its value, except where a rule
              // that reads a word masks it: in the raw text, and (as the key then holds an escape that the scanner of escaped keys reads,
              // taking `Key` for a secret word) in a key spelled with a JSON escape of a colon.
              const expected = serialize(make(wordMasksName && (form === 'raw' || joint === '\\u003a') ? '***' : nameValue, secretName || secretKey ? '***' : valueText));
              const text = serialize(make(nameValue, valueText));
              const out = mask(text);
              checked++;
              if (out !== expected) wrong.push({ joint, label, secretName, nameFirst, form, text, out, expected });
            }
          }
        }
      }
    }
    expect(checked).toBe(joints.length * selectors.length * 2 * 2 * 3);
    expect(wrong.slice(0, 3)).toEqual([]);
    // The case of the finding itself, raw and serialized once and twice, in both orders.
    for (const [, serialize] of FORMS) {
      expect(mask(serialize('{"ns:name":"DB_PASSWORD","ns:value":"hunter2zz"}'))).toBe(serialize('{"ns:name":"DB_PASSWORD","ns:value":"***"}'));
      expect(mask(serialize('{"ns:value":"hunter2zz","ns:name":"DB_PASSWORD"}'))).toBe(serialize('{"ns:value":"***","ns:name":"DB_PASSWORD"}'));
    }
    // A value goes with the names of its own prefix, or else with the names without a prefix; a prefix is the whole of what stands in front.
    expect(mask('{"name":"DB_PASSWORD","ns:value":"hunter2zz"}')).toBe('{"name":"DB_PASSWORD","ns:value":"***"}');
    expect(mask('{"ns:name":"DB_PASSWORD","value":"hunter2zz"}')).toBe('{"ns:name":"DB_PASSWORD","value":"hunter2zz"}');
    expect(mask('{"a b/name":"DB_PASSWORD","a b/value":"hunter2zz","c d/value":"keep"}')).toBe('{"a b/name":"DB_PASSWORD","a b/value":"***","c d/value":"keep"}');
    // What follows the selector (a separator, a space, an escaped line break) does not count, and a key spelled with an escape is the same key.
    expect(mask('{"ns:name:":"DB_PASSWORD","ns:value ":"hunter2zz"}')).toBe('{"ns:name:":"DB_PASSWORD","ns:value ":"***"}');
    expect(mask('{"ns\\u003aname":"DB_PASSWORD","ns:value":"hunter2zz"}')).toBe('{"ns\\u003aname":"DB_PASSWORD","ns:value":"***"}');
    expect(mask(String.raw`{"ns:Name":"DB_PASSWORD","ns:Value\n":"hunter2zz"}`)).toBe(String.raw`{"ns:Name":"DB_PASSWORD","ns:Value\n":"***"}`);
  });

  it('reads a key that ends in a JSON escape, and a key that is one plain word in serialized text, as the word rules read the same key in raw text', () => {
    const cases = [
      // A key that ends in an escaped line break, tab or other whitespace: the word before it is the word the key ends in.
      ['{"password\\n":"hunter2zz"}', '{"password\\n":"***"}'],
      ['{"password\\t":"hunter2zz"}', '{"password\\t":"***"}'],
      ['{"my\\npassword":"hunter2zz"}', '{"my\\npassword":"***"}'],
      ['{"hasło\\r\\n":"hunter2zz"}', '{"hasło\\r\\n":"***"}'],
      ['{"p\\u0061ssword\\f":"hunter2zz"}', '{"p\\u0061ssword\\f":"***"}'],
      ['{"my pet\\n":"hunter2zz"}', '{"my pet\\n":"hunter2zz"}'],
      ['{"password\\nhint":"hunter2zz"}', '{"password\\nhint":"hunter2zz"}'],
      // An unquoted key (or one in apostrophes) that holds an escape starts after an escaped line break or tab, as after a space.
      ['ns\\tp\\u0061ssword=hunter2zz', 'ns\\tp\\u0061ssword=***'],
      ['ns\\np\\u0061ssword: hunter2zz', 'ns\\np\\u0061ssword: ***'],
      ["{'ns\\tp\\u0061ssword': 'hunter2zz'}", "{'ns\\tp\\u0061ssword': '***'}"],
      ["{'ns\\rh\\u0061s\\u0142o': 'hunter2zz'}", "{'ns\\rh\\u0061s\\u0142o': '***'}"],
      // A key that is one plain word and names a secret is masked in serialized text too (the rules that read a word cannot read the
      // backslash before its quote); a name that has a value field to go with is the name of a pair, as before.
      [String.raw`{\"X_KEY\":\"hunter2zz\"}`, String.raw`{\"X_KEY\":\"***\"}`],
      [String.raw`{\"password_x\":\"hunter2zz\",\"b\":1}`, String.raw`{\"password_x\":\"***\",\"b\":1}`],
      [String.raw`{\\\"X_KEY\\\":\\\"hunter2zz\\\"}`, String.raw`{\\\"X_KEY\\\":\\\"***\\\"}`],
      [String.raw`{\"Key\":\"hunter2zz\"}`, String.raw`{\"Key\":\"***\"}`],
      [String.raw`{\"Key\":\"DB_PASSWORD\",\"Val\":\"hunter2zz\"}`, String.raw`{\"Key\":\"DB_PASSWORD\",\"Val\":\"***\"}`],
      [String.raw`{\"X_KEY\":\"REGION\",\"X_VAL\":\"eu-west-1\"}`, String.raw`{\"X_KEY\":\"REGION\",\"X_VAL\":\"eu-west-1\"}`],
      [String.raw`{\"X_KEY\":\"DB_PASSWORD\",\"X_VAL\":\"hunter2zz\"}`, String.raw`{\"X_KEY\":\"DB_PASSWORD\",\"X_VAL\":\"***\"}`],
      [String.raw`{\"description\":\"hunter2zz\",\"name\":\"x\"}`, String.raw`{\"description\":\"hunter2zz\",\"name\":\"x\"}`],
    ];
    for (const [text, masked] of cases) expect({ text, out: mask(text) }).toEqual({ text, out: masked });
  });

  it('masks a key in apostrophes, and reads an unquoted key that holds escapes up to its own separator, without taking the next key for a value', () => {
    const cases = [
      ["{'m\\u0079:p\\u0061ssword': 'hunter2zz'}", "{'m\\u0079:p\\u0061ssword': '***'}"],
      ["{'my password': 'hunter2zz'}", "{'my password': '***'}"],
      ["{'a.b.c pwd': 'hunter2zz'}", "{'a.b.c pwd': '***'}"],
      ["{'a.b.c_secret':'hunter2zz','b':1}", "{'a.b.c_secret':'***','b':1}"],
      ["{'p\\u0061ssword': 'hunter2zz'}", "{'p\\u0061ssword': '***'}"],
      ["{'my:name': 'hunter2zz'}", "{'my:name': 'hunter2zz'}"],
      ['m\\u0079:p\\u0061ssword=hunter2zz', 'm\\u0079:p\\u0061ssword=***'],
      ['m\\u0079:p\\u0061ssword: hunter2zz', 'm\\u0079:p\\u0061ssword: ***'],
      ['my\\u0020p\\u0061ssword=hunter2zz', 'my\\u0020p\\u0061ssword=***'],
      ['m\\u0079=a p\\u0061ssword=hunter2zz', 'm\\u0079=a p\\u0061ssword=***'],
      ['m\\u0079:name=hunter2zz', 'm\\u0079:name=hunter2zz'],
      // A value is read up to the closing delimiter of its depth, whole: a run of backslashes before a quote is not part of the value.
      [String.raw`hasło=hunter2zz\\\"} next`, String.raw`hasło=***\\\"} next`],
      [String.raw`{\\\"hasło\\\":\\\"hunter2zz\\\"}`, String.raw`{\\\"hasło\\\":\\\"***\\\"}`],
    ];
    for (const [text, masked] of cases) expect({ text, out: mask(text) }).toEqual({ text, out: masked });
  });
});

describe('the two copies of maskSecrets', () => {
  it('are built from one list of field names: each name of the list is written once in the code of the shared rules', () => {
    for (const file of ['jev-mask.mjs', 'shell-checks.mjs']) {
      const code = sharedRules(readSource(file)).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n').normalize('NFC');
      for (const name of LOCAL_FIELD_NAMES) expect({ file, name, written: code.split(name).length - 1 }).toEqual({ file, name, written: 1 });
    }
  });

  it('give the same result on text that holds no private key block, no hf_, npm_ or sk_live_ token and no long hex string', () => {
    const names = ['password', 'secret', 'token', 'api_key', 'hasło', 'klucz', 'Passwort', 'contraseña'];
    const serializations = [(t) => t, (t) => JSON.stringify(t).slice(1, -1), (t) => JSON.stringify({ command: t })];
    const differences = [];
    for (const context of CONTEXTS) {
      for (const wrap of WRAPPERS) {
        for (const serialize of serializations) {
          const text = serialize(wrap(context));
          if (shellChecksMaskSecrets(text) !== maskSecrets(text)) differences.push(text);
        }
      }
      for (const name of names) {
        const text = JSON.stringify({ content: `{\n  "${name}"\n  :\n  "${context}"\n}` });
        if (shellChecksMaskSecrets(text) !== maskSecrets(text)) differences.push(text);
      }
    }
    expect(differences).toEqual([]);
  });

  it('give the same result on pairs with Key and Val, on a word that holds repeated keywords and on the labels that read the next word', () => {
    const texts = [
      '{"Key":"DB_PASSWORD","Value":"hunter2zz"}',
      '{"Name":"DB_PASSWORD","Val":"hunter2zz"}',
      '{"Key":"DB_PASSWORD","Val":123456}',
      '{"Val":"hunter2zz","Key":"DB_PASSWORD"}',
      '[{"Key":"A_TOKEN","Val":"t0k3n"},{"Key":"REGION","Val":"eu-west-1"}]',
      'KEY=: ' + 'klucz'.repeat(40),
      'KEY=: ' + 'PASS'.repeat(40),
      'KEY=: ' + '\\'.repeat(40),
      'secret=a: ' + 'klucz'.repeat(40),
      'hasło=: ' + 'klucz'.repeat(40),
      'klucz: a: ' + 'PASS'.repeat(40),
      'secret: x-api-key: YWJjZA=',
      'secret: x-api-key: hunter2zz=',
      "API_KEY=YWJjZA== DB_PASSWORD='hunter2zz' ./app",
      'KEY=: DB_PASSWORD=x',
      'KEY=: DB_PASSWORD =x',
      'KEY=: DB_PASSWORD "=x',
      String.raw`KEY=: a\u0061b: x`,
      String.raw`KEY=: a\u0061b x`,
      String.raw`KEY=: abc\\: x`,
      'hasło:\n  "p\\u0061ssword": "hunter2zz"',
      '{"ns:name":"DB_PASSWORD","ns:value":"hunter2zz"}',
      '{"ns:value":"hunter2zz","ns:name":"DB_PASSWORD"}',
      '{"a b/Key":"DB_PASSWORD","a b/Val":"hunter2zz","c#Value":"x"}',
      '{"password\\n":"hunter2zz","X_KEY":"hunter2zz"}',
      'ns\\tp\\u0061ssword=hunter2zz',
    ];
    const differences = [];
    for (const text of texts) {
      for (const variant of [text, JSON.stringify(text).slice(1, -1), JSON.stringify({ command: text })]) {
        if (shellChecksMaskSecrets(variant) !== maskSecrets(variant)) differences.push(variant);
      }
    }
    expect(differences).toEqual([]);
  });

  it('give the same result on the keys that start with a credential-shaped prefix and on the keys with punctuation, spaces and escapes', () => {
    const texts = [];
    for (const [, prefix, joint] of PREFIX_KEYS.filter((kind) => !kind[4])) {
      for (const name of ['hasło', 'contraseña'.normalize('NFD'), 'passwort']) {
        for (const make of [(k) => `{"${k}":"hunter2zz"}`, (k) => `{"Name":"${k}","Value":"hunter2zz"}`, (k) => `${k}=hunter2zz next`, (k) => `${k}: hunter2zz`]) {
          texts.push(make(prefix + joint + name));
        }
      }
    }
    for (const key of ['my:password', 'my password', 'x-api-key', 'a.b.c_secret', String.raw`m\u0079:p\u0061ssword`, String.raw`my\u0020p\u0061ssword`, String.raw`a.b_s\u0065cret`]) {
      for (const make of [(k) => `{"${k}":"hunter2zz"}`, (k) => `{"a":{"${k}":"hunter2zz"},"b":1}`, (k) => `{'${k}': 'hunter2zz'}`, (k) => `${k}=hunter2zz`]) texts.push(make(key));
    }
    const differences = [];
    for (const text of texts) {
      for (const variant of [text, serializeOnce(text), serializeTwice(text)]) {
        if (shellChecksMaskSecrets(variant) !== maskSecrets(variant)) differences.push(variant);
      }
    }
    expect(texts.length).toBeGreaterThan(140);
    expect(differences).toEqual([]);
  });

  it('hold the same rules: the private key rule, the chain of replacements and every constant and function after it are the same text in both files', () => {
    const maskSource = readSource('jev-mask.mjs');
    const shellSource = readSource('shell-checks.mjs');
    expect(sharedRules(shellSource).length).toBeGreaterThan(1000);
    expect(sharedRules(shellSource)).toBe(sharedRules(maskSource));
    // The chain of replacements, one line per rule. The copy lacks the hf_, npm_ and sk_live_ token rule, and the long mixed
    // letter-digit rule differs where it keeps git hashes; every other rule is the same line.
    const chain = (source) => {
      const from = source.indexOf('export function maskSecrets(');
      return source
        .slice(from, source.indexOf('\n}\n', from))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\[(?:\/|KEYWORD_ASSIGNMENT|NAMED_VALUE)/.test(line) && !/hf_\|npm_|\{32,\}/.test(line));
    };
    expect(chain(shellSource).length).toBeGreaterThan(10);
    expect(chain(shellSource)).toEqual(chain(maskSource));
    // The private key rule of maskPrivateKeys (jev-mask.mjs) is the first step of the copy, which drops the END line it matched.
    const keyRule = maskSource.slice(maskSource.indexOf('/(-{4,5} ?BEGIN'), maskSource.indexOf("'$1***$2')") + "'$1***$2')".length);
    expect(keyRule.length).toBeGreaterThan(100);
    expect(shellSource).toContain(keyRule.replace("'$1***$2')", "'$1***')"));
  });
});
