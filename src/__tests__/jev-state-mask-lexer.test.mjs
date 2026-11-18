/**
 * scripts/lib/jev-state-mask.mjs: the one shell lexer. Every option of the table (CREDENTIAL_OPTIONS) x the way its value is written
 * (bare, in double quotes, in single quotes, with an escaped quote inside, in ANSI-C quotes, next to other quotes) x what stands before
 * it in the command (a command boundary inside quotes, escaped or not, or inside a substitution), with the exact result of every cell,
 * and the rule that a window never shows more than the text without one.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_OPTIONS, PROGRAMS, WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

const SECRET = 'hunter2zzQ';
const MAX = 200;
const asText = (value, options) => maskJevState({ t: value }, options).t;

const rows = CREDENTIAL_OPTIONS.flatMap((option) => (option.names ?? [option.letter]).map((name) => ({
  opt: option.names ? `--${name}` : `-${name}`,
  kind: option.value,
  program: option.program,
  command: option.program ? PROGRAMS[option.program][0] : 'tool',
})));

// [name, the value as written, what it becomes]: a `name:password` value keeps its name and its quotes, any other goes whole
function valueForms(kind) {
  const user = kind === 'user';
  const u = user ? 'u:' : '';
  const kept = (open, quote) => (user ? `${open}${quote}u:***${quote}` : '***');
  return [
    ['bare', `${u}${SECRET}`, `${u}***`],
    ['double quotes', `"${u}a b ${SECRET}"`, kept('', '"')],
    ['single quotes', `'${u}a b ${SECRET}'`, kept('', "'")],
    ['double quotes with an escaped quote', `"${u}a\\" b ${SECRET}"`, kept('', '"')],
    ['double quotes with a backslash before the closing quote', `"${u}a b ${SECRET}\\\\"`, kept('', '"')],
    ['double quotes with separators', `"${u}a;b && c | ${SECRET}"`, kept('', '"')],
    ['single quotes with a backslash', `'${u}a\\ b ${SECRET}'`, kept('', "'")],
    ['ANSI-C quotes with an escaped quote', `$'${u}a\\' b ${SECRET}'`, kept('$', "'")],
    ['a quote in the middle of a word', `${u}a"b c"${SECRET}`, `${u}***`],
    ['quotes next to other quotes', `"${u}a"'b c'${SECRET}`, user ? '"u:***"' : '***'],
    ['an escaped space', `${u}a\\ b\\ ${SECRET}`, `${u}***`],
  ];
}

// what can stand before the option in its command, and keeps the program of the command (a boundary inside quotes, escaped or not,
// or inside a substitution, is no end of the command)
const BEFORE = [
  '',
  '-H "x;y"', '-H "x&&y"', '-H "x|y"', "-H 'x;y'", "-H 'x\\;y'",
  '-H "x\\";y"', '-H "x\\"&&y"', '-H "x\\"|y"', '-H "x\\\\" -H "y;z"', "-H $'x\\';y'", '-H "a\\"" -H "b;"',
  '-H "x $(a; b) y"', '$(a; b)', '`a; b`', '"$(a; "b c"; d)"', '(a; b)', '$(a; $(c; d); e)',
];

describe('the lexer of maskJevState: every option x every way to write its value x what stands before it', () => {
  it.each(rows.map((row) => [row.opt, row]))('%s', (_opt, row) => {
    let cells = 0;
    for (const [name, raw, masked] of valueForms(row.kind)) {
      for (const before of BEFORE) {
        const text = `${row.command} ${before} ${row.opt} ${raw} tail`;
        const expected = `${row.command} ${before} ${row.opt} ${masked} tail`;
        const label = `${name} after [${before}]: ${text}`;
        expect(asText(text), label).toBe(expected);
        expect(asText(text, { maxChars: MAX }), `${label} (window)`).toBe(expected);
        expect(asText(expected), `${label} (second pass)`).toBe(expected);
        cells++;
      }
    }
    expect(cells).toBe(valueForms(row.kind).length * BEFORE.length);
  });

  it.each(rows.filter((row) => row.program).map((row) => [row.opt, row]))('%s counts only in the command of its program, and the end of the command is found outside quotes only', (_opt, row) => {
    const same = (text) => expect(asText(text), text).toBe(text);
    const word = `${row.opt} ${row.kind === 'user' ? 'u:' : ''}${SECRET}`;
    // the command has ended, whatever stood in quotes before it
    same(`${row.command} -H "a\\";b" ; tool ${word} tail`);
    same(`${row.command} -H 'a;b' && tool ${word} tail`);
    same(`${row.command} -H "a\\\\" | tool ${word} tail`);
    same(`${row.command} $'a\\'b' ; tool ${word} tail`);
    same(`${row.command} $(a; b) ; tool ${word} tail`);
    same(`(${row.command} x)\ntool ${word} tail`);
  });

  it.each(rows.map((row) => [row.opt, row]))('%s: a window shows no more than the text without one, at every distance from its edge', (_opt, row) => {
    for (const [name, raw] of valueForms(row.kind)) {
      for (const before of ['', '-H "x\\";y"']) {
        const cell = `${row.command} ${before} ${row.opt} ${raw} tail`;
        for (let offset = MAX - 60; offset <= MAX + WINDOW_MARGIN + 60; offset += 41) {
          const filler = 'w '.repeat(Math.ceil(offset / 2)).slice(0, offset);
          const sent = asText(`${filler}\n${cell} ${'w '.repeat(100)}`, { maxChars: MAX }).slice(0, MAX);
          expect(sent, `${name} at ${offset}`).not.toContain('hunte');
        }
      }
    }
  });
});

describe('the lexer of maskJevState: where a word ends', () => {
  it.each([
    // the findings: an escaped quote does not end an argument in quotes, and a separator inside it does not end the command
    [`curl --user "name:pre\\"suffix ${SECRET}"`, 'curl --user "name:***"'],
    [`curl -H "X-Note: foo\\";bar" -U u:${SECRET} https://host`, 'curl -H "X-Note: foo\\";bar" -U u:*** https://host'],
    // a quote that never closes takes the rest of the text
    [`curl -u "u:a b ${SECRET}`, 'curl -u "u:***'],
    [`curl -u $'u:a b ${SECRET}`, "curl -u $'u:***"],
    [`curl -u 'u:a ${SECRET} \\' tail`, "curl -u 'u:***' tail"],
    // an option that is a quote of an outer shell: its value stops at the close of that quote, and an inner quote takes the rest of it
    [`sh -c "mysql -p ${SECRET}" tail`, 'sh -c "mysql -p ***" tail'],
    [`sh -c "mysql -p 'a b ${SECRET}' -e x" tail`, 'sh -c "mysql -p ***" tail'],
    [`sh -c "curl -u \\"u:a b ${SECRET}\\" h" tail`, 'sh -c "curl -u \\"u:***" tail'],
    [`bash -c 'mysql -u r -p"a b ${SECRET}" db' tail`, "bash -c 'mysql -u r -p***' tail"],
    [`sh -c "curl -H \\"a;b\\" -U u:${SECRET} h"`, 'sh -c "curl -H \\"a;b\\" -U u:*** h"'],
    // a substitution and a group are commands of their own, and give the outer command back
    [`curl $(a; b) -U u:${SECRET}`, 'curl $(a; b) -U u:***'],
    [`curl \`a; b\` -U u:${SECRET}`, 'curl `a; b` -U u:***'],
    [`curl "$(a "b;c" d)" -U u:${SECRET}`, 'curl "$(a "b;c" d)" -U u:***'],
    [`tool $(curl x) -U u:${SECRET}`, `tool $(curl x) -U u:${SECRET}`],
    [`mysql -p$(a b) tail`, 'mysql -p*** tail'],
    [`mysql -p"$(a b)" tail`, 'mysql -p*** tail'],
  ])('%s', (input, expected) => {
    expect(asText(input)).toBe(expected);
    expect(asText(input, { maxChars: MAX }), 'with a window').toBe(expected);
  });

  it('keeps the nesting bounded: a text nested deeper than the lexer reads is read to its end (fail closed), in time', () => {
    const deep = `curl ${'"$('.repeat(500)} x ${')"'.repeat(500)} -U u:${SECRET}`;
    expect(asText(deep)).not.toContain(SECRET);
    const started = performance.now();
    asText(`${'$('.repeat(2_000_000)} -U x`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
