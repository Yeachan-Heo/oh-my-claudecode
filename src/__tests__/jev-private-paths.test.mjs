/* global performance */
/**
 * Tests of the private path mask (scripts/lib/jev-private-paths.mjs, OMC_JEV_COMPACT_PRIVATE_PATHS) and of its use
 * through maskJevState. Every path is invented.
 */

import { homedir } from 'node:os';
import { parse } from 'node:path';
import { describe, expect, it } from 'vitest';

import { omitSecretLines } from '../../hooks/jev-compaction.mjs';
import { PRIVATE_PATH_MARKER, privatePathMask } from '../../scripts/lib/jev-private-paths.mjs';
import { JevStateMaskError, LINE_EXTENSION, SECRET_LINE, WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

const maskOf = (list, extra = {}) => privatePathMask({ OMC_JEV_COMPACT_PRIVATE_PATHS: list, ...extra });
const LIST = ' /vol/Acme-Ledger/ , x:\\Acme\\Plans,/depot/zeta.books,kappa-box,\\\\vault-host\\share';
const hide = maskOf(LIST);
const M = PRIVATE_PATH_MARKER;
const B = '\\';

describe('privatePathMask: without a usable entry', () => {
  it.each([[undefined], [''], [' , '], ['ab, /,C:\\'], ['%2F,..'], ['~'], ['~/, ~\\ ,~//,~%2F']])('there is no mask for %j', (value) => {
    expect(privatePathMask(value === undefined ? {} : { OMC_JEV_COMPACT_PRIVATE_PATHS: value })).toBeUndefined();
  });
});

describe('privatePathMask: spellings of a listed path', () => {
  it.each([
    'cat /vol/acme-ledger',
    'cat /VOL/ACME-LEDGER/2026/sum.csv',
    'cat /vol//acme-ledger///sum.csv',
    `cat ${B}vol${B}acme-ledger${B}sum.csv`,
    'cat /vol/acme-ledger/',
  ])('hides %j', (text) => {
    expect(hide(text)).toBe(`cat ${M}`);
  });

  it('hides a Windows path in its written forms and after file:///', () => {
    expect(hide(`open X:${B}Acme${B}Plans${B}q3.docx now`)).toBe(`open ${M} now`);
    expect(hide(`{"p":"x:${B}${B}acme${B}${B}plans"}`)).toBe(`{"p":"${M}"}`);
    expect(hide('see file:///x:/acme/plans/q3.docx')).toBe(`see file:///${M}`);
    expect(hide(`dir ${B}${B}vault-host${B}share${B}a`)).toBe(`dir ${M}`);
  });

  it.each([
    ['percent-encoded', 'u=%2Fvol%2Facme-ledger%2Fsum.csv'],
    ['percent-encoded, lower case', 'u=%2fvol%2facme-ledger'],
    ['encoded twice', 'u=%252Fvol%252Facme-ledger'],
    ['encoded three times', 'u=%25252Fvol%25252Facme-ledger'],
    ['encoded backslashes', 'u=%5Cvol%5Cacme-ledger'],
    ['a JSON escaped slash', `u=${B}/vol${B}/acme-ledger`],
    ['a doubly escaped slash', `u=${B}${B}/vol${B}${B}/acme-ledger`],
    ['a unicode escape', `u=${B}u002Fvol${B}u002facme-ledger`],
    ['a unicode escape in JSON in JSON', `u=${B}${B}${B}${B}u002Fvol${B}${B}u005cacme-ledger`],
    ['a hex escape', `u=${B}x2Fvol${B}x5Cacme-ledger`],
  ])('hides a path written %s', (_how, text) => {
    expect(hide(text)).toBe(`u=${M}`);
  });

  it('hides several paths in one text and quoted ones', () => {
    expect(hide('Then "/depot/zeta.books" and `/vol/acme-ledger`, x:/acme/plans; done')).toBe(`Then "${M}" and \`${M}\`, ${M}; done`);
  });

  it('hides a path at the end of a sentence', () => {
    expect(hide('Look into /vol/acme-ledger. Then /depot/zeta.books...')).toBe(`Look into ${M}. Then ${M}...`);
  });

  it('keeps longer names and other paths', () => {
    const text = 'Keep /vol/acme-ledgers/a, /vol/acme-ledger-old/b, /vol/acme-ledger.old/c, /depot/zetaXbooks, /vol/acme and %2Fvol%2Facme-ledgers.';
    expect(hide(text)).toBe(text);
  });

  it('counts a relative entry at the start of a path and after a separator', () => {
    expect(hide('read kappa-box/a.txt')).toBe(`read ${M}`);
    expect(hide('cat ./kappa-box/a.txt /work/kappa-box/a.txt')).toBe(`cat ./${M} /work/${M}`);
    expect(hide(`type .${B}kappa-box${B}a.txt`)).toBe(`type .${B}${M}`);
    expect(hide('read docs//KAPPA-box and docs%2Fkappa-box')).toBe(`read docs//${M} and docs%2F${M}`);
    expect(maskOf('notes/q3')('cat ../notes/q3/a and ./notes/q3')).toBe(`cat ../${M} and ./${M}`);
  });

  it('does not check what stands before an entry, only that the name ends with it', () => {
    expect(hide('old-kappa-box kappa-box-old')).toBe(`old-${M} kappa-box-old`);
  });

  it('reads a leading ~ as written and as the home directory of the system and of the environment', () => {
    const own = maskOf('~/vault-notes', { HOME: '/people/avery', USERPROFILE: undefined });
    for (const text of ['~/vault-notes/q3.txt', '/people/avery/vault-notes', `${homedir()}/vault-notes/a.md`]) expect(own(`cat ${text}`)).toBe(`cat ${M}`);
    // With the root as the home directory, ~/vault-notes also stands for /vault-notes, wherever it begins.
    if (parse(homedir()).root !== homedir()) expect(own('cat /people/other/vault-notes')).toBe('cat /people/other/vault-notes');
    const windows = maskOf('~\\vault-notes', { USERPROFILE: 'C:\\Users\\avery' });
    expect(windows('type C:/users/avery/vault-notes/q.txt')).toBe(`type ${M}`);
  });

  it('skips the entries ~ and ~/ and keeps the others of the list', () => {
    const own = maskOf('~,~/,/vol/acme-ledger', { HOME: '/people/avery' });
    const text = 'cat /people/avery/x ~/y';
    expect(own(text)).toBe(text);
    expect(own('cat /vol/acme-ledger/a')).toBe(`cat ${M}`);
  });

  it('reads a listed path as text, not as an expression, in any alphabet', () => {
    const own = maskOf('/vol/a+(b)[1],/vol/Bl\u00f8rv');
    expect(own('cat /vol/a+(b)[1]/x and /VOL/BL\u00d8RV/y')).toBe(`cat ${M} and ${M}`);
    expect(own('cat /vol/aab1')).toBe('cat /vol/aab1');
  });

  it('leaves a marker that is already there, whatever the list names', () => {
    const own = maskOf('private');
    expect(own(`private/a ${M} b`)).toBe(`${M} ${M} b`);
    expect(own(own('private/a'))).toBe(M);
  });

  it('reads the first 200 entries of a long list', () => {
    const list = Array.from({ length: 201 }, (_, i) => `/vol/entry-${i}-x`).join(',');
    expect(maskOf(list)('cat /vol/entry-0-x /vol/entry-199-x/a /vol/entry-200-x/a')).toBe(`cat ${M} ${M} /vol/entry-200-x/a`);
  });

  // The compaction module reads the same key and drops a whole line that names a listed path.
  it('changes every text whose line the compaction module drops for a listed path at the start of a path', () => {
    const paths = ['/vol/acme-ledger'];
    const texts = ['/vol/acme-ledger', '"/VOL/Acme-Ledger/a"', `${B}vol${B}acme-ledger`, `${B}/vol${B}/acme-ledger`, '/vol///acme-ledger.', 'file:///vol/acme-ledger/x'];
    for (const text of texts) {
      expect(omitSecretLines(text, paths), text).not.toBe(text);
      expect(hide(text), text).toContain(M);
    }
  });

  it('changes every text whose line the compaction module drops for a relative entry, after a separator too', () => {
    for (const text of ['kappa-box', './kappa-box/a.txt', '/work/KAPPA-BOX', `.${B}kappa-box`, 'file:///work/kappa-box']) {
      expect(omitSecretLines(text, ['kappa-box']), text).not.toBe(text);
      expect(hide(text), text).toContain(M);
    }
  });
});

describe('privatePathMask: time', () => {
  const own = maskOf('/vol/acme-ledger,/vol/a/b/c,kappa-box,x:/acme,~/vault-notes');
  it.each([
    ['/'],
    [B],
    ['%2F'],
    ['%25'],
    [`${B}u00`],
    [`${B.repeat(9)}u002F`],
    ['/vol'],
    ['/vol////'],
    ['x:/'],
    ['/vol/acme-ledger'],
    ['/vol/acme-ledger.'],
    ['kappa-box'],
    ['./kappa-box'],
    ['kappa-box/'],
    ['a/'],
    ['.'],
  ])('grows linearly with a long run of %j', (piece) => {
    const text = piece.repeat(Math.ceil(300_000 / piece.length));
    const start = performance.now();
    own(text);
    own(`/vol/acme-ledger${text}x`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('maskJevState with hidePaths', () => {
  const own = maskOf('/vol/acme-ledger,/vol/keys,secret-notes');

  it('hides the paths in every string and key', () => {
    const state = { '/vol/acme-ledger/k': 'v', cmd: 'cat /vol/acme-ledger/a\nls /tmp/other', deep: [{ cwd: '/VOL/ACME-LEDGER' }], n: 3 };
    expect(maskJevState(state, { hidePaths: own })).toEqual({ [M]: 'v', cmd: `cat ${M}\nls /tmp/other`, deep: [{ cwd: M }], n: 3 });
  });

  it('changes nothing without it', () => {
    const state = { cmd: 'cat /vol/acme-ledger/a' };
    expect(maskJevState(state, { hidePaths: privatePathMask({}) })).toEqual(state);
  });

  it('still omits a whole line that names a secret path, also when the listed path is part of that name', () => {
    const state = { cmd: 'cat /vol/keys/.env other-words\ncat /vol/keys/a\ncat secret-notes/.ssh/id_rsa words' };
    expect(maskJevState(state, { hidePaths: own })).toEqual({ cmd: `${SECRET_LINE}\ncat ${M}\n${SECRET_LINE}` });
    const home = maskOf('/people/avery');
    expect(maskJevState({ cmd: 'cat /people/avery/.ssh/id_rsa words\nok' }, { hidePaths: home })).toEqual({ cmd: `${SECRET_LINE}\nok` });
  });

  it('omits a line that names both even when the secret path stands further on than the omission reads', () => {
    const cmd = `ok\ncat /vol/acme-ledger/a ${'w '.repeat(WINDOW_MARGIN + LINE_EXTENSION)}/people/avery/.ssh/id_rsa`;
    expect(maskJevState({ cmd }, { maxChars: 200, hidePaths: own })).toEqual({ cmd: `ok\n${SECRET_LINE}` });
  });

  it('keeps no key block whose header shares a line with both paths', () => {
    const body = 'MIIfakeKeyBody00fakeKeyBody11';
    const cmd = `cat /vol/keys/.env -----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nok`;
    expect(maskJevState({ cmd }, { hidePaths: own })).toEqual({ cmd: `${SECRET_LINE}\nok` });
  });

  it('hides a path before the secret mask can change a part of it', () => {
    const listed = maskOf('/vol/acme-token=abcdef123456789/ledger');
    expect(maskJevState({ cmd: 'sum /vol/acme-token=abcdef123456789/ledger/may.csv' }, { hidePaths: listed })).toEqual({ cmd: `sum ${M}` });
  });

  it('sends no part of a path that stands as the value of a password option', () => {
    // The option rule takes the first part of the marker as the value; the rest of the marker stays.
    expect(maskJevState({ cmd: 'tool --password /vol/acme-ledger/pw.txt' }, { hidePaths: own })).toEqual({ cmd: 'tool --password *** path]' });
  });

  it('leaves no part of a path that the window would cut', () => {
    // Long paths before the end of the window: masked, they move what stood beyond the cut into what is sent.
    const maxChars = 200;
    const long = `/vol/acme-ledger/${'d'.repeat(WINDOW_MARGIN)}`;
    for (let pad = 0; pad < 40; pad++) {
      const text = `${long} ${'p'.repeat(pad)} /vol/acme-ledger/tail ${'z '.repeat(LINE_EXTENSION)}`;
      const { cmd } = maskJevState({ cmd: text }, { maxChars, hidePaths: own });
      expect(cmd.slice(0, maxChars), String(pad)).not.toMatch(/vol|ledg/i);
      expect(cmd.slice(0, maxChars)).toContain(M);
    }
  });

  it('refuses a state whose paths cannot be hidden', () => {
    const broken = () => {
      throw new Error('boom');
    };
    expect(() => maskJevState({ cmd: 'x' }, { hidePaths: broken })).toThrow(JevStateMaskError);
    expect(() => maskJevState({ cmd: 'x' }, { prose: broken })).toThrow(JevStateMaskError);
  });
});
