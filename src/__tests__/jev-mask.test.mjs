/* global performance */
/**
 * Tests for scripts/lib/jev-mask.mjs: time linear in the text length on the shapes that used to take
 * seconds (one rule rescanning the same text from every start), and the masking those rules keep.
 */

import { describe, expect, it } from 'vitest';

import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';

const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

describe('maskSecrets', () => {
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
    };
    for (const n of [100_000, 1_000_000]) {
      for (const [name, make] of Object.entries(shapes)) {
        const text = make(n);
        const t0 = performance.now();
        const masked = maskSecrets(text);
        const ms = performance.now() - t0;
        expect({ name, n, slow: ms >= n / 1000 }).toEqual({ name, n, slow: false });
        expect(masked).toBe(text);
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
      ['mysql db; echo -pX', 'mysql db; echo -pX'],
      ['mysql a | mysql -pB', 'mysql a | mysql -p***'],
      ['mysql mysql -pX', 'mysql mysql -p***'],
      ['mysqldump -pA db && mysql -pB', 'mysqldump -p*** db && mysql -p***'],
      ['eyJaaaaaaaa.bbbbbbbb.cccccccc', 'eyJ***'],
      ['id=eyJ-eyJaaaaaaaa.bbbbbbbb.cccccccc!', 'id=eyJ***!'],
      ['eyJaa.eyJbbbbbbbb.cccccccc.dddddddd', 'eyJaa.eyJ***'],
      ['eyJaaaaaaaa.bbbbbbbb', 'eyJaaaaaaaa.bbbbbbbb'],
      ['DB_PASSWORD=hunter2', 'DB_PASSWORD=***'],
      ['x=PASSWORD=abc', 'x=PASSWORD=***'],
      ['passwordpassword=1', 'passwordpassword=***'],
      ['export GITHUB_TOKEN="abc"', 'export GITHUB_TOKEN="***"'],
      ["cfg['client_secret'] = 'v1'", "cfg['client_secret'] = '***'"],
      ['KEY KEY: v', 'KEY KEY: ***'],
      ['name=value', 'name=value'],
    ];
    for (const [text, masked] of cases) expect({ text, masked: maskSecrets(text) }).toEqual({ text, masked });
  });
});
