/**
 * Tests for the text scans of hooks/jev-compaction.mjs on hostile text. A helper that reads host tags in one pass gives the result of the regular
 * expression it replaces (a seeded differential with the expressions written out here), and each one reads tens of thousands of unclosed tags in a
 * small part of the time a backtracking scan takes (those took seconds, and a synchronous scan cannot be stopped by the deadline of the compaction).
 */

import { describe, expect, it } from 'vitest';

import {
  advisorNotes, agentBlocks, cutHostBlocks, isNotification, noteSummary, otherFrame, preludeLength, splitReminders, withoutPasteMarks, withoutTags, withoutTrailingClosers,
} from '../../hooks/jev-compaction.mjs';

const HOST_BLOCK = /<(system-reminder|task-notification|teammate-message|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>/g;
const PRELUDE = /^\s*<system-reminder[^>]*>[\s\S]*?<\/system-reminder[^>]*>\s*/;
const TRAILING_CLOSERS = /(?:\s*<\/system-reminder[^>]*>)+\s*$/;
const PASTE_MARKS = /\[pasted text moved at compaction: \d+ chars, full text in (?:(?!; start: ")[^\n])*; start: "(?:[^"\\\n]|\\[^\n])*"; end: "(?:[^"\\\n]|\\[^\n])*"\]/g;
const OTHER_FRAME = /^(?:.+ sent an? (?:new )?(?:message|report)|(?:A message|Messages) arrived .+|Activity (?:was observed )?in the bound conversation) while you were working(?:,.*)?:$/;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const REMINDER_BLOCK = /<system-reminder>\n[\s\S]*?\n<\/system-reminder>/g;
const ADVISOR_NOTE = /(?:^\s*|\n\n)<system-reminder>\n(?:# Advisor Tool\n[\s\S]*?|The advisor tool is available; the advisor instructions announced earlier apply\.|The advisor tool is no longer available; disregard the earlier advisor instructions\.)\n<\/system-reminder>(?=\n\n|\s*$)/g;
const NOTES = ['[SYSTEM NOTIFICATION - NOT USER INPUT]', '<task-notification>'];
function noteSummaryByRegExp(text) {
  const tag = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  if (tag && oneLine(tag[1])) return oneLine(tag[1]).slice(0, 200);
  let at = -1;
  for (const k of NOTES) { const i = text.indexOf(k); if (i >= 0 && (at < 0 || i + k.length < at)) at = i + k.length; }
  return ((at >= 0 ? text.slice(at) : text).split('\n').map((l) => oneLine(l.replace(/<[^>]*>/g, ' '))).find(Boolean) || '').slice(0, 200);
}

// The pieces each differential builds its texts from: tags with and without their partners, quotes, blank space, line ends.
const PIECES = {
  host: ['<system-reminder>', '</system-reminder>', '<task-notification>', '</task-notification>', '<teammate-message x="1">', '</teammate-message>', '<command-name>', '</command-name>', '<bash-stdout', '</bash-stdout>', '<system-reminderx>', '</system-reminder', '>', '<', 'x', ' ', '\n', '\u00a0', '"', 'text', '<local-command-stdout>', '</local-command-stdout>', '<bash-input>', '</bash-stderr>'],
  prelude: ['<system-reminder>', '<system-reminder id="a">', '</system-reminder>', '</system-reminder ', '</system-reminder id="a">', '</system-reminderx>', '>', '<', ' ', '\n', '\t', '\u00a0', 'x', '\ufeff', '</'],
  closers: ['</system-reminder>', '</system-reminder ', '</system-reminder id="x">', '</system-reminderx>', '<system-reminder>', '>', '<', 'x', ' ', '\n', ' \n ', '\t', '\u00a0', '</', '\r', '"', '\u2028'],
  tags: ['<', '>', 'a', ' ', '\n', '<a>', '</a>', '<<', '>>', 'x y', '\u00a0', '<b c="d">'],
  note: ['<summary>', '</summary>', '[SYSTEM NOTIFICATION - NOT USER INPUT]', '<task-notification>', '\n', ' ', 'x', '<', '>', '<b>', '</b>', 'line', '  ', '\u00a0', '<summary></summary>', '<summary> </summary>'],
  paste: ['[pasted text moved at compaction: ', '[pasted text moved at compaction: 5 chars; start: "a]b"; end: "c"]', '[pasted text moved at compaction: 5 chars, full text in /p; start: "a]b\\"c"; end: "d]"]', '[pasted text moved at compaction: 5 chars, full text in /p; start: "a"; end: "b"]', '5 chars, full text in ', '/p', '; start: "', '; end: "', '\\', '\\"', 'a]b', ']', '[', '[Keep it.]', '\n', '\r', '\u2028', 'x', ' ', '"', '[pasted text moved at compaction:'],
  reminder: ['<system-reminder>\n', '\n</system-reminder>', '<system-reminder>', '</system-reminder>', '\n', 'x', ' ', '<', '>', '\n\n', '<system-reminder id="a">\n'],
  advisor: ['<system-reminder>\n', '\n</system-reminder>', '# Advisor Tool\n', 'The advisor tool is available; the advisor instructions announced earlier apply.', 'The advisor tool is no longer available; disregard the earlier advisor instructions.', '\n\n', '\n', ' ', '\u00a0', '\u2028', 'x', 'The advisor tool is ', '# Advisor Tool', '\n\n<system-reminder>\n# Advisor Tool\n', '\n</system-reminder>\n\n'],
  frame: [' sent a message', ' sent an new report', ' sent a new message', ' sent an report', ' while you were working', ',', ':', 'A message arrived ', 'Messages arrived ', 'Activity ', 'was observed ', 'in the bound conversation', 'Activity in the bound conversation', 'Activity was observed in the bound conversation', 'x', ' ', '\r', '\u2028', '\u2029', '\n', 'sent a message', ' sent a', 'message', 'report', ' sent  a message', ':\n', ',:'],
};
const CASES = [
  ['cutHostBlocks', 'host', 12, (s) => [s.replace(HOST_BLOCK, ''), cutHostBlocks(s)]],
  ['preludeLength', 'prelude', 10, (s) => [PRELUDE.exec(s)?.[0].length ?? 0, preludeLength(s)]],
  ['withoutTrailingClosers', 'closers', 12, (s) => [s.replace(TRAILING_CLOSERS, ''), withoutTrailingClosers(s)]],
  ['withoutTags', 'tags', 12, (s) => [s.replace(/<[^>]*>/g, ' '), withoutTags(s)]],
  ['noteSummary', 'note', 12, (s) => [noteSummaryByRegExp(s), noteSummary(s)]],
  ['withoutPasteMarks', 'paste', 10, (s) => [s.replace(PASTE_MARKS, ''), withoutPasteMarks(s)]],
  ['otherFrame', 'frame', 9, (s) => [OTHER_FRAME.test(s.split('\n', 1)[0]), otherFrame(s)]],
  ['splitReminders', 'reminder', 12, (s) => [JSON.stringify({ reminders: s.match(REMINDER_BLOCK) || [], rest: s.replace(REMINDER_BLOCK, '') }), JSON.stringify(splitReminders(s))]],
  ['advisorNotes', 'advisor', 12, (s) => [(s.match(ADVISOR_NOTE) || []).length, advisorNotes(s)]],
];

describe('the one-pass scans give what the regular expressions they replace give', () => {
  it.each(CASES)('%s on 4000 seeded texts', (name, set, max, compare) => {
    let seed = 4242;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pieces = PIECES[set];
    const different = [];
    for (let n = 0; n < 4000; n++) {
      let text = '';
      for (let k = 1 + Math.floor(next() * max); k > 0; k--) text += pieces[Math.floor(next() * pieces.length)];
      const [expected, actual] = compare(text);
      if (expected !== actual) different.push({ text, expected, actual });
    }
    expect(different.slice(0, 3)).toEqual([]);
  });

  it('withoutPasteMarks cuts a trace at its own closing bracket and keeps what stands after it on the line', () => {
    const trace = '[pasted text moved at compaction: 2038 chars, full text in /p/e-aa-0.txt; start: "a] b [c"; end: "x\\" ] y"]';
    expect(withoutPasteMarks(`${trace} [Keep the second instruction exactly as given.]`)).toBe(' [Keep the second instruction exactly as given.]');
    expect(withoutPasteMarks(`${trace}[one]${trace} [two] ]`)).toBe('[one] [two] ]');
    expect(withoutPasteMarks(`before ${trace}\nafter [x]`)).toBe('before \nafter [x]');
    const open = '[pasted text moved at compaction: 5 chars, full text in /p; start: "a"; end: "b';
    expect(withoutPasteMarks(`${open} [x]`)).toBe(`${open} [x]`); // a mark that does not open a whole trace is the user's text
  });

  it('otherFrame reads the frames of the other senders and nothing near them', () => {
    expect(otherFrame('Session 3 sent a message while you were working:\nbody')).toBe(true);
    expect(otherFrame('The bridge sent an new report while you were working, on its own:')).toBe(true);
    expect(otherFrame('A message arrived from the bound chat while you were working:')).toBe(true);
    expect(otherFrame('Activity was observed in the bound conversation while you were working:')).toBe(true);
    expect(otherFrame('Activity in the bound conversation while you were working,:')).toBe(true);
    expect(otherFrame('sent a message while you were working:')).toBe(false); // no sender
    expect(otherFrame('Session 3 sent a message while you were working')).toBe(false); // no colon
    expect(otherFrame('Session 3 sent a message while you were working:\r\nbody')).toBe(false); // the line ends with a carriage return
    expect(otherFrame('Messages arrived while you were working:')).toBe(false); // nothing between "arrived" and "while"
  });
});

// A text of N tags without their partners is read in one pass: 40000 of them take about ten milliseconds, a backtracking scan took seconds.
const N = 40000;
const LIMIT_MS = 3000;
const rep = (unit, n = N) => unit.repeat(n);
const SHAPES = {
  open: rep('<system-reminder>'),
  openNoGt: rep('<system-reminder '),
  closersNoGt: `<system-reminder>${rep('</system-reminder ')}x`,
  closersEnd: `<system-reminder>x${rep('</system-reminder>')}`,
  closed: rep('<system-reminder>a</system-reminder>'),
  mixed: rep('<system-reminder>a</system-reminder><task-notification>'),
  taskOpen: rep('<task-notification>'),
  summaryOpen: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>${rep('<summary>')}`,
  teammateOpen: rep('<teammate-message x="a">'),
  teammateQuote: rep('<teammate-message a="'),
  teammateClosed: rep('<teammate-message a="b">x</teammate-message>'),
  teammateStray: rep('</teammate-message>'),
  lt: rep('<', N * 4),
  ltLine: `${rep('<a ')}\nx`,
  pasteMarks: rep('[pasted text moved at compaction: '),
  pasteHeads: rep('[pasted text moved at compaction: 5 chars, full text in /p ') + '; start: "a',
  pasteUnclosed: rep('[pasted text moved at compaction: 5 chars, full text in /p; start: "a'),
  pasteWhole: rep('[pasted text moved at compaction: 5 chars, full text in /p; start: "a]"; end: "b]"] [x] '),
  sent: rep('x sent a message while you were working,') + 'y',
  plain: 'lorem ipsum dolor sit amet '.repeat(40000), // about a megabyte, no tag
  reminderOpen: rep('<system-reminder>\n'),
  reminderClosed: rep('<system-reminder>\na\n</system-reminder>\n'),
  advisorOpen: rep('\n\n<system-reminder>\n# Advisor Tool\n'),
  advisorEndsInText: rep('\n\n<system-reminder>\n# Advisor Tool\n\n</system-reminder>x'),
  advisorBlank: `\n\n<system-reminder>\n# Advisor Tool\n${rep('\n</system-reminder> ')}x`,
};
const SCANS = [
  ['cutHostBlocks', cutHostBlocks, ['open', 'openNoGt', 'closersNoGt', 'closed', 'mixed', 'taskOpen', 'teammateOpen', 'lt', 'plain']],
  ['preludeLength', preludeLength, ['open', 'openNoGt', 'closersNoGt', 'closersEnd', 'closed', 'plain']],
  ['withoutTrailingClosers', withoutTrailingClosers, ['closersNoGt', 'closersEnd', 'closed', 'teammateStray', 'plain']],
  ['withoutTags', withoutTags, ['lt', 'ltLine', 'open', 'openNoGt', 'closed', 'plain']],
  ['noteSummary', noteSummary, ['summaryOpen', 'taskOpen', 'ltLine', 'lt', 'closed', 'plain']],
  ['withoutPasteMarks', withoutPasteMarks, ['pasteMarks', 'pasteHeads', 'pasteUnclosed', 'pasteWhole', 'plain']],
  ['otherFrame', otherFrame, ['sent', 'plain']],
  ['agentBlocks', agentBlocks, ['teammateOpen', 'teammateQuote', 'teammateClosed', 'teammateStray', 'lt', 'plain']],
  ['isNotification', (text) => isNotification({ role: 'user', text, toolUses: [] }), ['open', 'openNoGt', 'closersNoGt', 'mixed', 'taskOpen', 'summaryOpen', 'teammateOpen', 'plain']],
  ['splitReminders', splitReminders, ['reminderOpen', 'reminderClosed', 'open', 'plain']],
  ['advisorNotes', advisorNotes, ['advisorOpen', 'advisorEndsInText', 'advisorBlank', 'reminderOpen', 'reminderClosed', 'plain']],
];

describe('a text of tens of thousands of tags without partners is read in a fraction of a second', () => {
  for (const [name, scan, shapes] of SCANS) {
    it.each(shapes)(`${name} on %s`, (shape) => {
      const started = Date.now();
      scan(SHAPES[shape]);
      expect(Date.now() - started).toBeLessThan(LIMIT_MS);
    });
  }

  it('the scans leave a text without a complete block as it is and take the blocks of a text of closed ones', () => {
    expect(cutHostBlocks(SHAPES.open)).toBe(SHAPES.open);
    expect(cutHostBlocks(SHAPES.openNoGt)).toBe(SHAPES.openNoGt);
    expect(cutHostBlocks(SHAPES.closed)).toBe('');
    expect(cutHostBlocks(`words ${SHAPES.open} more`)).toBe(`words ${SHAPES.open} more`);
    expect(preludeLength(SHAPES.closersNoGt)).toBe(0);
    expect(withoutTrailingClosers(SHAPES.closersEnd)).toBe('<system-reminder>x');
    expect(agentBlocks(SHAPES.teammateClosed).blocks).toHaveLength(N);
    expect(agentBlocks(SHAPES.teammateOpen)).toMatchObject({ blocks: [], loose: true }); // an opener without its closing tag
    expect(agentBlocks(SHAPES.teammateStray)).toMatchObject({ blocks: [], loose: true }); // a closing tag without its opener
    expect(isNotification({ role: 'user', text: SHAPES.open, toolUses: [] })).toBe(false);
    expect(isNotification({ role: 'user', text: `${SHAPES.openNoGt}\nwords of the user`, toolUses: [] })).toBe(false);
    expect(splitReminders(SHAPES.reminderOpen)).toEqual({ reminders: [], rest: SHAPES.reminderOpen });
    expect(splitReminders(SHAPES.reminderClosed).reminders).toHaveLength(N);
    expect([advisorNotes(SHAPES.advisorOpen), advisorNotes(SHAPES.advisorEndsInText), advisorNotes(SHAPES.advisorBlank)]).toEqual([0, 0, 0]);
  });
});
