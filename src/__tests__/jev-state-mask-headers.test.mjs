/**
 * scripts/lib/jev-state-mask.mjs: the headers and the URLs that carry a credential. Every header of the table x how it is written (a line,
 * inside -H '...' or -H "...", a key of JSON text, in a JSON string inside quotes) x how its value starts and what it holds (quotes at the
 * start and in the middle, `;`, white space), and every URL scheme x userinfo shape x host, with the exact result of every cell. What the
 * header pass leaves is a fixed point of maskSecrets, and the URL pass is one function for a whole text and for the tail of a cut one.
 */
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

const SECRET = 'hunter2zzQ';
const MAX = 200;
const asText = (value, options) => maskJevState({ t: value }, options).t;
const fixedPoint = (text) => maskSecrets(text, { keepGitHashes: true }) === text;

const HEADERS = ['Cookie', 'Set-Cookie', 'X-Api-Key', 'X-Auth-Token', 'X-Access-Token', 'X-Csrf-Token', 'X-Xsrf-Token', 'Private-Token', 'Authorization', 'Proxy-Authorization'];
// how a value starts and what it holds
const VALUES = [
  `${SECRET}`,
  `a=b; c=${SECRET}`,
  `"${SECRET}"`,
  `"a=b; c=${SECRET}"`,
  `a="x y"; c=${SECRET}`,
  `a b ${SECRET}`,
  `a=b, c="d;e", f=${SECRET}`,
  `"a b" ${SECRET}`,
];
// [a name, the text of a header with this value, what it becomes]; a value is written into quotes as that shell or JSON writes it
const escapeDouble = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
// (an inner shell's quote that is written \" in the JSON string closes where the string does: the value goes to the end of the string, fail closed)
const FORMS = [
  ['a line', (h, v) => `> ${h}: ${v}\n> Host: x`, (h, m = '***') => `> ${h}: ${m}\n> Host: x`],
  ['in single quotes', (h, v) => `curl -H '${h}: ${v}' -H 'Accept: x' https://host`, (h, m = '***') => `curl -H '${h}: ${m}' -H 'Accept: x' https://host`],
  ['in double quotes', (h, v) => `curl -H "${h}: ${escapeDouble(v)}" -H "Accept: x" https://host`, (h, m = '***') => `curl -H "${h}: ${m}" -H "Accept: x" https://host`],
  ['a key of JSON text', (h, v) => `{"${h}": "${escapeDouble(v)}", "Accept": "x"}`, (h, m = '***') => `{"${h}": "${m}", "Accept": "x"}`],
  ['a key of JSON text in single quotes', (h, v) => `curl -d '{"${h}": "${escapeDouble(v)}", "Accept": "x"}' https://host`, (h, m = '***') => `curl -d '{"${h}": "${m}", "Accept": "x"}' https://host`],
  ['a key of JSON text in a JSON string', (h, v) => `{"cmd": "curl -H \\"${h}: ${escapeDouble(escapeDouble(v))}\\" https://host"}`, (h, m = '***') => `{"cmd": "curl -H \\"${h}: ${m}"}`],
];

describe('the headers of maskJevState: every header x every way it is written x every value', () => {
  it.each(HEADERS.filter((header) => !/authorization/i.test(header)))('%s', (header) => {
    let cells = 0;
    for (const [name, write, result] of FORMS) {
      for (const value of VALUES) {
        const text = write(header, value);
        const expected = result(header);
        const label = `${name}: ${text}`;
        // a value that holds a double quote cannot be written in a JSON string in single quotes the same way: JSON escapes it, the shell does not
        expect(asText(text), label).toBe(expected);
        expect(asText(text, { maxChars: MAX }), `${label} (window)`).toBe(expected);
        expect(asText(expected), `${label} (second pass)`).toBe(expected);
        expect(fixedPoint(expected), `${label} (what the pass leaves, for maskSecrets)`).toBe(true);
        cells++;
      }
    }
    expect(cells).toBe(FORMS.length * VALUES.length);
  });

  it.each(['Authorization', 'Proxy-Authorization'])('%s keeps the scheme that maskSecrets reads past, and takes the credential of any other whole', (header) => {
    for (const [name, write, result] of FORMS) {
      for (const scheme of ['Bearer', 'Basic', 'Token']) {
        for (const credential of [SECRET, `"${SECRET}"`, `a b ${SECRET}`]) {
          const text = write(header, `${scheme} ${credential}`);
          const expected = result(header, `${scheme} ***`);
          expect(asText(text), `${name}: ${text}`).toBe(expected);
          expect(asText(expected), `${name}: second pass`).toBe(expected);
          expect(fixedPoint(expected)).toBe(true);
        }
      }
      for (const value of [`Digest u="a", r="${SECRET}"`, `ApiKey ${SECRET}`, `Negotiate ${SECRET}`, `"Bearer ${SECRET}"`, `"${SECRET}"`, `${SECRET}`]) {
        const text = write(header, value);
        expect(asText(text), `${name}: ${text}`).toBe(result(header));
      }
    }
  });

  it('reads a header by its name only: a longer name, a name inside another, a header with no value', () => {
    for (const [text, expected] of [
      ['the cookie jar: a=b', 'the cookie jar: a=b'],
      ['X-Api-Keys: a=b c', 'X-Api-Keys: *** c'],
      ['myauthorization-x: a b', 'myauthorization-x: a b'],
      ['Cookie:', 'Cookie:'],
      // a header right after the closing quote of another argument is a bare one, and goes to the end of the line
      [`echo 'a'Cookie: ${SECRET}`, `echo 'a'Cookie: ***`],
      [`echo "a"X-Api-Key: ${SECRET} b`, `echo "a"X-Api-Key: ***`],
    ]) {
      expect(asText(text), text).toBe(expected);
    }
  });
});

describe('the URLs of maskJevState: every scheme x every userinfo x every host', () => {
  const SCHEMES = ['postgresql', 'redis', 'amqp', 'mongodb+srv', 'ftp', 'http', 'https', 'mysql', 'rediss'];
  // [what stands between the scheme and the host, whether its password is a secret, what it becomes]
  const USERINFOS = [
    [`:${SECRET}@`, true, ':***@'],
    [`u:${SECRET}@`, true, 'u:***@'],
    [`user.name:${SECRET}@`, true, 'user.name:***@'],
    [`u%40x:${SECRET}@`, true, 'u%40x:***@'],
    [`u:a%3Ab${SECRET}@`, true, 'u:***@'],
    [`u:p@ss:${SECRET}@`, true, 'u:***@'],
    [`a@b:${SECRET}@`, true, 'a@b:***@'],
    [`u:!$&'()*+,;=${SECRET}@`, true, 'u:***@'],
    ['u:@', false, 'u:@'],
    [':@', false, ':@'],
    ['u@', false, 'u@'],
  ];
  const HOSTS = ['db', 'db:5432', '[::1]', '[::1]:5432', 'db.example.com:8080', '[2001:db8::7]'];
  const PATHS = ['', '/app', '/app?x=y#z'];

  it('is masked in every form, as the URL parser reads it, and a second pass changes nothing', () => {
    let cells = 0;
    for (const scheme of SCHEMES) {
      for (const [userinfo, secret, masked] of USERINFOS) {
        for (const host of HOSTS) {
          for (const path of PATHS) {
            const url = `${scheme}://${userinfo}${host}${path}`;
            const parsed = new URL(url);
            expect(parsed.password !== '', `${url}: the URL parser reads ${parsed.password === '' ? 'no ' : 'a '}password`).toBe(secret);
            const expected = `${scheme}://${masked}${host}${path}`;
            for (const text of [url, `connect to ${url} now`, `"${url}"`, `'${url}' x`, `DATABASE_URL=${url}`, `(${url})`]) {
              const out = asText(text);
              expect(out, text).toBe(text.replace(url, expected));
              expect(asText(out), `${text}: second pass`).toBe(out);
            }
            cells++;
          }
        }
      }
    }
    expect(cells).toBe(SCHEMES.length * USERINFOS.length * HOSTS.length * PATHS.length);
  });

  it('masks the end of a cut text at every place of the URL, as the whole text would, and never shows more', () => {
    const urls = [`postgresql://:${SECRET}@db/app`, `redis://u:${SECRET}@h:6379`, `http://u:p@ss:${SECRET}@h/x`, `mongodb+srv://a@b:${SECRET}@c.example/d`, `amqp://u:${SECRET}`, `ftp://u:${SECRET}@h`];
    for (const url of urls) {
      for (let into = 1; into <= url.length; into++) {
        // the window cuts the text `into` characters into the URL
        const text = `${'x '.repeat((MAX + WINDOW_MARGIN) / 2)}`.slice(0, MAX + WINDOW_MARGIN - into) + url + ' tail '.repeat(20);
        const out = asText(text, { maxChars: MAX });
        expect(out, `${url} cut ${into} characters in`).not.toContain('hunte');
        expect(out, `${url} cut ${into} characters in`).not.toContain('r2zzQ');
      }
    }
  });

  it('does not take what is no URL for one: no scheme and no //, an image digest, a git address, a mail address', () => {
    const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;
    for (const text of ['git@github.com:o/r', 'a@b.c', `docker pull img:tag@${digest}`, 'ssh user@host:path', 'see http://host/path@x and https://host:8080/p', 'see user:name@host', 'time 10:30@home']) {
      expect(asText(text), text).toBe(text);
    }
  });
});
