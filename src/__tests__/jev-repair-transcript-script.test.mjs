/* global process, Buffer */
/**
 * Tests for scripts/jev-repair-transcript.mjs (repair of transcripts that no longer resume after a Jev compaction).
 *
 * Written in .mjs for the same reason as jev-eval-script.test.mjs: the script is untyped plain Node.
 * Every transcript here is built in the test; no real transcript is read or stored.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { applyRepair, planRepair, repairTranscript, writeRepaired } from '../../scripts/jev-repair-transcript.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const SUFFIX_VALUES = 4096; // 'Z' plus three hex digits; written out here so that lowering the limit in the script fails the test
const SCRIPT = join(root, 'scripts', 'jev-repair-transcript.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'jev-repair-transcript-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeTranscript(text) {
  const dir = mkdtempSync(join(tmp, 'case-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, text);
  return { dir, path };
}

function run(...args) {
  const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const MA = 'msg_01AbCdEfGhIjKlMnOpQrStUv';
const MB = 'msg_01ZyXwVuTsRqPoNmLkJiHgFe';
const HEAD_A = MA.slice(0, -4);

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function row(type, n, parent, message, extra = {}) {
  return JSON.stringify({
    parentUuid: parent === null ? null : uuid(parent),
    type,
    uuid: uuid(n),
    timestamp: '2026-01-01T00:00:00.000Z',
    ...extra,
    ...(message ? { message } : {}),
  });
}
const block = {
  thinking: (text) => ({ type: 'thinking', thinking: text, signature: 'sig' }),
  server: (id) => ({ type: 'server_tool_use', id, name: 'advisor', input: {} }),
  result: (id) => ({ type: 'advisor_tool_result', tool_use_id: id, content: { type: 'advisor_result', text: 'ok' } }),
  use: (id) => ({ type: 'tool_use', id, name: 'Write', input: {} }),
  text: (text) => ({ type: 'text', text }),
};
const assistant = (id, content) => ({ id, role: 'assistant', content: [content] });
const userMessage = (text) => ({ role: 'user', content: text });

/**
 * The situation of a resumed transcript after a compaction (one block per row, as Claude Code 2.1 writes them):
 * rows 2-6 are one assistant message MA (advisor call) before the boundary; row 8 is the compact boundary, and rows 10-13
 * are copies of rows 2-5 written behind it with the same message id and new uuids. The chain from the last row stops at the
 * boundary, so rows 2-6 are off the chain. Line 1 is a line that is not JSON, row 2 has non-ASCII text, so byte offsets and
 * character offsets differ.
 */
function compactedTranscript() {
  const lines = [
    '{this line is not json',
    row('user', 1, null, userMessage('start')),
    row('assistant', 2, 1, assistant(MA, block.thinking('zażółć gęślą jaźń'))),
    row('assistant', 3, 2, assistant(MA, block.server('srvtoolu_01A'))),
    row('assistant', 4, 3, assistant(MA, block.result('srvtoolu_01A'))),
    row('assistant', 5, 4, assistant(MA, block.thinking('after the advice'))),
    row('assistant', 6, 5, assistant(MA, block.use('toolu_01A'))),
    row('user', 7, 6, userMessage('tool result')),
    row('system', 8, null, null, { subtype: 'compact_boundary', logicalParentUuid: uuid(7) }),
    row('user', 9, 8, userMessage('[trace]')),
    row('assistant', 10, 9, assistant(MA, block.thinking('zażółć gęślą jaźń'))),
    row('assistant', 11, 10, assistant(MA, block.server('srvtoolu_01A'))),
    row('assistant', 12, 11, assistant(MA, block.result('srvtoolu_01A'))),
    row('assistant', 13, 12, assistant(MA, block.thinking('after the advice'))),
    row('assistant', 14, 13, assistant(MB, block.text('next'))),
    row('user', 15, 14, userMessage('go on')),
  ];
  return `${lines.join('\n')}\n`;
}

// What the host does on resume: joins the assistant rows of one message id from the whole file.
function serverIdsPerMessage(text) {
  const joined = new Map();
  for (const line of text.split('\n')) {
    let object;
    try {
      object = JSON.parse(line);
    } catch {
      continue;
    }
    if (object.type !== 'assistant' || !object.message?.id) continue;
    if (!joined.has(object.message.id)) joined.set(object.message.id, []);
    for (const item of object.message.content) if (item.type === 'server_tool_use') joined.get(object.message.id).push(item.id);
  }
  return joined;
}
const hasRepeatedServerId = (text) => [...serverIdsPerMessage(text).values()].some((ids) => ids.length !== new Set(ids).size);

// Out-of-chain rows of message MA, each with the advisor call, plus a chain that holds the same call.
function manyOutsideRows(count, extraLines = []) {
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(row('assistant', 100 + i, 1, assistant(MA, block.server('srvtoolu_01A'))));
  lines.push(row('user', 1, null, userMessage('start')));
  lines.push(...extraLines);
  lines.push(row('assistant', 2, 1, assistant(MA, block.server('srvtoolu_01A'))));
  lines.push(row('user', 3, 2, userMessage('leaf')));
  return `${lines.join('\n')}\n`;
}

describe('planRepair', () => {
  it('finds the rows off the chain whose message the host would rejoin (Z33 case)', () => {
    const text = compactedTranscript();
    expect(hasRepeatedServerId(text)).toBe(true);
    const plan = planRepair(Buffer.from(text));
    expect(plan.rows).toBe(15);
    expect(plan.chain).toBe(8);
    expect(plan.messages).toBe(1);
    expect(plan.fixes.map((fix) => fix.line)).toEqual([3, 4, 5, 6, 7]);
    const ids = plan.fixes.map((fix) => fix.newId);
    expect(new Set(ids).size).toBe(5);
    for (const fix of plan.fixes) {
      expect(fix.messageId).toBe(MA);
      expect(fix.newId).toHaveLength(MA.length);
      expect(fix.newId).toMatch(new RegExp(`^${HEAD_A}Z[0-9a-f]{3}$`));
    }
  });

  it('changes only the message id of those rows, byte for byte, and the repaired file joins without a repeated id', () => {
    const original = Buffer.from(compactedTranscript());
    const plan = planRepair(original);
    const repaired = applyRepair(original, plan.fixes);
    expect(repaired).toHaveLength(original.length);
    expect(hasRepeatedServerId(repaired.toString('utf8'))).toBe(false);
    const before = original.toString('utf8').split('\n');
    const after = repaired.toString('utf8').split('\n');
    const fixedLines = new Set(plan.fixes.map((fix) => fix.line));
    for (let i = 0; i < before.length; i += 1) {
      if (!fixedLines.has(i + 1)) {
        expect(after[i]).toBe(before[i]);
        continue;
      }
      const changed = JSON.parse(after[i]);
      const expected = plan.fixes.find((fix) => fix.line === i + 1);
      expect(changed.message.id).toBe(expected.newId);
      changed.message.id = MA;
      expect(changed).toEqual(JSON.parse(before[i]));
    }
    // the message on the chain keeps its id
    expect(after.filter((line) => line.includes(`"id":"${MA}"`))).toHaveLength(4);
  });

  it('handles a duplicate message id of two rows with the same advisor call', () => {
    const text = `${[
      row('assistant', 2, null, assistant(MA, block.server('srvtoolu_01A'))),
      row('user', 1, null, userMessage('start')),
      row('assistant', 3, 1, assistant(MA, block.server('srvtoolu_01A'))),
      row('user', 4, 3, userMessage('leaf')),
    ].join('\n')}\n`;
    const plan = planRepair(Buffer.from(text));
    expect(plan.fixes.map((fix) => [fix.line, fix.messageId])).toEqual([[1, MA]]);
    expect(hasRepeatedServerId(applyRepair(Buffer.from(text), plan.fixes).toString('utf8'))).toBe(false);
  });

  it('leaves a message id shared with a row off the chain alone when no server_tool_use id would repeat', () => {
    const text = `${[
      row('assistant', 2, null, assistant(MA, block.text('first part'))),
      row('user', 1, null, userMessage('start')),
      row('assistant', 3, 1, assistant(MA, block.server('srvtoolu_01A'))),
      row('user', 4, 3, userMessage('leaf')),
    ].join('\n')}\n`;
    expect(planRepair(Buffer.from(text)).fixes).toEqual([]);
  });

  it('plans nothing for a healthy transcript, an empty file and a file without rows', () => {
    const healthy = `${[
      row('user', 1, null, userMessage('start')),
      row('assistant', 2, 1, assistant(MA, block.thinking('t'))),
      row('assistant', 3, 2, assistant(MA, block.server('srvtoolu_01A'))),
      row('assistant', 4, 3, assistant(MA, block.result('srvtoolu_01A'))),
      row('user', 5, 4, userMessage('leaf')),
    ].join('\n')}\n`;
    expect(planRepair(Buffer.from(healthy)).fixes).toEqual([]);
    expect(planRepair(Buffer.from('')).fixes).toEqual([]);
    expect(planRepair(Buffer.from('not json\n42\n[1]\n')).rows).toBe(0);
  });

  it('skips a new id that another row already uses', () => {
    const taken = row('assistant', 50, 1, assistant(`${HEAD_A}Z001`, block.text('other message')));
    const plan = planRepair(Buffer.from(manyOutsideRows(1, [taken])));
    expect(plan.fixes).toHaveLength(1);
    expect(plan.fixes[0].newId).toBe(`${HEAD_A}Z002`);
  });

  it(`uses all ${SUFFIX_VALUES} suffixes of one message id and then stops`, () => {
    const all = planRepair(Buffer.from(manyOutsideRows(SUFFIX_VALUES)));
    expect(all.fixes).toHaveLength(SUFFIX_VALUES);
    expect(new Set(all.fixes.map((fix) => fix.newId)).size).toBe(SUFFIX_VALUES);
    expect(() => planRepair(Buffer.from(manyOutsideRows(SUFFIX_VALUES + 1)))).toThrow(/no free message id/);
  });

  it('refuses a row it cannot rewrite exactly (spaced JSON)', () => {
    const spaced = JSON.stringify(JSON.parse(row('assistant', 2, null, assistant(MA, block.server('srvtoolu_01A')))), null, 1).replace(/\n\s*/g, ' ');
    const text = `${[
      spaced,
      row('user', 1, null, userMessage('start')),
      row('assistant', 3, 1, assistant(MA, block.server('srvtoolu_01A'))),
      row('user', 4, 3, userMessage('leaf')),
    ].join('\n')}\n`;
    expect(() => planRepair(Buffer.from(text))).toThrow(/was not found in the row/);
  });
});

describe('command line', () => {
  it('checks by default: lists the rows, exits 1, writes nothing', () => {
    const { dir, path } = writeTranscript(compactedTranscript());
    const before = readFileSync(path);
    const result = run(path);
    expect(result.code).toBe(1);
    expect(result.out).toContain('5 rows outside the chain (of 1 messages)');
    expect(result.out).toContain('check only, nothing written');
    expect(result.out).toMatch(new RegExp(`line 3: ${MA} -> ${HEAD_A}Z[0-9a-f]{3}`));
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['transcript.jsonl']);
  });

  it('--write repairs with a copy of the original next to it and no temporary file left', () => {
    const { dir, path } = writeTranscript(compactedTranscript());
    const before = readFileSync(path);
    const result = run(path, '--write');
    expect(result.code).toBe(0);
    expect(result.out).toContain('written; copy of the original:');
    expect(readdirSync(dir).sort()).toEqual(['transcript.jsonl', 'transcript.jsonl.pre-repair']);
    expect(readFileSync(`${path}.pre-repair`).equals(before)).toBe(true);
    const after = readFileSync(path);
    expect(after).toHaveLength(before.length);
    expect(after.equals(before)).toBe(false);
    expect(hasRepeatedServerId(after.toString('utf8'))).toBe(false);
  });

  it('is idempotent: a second run finds nothing, keeps the file and makes no second copy', () => {
    const { dir, path } = writeTranscript(compactedTranscript());
    expect(run(path, '--write').code).toBe(0);
    const repaired = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    const again = run(path, '--write');
    expect(again.code).toBe(0);
    expect(again.out).toContain('nothing to repair');
    expect(readFileSync(path).equals(repaired)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(readdirSync(dir).sort()).toEqual(['transcript.jsonl', 'transcript.jsonl.pre-repair']);
    expect(run(path).code).toBe(0);
  });

  it('leaves a healthy transcript untouched, also with --write', () => {
    const text = `${[
      row('user', 1, null, userMessage('start')),
      row('assistant', 2, 1, assistant(MA, block.server('srvtoolu_01A'))),
      row('user', 3, 2, userMessage('leaf')),
    ].join('\n')}\n`;
    const { dir, path } = writeTranscript(text);
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(path, old, old);
    const mtime = statSync(path).mtimeMs;
    const result = run(path, '--write');
    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to repair');
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(readdirSync(dir)).toEqual(['transcript.jsonl']);
  });

  it('never overwrites an existing copy', () => {
    const { dir, path } = writeTranscript(compactedTranscript());
    const before = readFileSync(path);
    writeFileSync(`${path}.pre-repair`, 'keep me');
    expect(run(path, '--write').code).toBe(0);
    expect(readFileSync(`${path}.pre-repair`, 'utf8')).toBe('keep me');
    expect(readFileSync(`${path}.pre-repair.1`).equals(before)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it('writes nothing when a row cannot be repaired (all suffixes taken)', () => {
    const text = manyOutsideRows(SUFFIX_VALUES + 1);
    const { dir, path } = writeTranscript(text);
    const result = run(path, '--write');
    expect(result.code).toBe(2);
    expect(result.out).toContain('no free message id');
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(readdirSync(dir)).toEqual(['transcript.jsonl']);
  });

  it('reports several files and exits with the worst code', () => {
    const bad = writeTranscript(compactedTranscript());
    const missing = join(tmp, 'does-not-exist.jsonl');
    const result = run(bad.path, missing, '--json');
    expect(result.code).toBe(2);
    const reports = JSON.parse(result.out);
    expect(reports[0].rowsToRepair).toBe(5);
    expect(reports[0].written).toBe(false);
    expect(reports[1].error).toMatch(/cannot read/);
  });

  it('exits 2 on a usage error', () => {
    expect(run().code).toBe(2);
    expect(run('--nope').code).toBe(2);
    expect(run('--nope').err).toContain('unknown flag: --nope');
  });
});

describe('writeRepaired / repairTranscript', () => {
  it('stops without changing anything when the file changed since it was read', () => {
    const { dir, path } = writeTranscript(compactedTranscript());
    const original = readFileSync(path);
    const repaired = applyRepair(original, planRepair(original).fixes);
    const appended = Buffer.concat([original, Buffer.from(`${row('user', 99, 15, userMessage('appended meanwhile'))}\n`)]);
    writeFileSync(path, appended);
    expect(() => writeRepaired(path, original, repaired)).toThrow(/changed while it was being repaired/);
    expect(readFileSync(path).equals(appended)).toBe(true);
    expect(readdirSync(dir)).toEqual(['transcript.jsonl']);
  });

  it('keeps the file mode and returns the report', () => {
    const { path } = writeTranscript(compactedTranscript());
    const report = repairTranscript(path, { write: true });
    expect(report.written).toBe(true);
    expect(report.rowsToRepair).toBe(5);
    expect(report.fixes[0]).toEqual({ line: 3, messageId: MA, newId: expect.stringMatching(/Z[0-9a-f]{3}$/) });
    expect(report.backup).toBe(`${path}.pre-repair`);
    const copy = join(dirname(path), 'copy.jsonl');
    copyFileSync(path, copy);
    expect(repairTranscript(copy).rowsToRepair).toBe(0);
  });
});
