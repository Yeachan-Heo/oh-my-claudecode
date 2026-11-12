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
      'contraseña without =': (n) => repeat('contraseña', n),
    };
    for (const n of [100_000, 1_000_000]) {
      for (const [name, make] of Object.entries(shapes)) {
        const text = make(n);
        // The fastest of up to three runs, so one pause of a busy runner does not fail the test.
        let best = Infinity;
        for (let run = 0; run < 3 && best >= n / 1000; run++) {
          const t0 = performance.now();
          expect(mask(text)).toBe(text);
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
      ['hasło jest za krótkie', 'hasło jest za krótkie'],
      ['klucz do pokoju', 'klucz do pokoju'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: mask(text) }).toEqual({ text, masked });
  });
});
