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
      'pair names alone': (n) => repeat('"name":"a",', n),
      'a pair value with an opening quote': (n) => repeat('"Name":"A_TOKEN","Value":"', n),
      '4 hyphens and BEGIN words': (n) => repeat('---- BEGIN SSH2 ENCRYPTED ', n),
      'BEGIN PRIVATE without KEY': (n) => repeat('-----BEGIN A1 B2 PRIVATE ', n),
      'contraseña without =': (n) => repeat('contraseña', n),
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
      ['-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
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
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
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
      [String.raw`curl -d '{\"hasło\":\"hunter2zz\"}'`, String.raw`curl -d '{\"hasło\":\"***\"}'`],
      [String.raw`{"hasło":"hunter2zz"}`, String.raw`{"hasło":"***"}`],
      [String.raw`{"HASŁO":"hunter2zz"}`, String.raw`{"HASŁO":"***"}`],
      [String.raw`{"contraseña":"hunter2zz"}`, String.raw`{"contraseña":"***"}`],
      ['hasło jest za krótkie', 'hasło jest za krótkie'],
      ['klucz do pokoju', 'klucz do pokoju'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
    // A name that the word rules also know (PASS in passwort), in the serialized form: nothing of the value is left.
    for (const text of ['Passwort="hunter2zz"', String.raw`Passwort=\"hunter2zz\"`]) {
      expect({ text, left: mask(text).includes('hunter2zz') }).toEqual({ text, left: false });
    }
  });
});
