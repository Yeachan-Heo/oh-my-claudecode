/* global performance */
/**
 * Tests for maskSecrets in scripts/lib/jev-mask.mjs and its copy in scripts/lib/shell-checks.mjs: time linear in the
 * text length on the shapes that used to take seconds (one rule rescanning the same text from every start), and the
 * masking those rules keep.
 */

import { describe, expect, it } from 'vitest';

import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { maskSecrets as shellChecksMaskSecrets } from '../../scripts/lib/shell-checks.mjs';

const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

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
    };
    for (const n of [100_000, 1_000_000]) {
      for (const [name, make] of Object.entries(shapes)) {
        const text = make(n);
        // The fastest of up to three runs, so one pause of a busy runner does not fail the test.
        let best = Infinity;
        for (let run = 0; run < 3 && best >= n / 1000; run++) {
          const t0 = performance.now();
          const out = mask(text);
          // The shapes named quote or masked are masked (their values are read); the others pass unchanged.
          if (!/quote|masked/.test(name)) expect(out).toBe(text);
          best = Math.min(best, performance.now() - t0);
        }
        expect(best, `${name}, ${n} characters: ${Math.round(best)} ms`).toBeLessThan(n / 1000);
      }
    }
  });

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
      // A bracket that closes an object ends the scan, so the next object of an array is its own group (a premature quote in the first).
      ['[{"Name":"REGION","Value":"abc"def},{"Name":"DB_PASSWORD","Value":"hunter2zz"}]', '[{"Name":"REGION","Value":"abc"def},{"Name":"DB_PASSWORD","Value":"***"}]'],
      [String.raw`[{\"Name\":\"REGION\",\"Value\":\"abc\"def},{\"Name\":\"DB_PASSWORD\",\"Value\":\"hunter2zz\"}]`, String.raw`[{\"Name\":\"REGION\",\"Value\":\"abc\"def},{\"Name\":\"DB_PASSWORD\",\"Value\":\"***\"}]`],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // The same text cut at every length inside the value, as the compaction hook cuts a long input: nothing of the value is left.
    const whole = '{"Name":"DB_PASSWORD","Value":"abc}hunter2zz and more text after the bracket"}';
    for (let end = whole.indexOf('hunter2zz'); end <= whole.length; end++) {
      const cut = whole.slice(0, end + 'hunter2zz'.length > whole.length ? whole.length : end + 'hunter2zz'.length);
      expect({ cut, left: mask(cut).includes('hunter2zz') }).toEqual({ cut, left: false });
    }
  });
});

describe('the two copies of maskSecrets', () => {
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
});
