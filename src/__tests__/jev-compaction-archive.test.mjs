/* global setTimeout, clearTimeout, Buffer */
/**
 * Tests for the archive of calls and results in hooks/jev-compaction.mjs (OMC_JEV_COMPACT_ARCHIVE=off|shadow|active, off when unset): every call and result the compaction traces,
 * shortens or removes goes whole to a file, the trace names the file once it was written and read back, and neighbouring traces of one identical call merge. No network; files are a
 * map in memory.
 */

import { describe, expect, it } from 'vitest';

import * as module from '../../hooks/jev-compaction.mjs';

const { archiveContentOf, archiveHeaderOf, archiveModeOf, archivePathOf, archivePlan, archiveResults, archiveSegment, archiveSkip, mergeSeries, mergeTraceEntries, readConfig, register, seriesContext, seriesItems, seriesRuns } = module;

const STATE = '/users/u/.omc/state/jev';
const ARCHIVE = `${STATE}/compaction-archive`;
const SESSION = 'sess-arch';
const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/users/u' };
const CFG = { archive: 'active', archiveDir: ARCHIVE, privatePaths: [] };

const row = (text, extra = {}) => ({ role: 'user', text, toolUses: [], ...extra });
const assistant = (text, toolUses = []) => ({ role: 'assistant', text, toolUses });
const talk = (n) => Array.from({ length: n }, (_, k) => (k % 2 ? assistant(`Answer ${k}.`) : row(`Question ${k}.`)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A candidate as findCandidates builds it, as far as the archive reads it. */
const cand = (id, text, { tool = 'Bash', input = { command: `cat ${id}.txt` }, isError = false, keep = 'trace', extra = {} } = {}) => ({ id, use: { tool, input }, res: { text, isError }, textOnly: true, secret: false, keep, ...extra });

/** A fake `$` for archiveResults: files in a map, with sizes in the list; delays, failures and hangs by path. */
function unitHost({ delay = 0, failWrite = () => false, corrupt = () => false, hang = () => false, initial = [] } = {}) {
  const files = new Map(initial);
  const stats = { writes: [], reads: [], active: 0, peak: 0 };
  const track = async (fn) => {
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    try { if (delay) await sleep(delay); return await fn(); } finally { stats.active--; }
  };
  const $ = {
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms >= 1000 ? 300 : ms); return { cancel: () => clearTimeout(t) }; } },
    fs: {
      list: async (dir) => [...files.entries()].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, t]) => ({ name: p.slice(dir.length + 1), kind: 'file', size: Buffer.byteLength(t) })),
      read: async (p) => {
        stats.reads.push(p);
        if (hang(p, 'read')) return new Promise(() => {});
        return track(async () => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); });
      },
      write: async (p, text) => {
        stats.writes.push(p);
        if (hang(p, 'write')) return new Promise(() => {});
        return track(async () => { if (failWrite(p)) throw new Error('disk full'); files.set(p, corrupt(p) ? text.slice(0, -1) : text); });
      },
    },
  };
  return { $, files, stats };
}

describe('archive: the switch and the paths', () => {
  it('the switch is off unless it says shadow or active, in any case and with spaces', () => {
    expect(archiveModeOf(undefined)).toBe('off');
    expect(archiveModeOf('')).toBe('off');
    expect(archiveModeOf('1')).toBe('off');
    expect(archiveModeOf('on')).toBe('off');
    expect(archiveModeOf(' Active ')).toBe('active');
    expect(archiveModeOf('SHADOW')).toBe('shadow');
  });

  it('readConfig reads the switch and puts the directory next to the pastes directory in the state directory', async () => {
    const read = (env) => readConfig({ env: { get: async (name) => ({ ...ACTIVE_ENV, ...env })[name] }, settings: { read: async () => undefined }, clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } } });
    expect(await read({})).toMatchObject({ archive: 'off', archiveDir: ARCHIVE });
    expect(await read({ OMC_JEV_COMPACT_ARCHIVE: 'active' })).toMatchObject({ archive: 'active', archiveDir: ARCHIVE });
    expect(await read({ OMC_JEV_COMPACT_ARCHIVE: 'shadow', OMC_JEV_LOG_DIR: '/elsewhere/jev' })).toMatchObject({ archive: 'shadow', archiveDir: '/elsewhere/jev/compaction-archive' });
  });

  it('a segment holds only letters, digits, underscore and hyphen; an id that had to change gets a hash of the original so two ids never share a file', () => {
    expect(archiveSegment('toolu_01AbC-x')).toBe('toolu_01AbC-x');
    expect(archiveSegment('')).toBe('');
    const a = archiveSegment('../../outside/file');
    const b = archiveSegment('..\\..\\outside\\file');
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('..');
    expect(a).not.toBe(b);
    expect(archiveSegment('a b')).not.toBe(archiveSegment('a_b'));
    expect(archiveSegment('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(archiveSegment('x'.repeat(200))).not.toBe(archiveSegment(`${'x'.repeat(199)}y`));
    expect(archiveSegment('con')).not.toBe('con');
    expect(archiveSegment('COM1')).not.toBe('COM1');
  });

  it('the path is the session directory and the id, undefined without a state directory, a session or an id; a notification is named by its text', () => {
    expect(archivePathOf(CFG, SESSION, cand('t1', 'x'))).toBe(`${ARCHIVE}/${SESSION}/t1.txt`);
    expect(archivePathOf({ ...CFG, archiveDir: undefined }, SESSION, cand('t1', 'x'))).toBeUndefined();
    expect(archivePathOf(CFG, '', cand('t1', 'x'))).toBeUndefined();
    expect(archivePathOf(CFG, SESSION, cand('', 'x'))).toBeUndefined();
    const noteA = { id: 'notification-3', note: true, res: { text: 'note A' } };
    const noteB = { id: 'notification-3', note: true, res: { text: 'note B' } };
    expect(archivePathOf(CFG, SESSION, noteA)).not.toBe(archivePathOf(CFG, SESSION, noteB));
    expect(archivePathOf(CFG, SESSION, noteA)).toBe(archivePathOf(CFG, SESSION, { ...noteA, id: 'notification-9' }));
  });
});

describe('archive: what goes to a file and what does not', () => {
  const why = (c, privatePaths = []) => archiveSkip(c, privatePaths);

  it('a plain call and result is archived; a call that may hold a secret is not, and the neighbour without one is', () => {
    expect(why(cand('a', 'plain output'))).toBe('');
    expect(why(cand('b', 'plain output', { extra: { secret: true } }))).toBe('secret');
    expect(why(cand('c', 'plain output', { extra: { proseSecret: true } }))).toBe('secret');
    expect(why(cand('d', 'plain output', { input: { command: 'cat ~/.ssh/id_rsa' } }))).toBe('secret');
    expect(why(cand('e', 'plain output', { input: { command: 'cat notes.txt' } }))).toBe('');
    expect(why(cand('f', 'plain output', { input: { command: 'printenv' } }))).toBe('secret');
    expect(why(cand('g', 'plain output', { input: { command: 'env | sort' } }))).toBe('secret');
    expect(why(cand('g2', 'plain output', { input: { command: 'environment-check.sh' } }))).toBe('');
    expect(why(cand('h', 'plain output', { input: { command: 'gh auth token' } }))).toBe('secret');
    expect(why(cand('i', 'plain output', { input: { command: 'gh pr list' } }))).toBe('');
    expect(why(cand('j', 'plain output', { tool: 'mcp__bitwarden__get_item', input: {} }))).toBe('secret');
    expect(why(cand('k', 'plain output', { tool: 'mcp__github__get_item', input: {} }))).toBe('');
    expect(why(cand('l', 'plain output', { input: { note: 'the password is hunter2' } }))).toBe('secret');
    expect(why(cand('m', 'plain output', { input: { note: 'the report is ready' } }))).toBe('');
    expect(why(cand('n', 'plain output', { input: { file_path: '/work/private/notes.md' } }), ['/work/private'])).toBe('secret');
    expect(why(cand('o', 'plain output', { input: { file_path: '/work/public/notes.md' } }), ['/work/private'])).toBe('');
  });

  it('a result that may hold a secret is not archived and the neighbour without one is: a secret path, a secret word, or text that masking changes', () => {
    expect(why(cand('a', 'built in 3 s'))).toBe('');
    expect(why(cand('b', 'see /users/u/.ssh/id_ed25519 for it'))).toBe('secret_in_result');
    expect(why(cand('c', 'the passphrase is in the vault'))).toBe('secret_in_result');
    expect(why(cand('d', 'API_KEY=abcdef0123456789abcdef'))).toBe('secret_in_result');
    expect(why(cand('e', 'Authorization: Bearer abcdefghijklmnopqrstuvwx'))).toBe('secret_in_result');
    expect(why(cand('f', 'shipped the keyboard layout'))).toBe('');
    expect(why(cand('g', 'a result under a private path', {}), ['a result under'])).toBe('secret_in_result');
  });

  it('a result without text, an empty one, one over the host limit and a text an earlier compaction wrote are not archived', () => {
    expect(why({ ...cand('a', 'x'), textOnly: false })).toBe('no_text');
    expect(why(cand('b', ''))).toBe('empty');
    expect(why(cand('c', 'x'.repeat(4194304)))).toBe('over_limit');
    expect(why(cand('d', 'x'.repeat(4194304 - 4000)))).toBe('');
    expect(why(cand('e', 'the start\n[result shortened at compaction: kept 300 of 9000 chars]'))).toBe('after_compaction');
    expect(why(cand('f', '[compacted] Bash(ls) - result of 40 chars removed'))).toBe('after_compaction');
    expect(why(cand('g', '[SYSTEM NOTIFICATION - NOT USER INPUT]\n[notification shortened at compaction: kept 300 of 9000 chars]'))).toBe('after_compaction');
  });

  it('shadow plans without touching a file: the counts per reason, none for a result that stays whole', () => {
    const list = [cand('a', 'plain'), cand('b', 'the password is x'), cand('c', ''), cand('d', 'plain', { keep: 'full' }), cand('e', 'plain', { extra: { secret: true } })];
    const plan = archivePlan(list);
    expect(plan.planned).toBe(1);
    expect(plan.skipped).toEqual({ secret_in_result: 1, empty: 1, secret: 1 });
    expect(plan.byId.has('d')).toBe(false);
    expect(plan.byId.get('a')).toEqual({ id: 'a' });
  });
});

describe('archive: the file', () => {
  it('the head names the call and its input, masked; the result follows unchanged; an error says so', () => {
    const c = cand('t1', 'line one\nline two  \n', { tool: 'Bash', input: { command: 'echo hi', token: 'abc123def456ghi', password: 'hunter2', cookie: 'plainvalue', headers: [{ name: 'api_key', value: 'zzz' }, { name: 'accept', value: 'json' }], note: 'sk-ant-abcdefghijklmnopqrst' } });
    const content = archiveContentOf(c);
    expect(content).toMatch(/^\[compaction archive\] call Bash, tool_use_id t1\n--- input \(masked\) ---\n/);
    expect(content.endsWith('--- result (20 chars, unchanged) ---\nline one\nline two  \n')).toBe(true);
    const head = content.slice(0, content.indexOf('--- result'));
    expect(head).toContain('"command": "echo hi"');
    expect(head).toContain('"token": "***"');
    expect(head).toContain('"cookie": "***"');
    expect(head).not.toContain('plainvalue');
    expect(head).not.toContain('hunter2');
    expect(head).not.toContain('abc123def456ghi');
    expect(head).not.toContain('zzz');
    expect(head).toContain('"value": "json"');
    expect(head).not.toContain('sk-ant-abcdefghijklmnopqrst');
    expect(archiveContentOf(cand('t2', 'boom', { isError: true }))).toContain('--- error (4 chars, unchanged) ---\nboom');
  });

  it('a notification has no call: its head says so', () => {
    const note = { id: 'notification-4', note: true, res: { text: 'the task ended' }, use: { tool: 'notification', input: {} } };
    expect(archiveHeaderOf(note)).toBe('[compaction archive] background task notification\n--- content (14 chars, unchanged) ---\n');
  });
});

describe('archive: writing the files', () => {
  const run = (host, list, opts = {}, cfg = CFG) => archiveResults(host.$, cfg, SESSION, list, opts);

  it('writes each item whole to its file, reads it back, and names it only then; items that stay whole are left alone', async () => {
    const host = unitHost();
    const list = [cand('t1', 'result one'), cand('t2', 'result two', { keep: 'drop' }), cand('t3', 'result three', { keep: 'full' }), cand('t4', 'the password is x'), cand('t5', 'result five', { keep: 'short' })];
    const out = await run(host, list, { marker: true });
    expect(out).toMatchObject({ written: 3, reused: 0, rewritten: 0, errors: 0, timedOut: 0, marker: true, skipped: { secret_in_result: 1 } });
    for (const id of ['t1', 't2', 't5']) {
      expect(out.byId.get(id).path).toBe(`${ARCHIVE}/${SESSION}/${id}.txt`);
      expect(host.files.get(`${ARCHIVE}/${SESSION}/${id}.txt`)).toBe(archiveContentOf(list.find((c) => c.id === id)));
    }
    expect(out.byId.get('t4')).toEqual({ id: 't4', bytes: 0, skipped: 'secret_in_result' });
    expect(out.byId.has('t3')).toBe(false);
    expect([...host.files.keys()].sort()).toEqual([`${ARCHIVE}/${SESSION}/.compaction`, `${ARCHIVE}/${SESSION}/t1.txt`, `${ARCHIVE}/${SESSION}/t2.txt`, `${ARCHIVE}/${SESSION}/t5.txt`]);
    expect(out.bytes).toBe(['t1', 't2', 't5'].reduce((n, id) => n + Buffer.byteLength(host.files.get(`${ARCHIVE}/${SESSION}/${id}.txt`)), 0));
    expect(host.files.get(`${ARCHIVE}/${SESSION}/t4.txt`)).toBeUndefined();
  });

  it('the marker is written first, only with the option, and an empty batch leaves no directory', async () => {
    const host = unitHost();
    await run(host, [cand('t1', 'one')]);
    expect(host.files.has(`${ARCHIVE}/${SESSION}/.compaction`)).toBe(false);
    const marked = unitHost();
    await run(marked, [cand('t1', 'one')], { marker: true });
    expect(marked.stats.writes[0]).toBe(`${ARCHIVE}/${SESSION}/.compaction`);
    const none = unitHost();
    const out = await run(none, [cand('t1', 'one', { keep: 'full' })]);
    expect(none.files.size).toBe(0);
    expect(out.written).toBe(0);
    const noSession = await archiveResults(none.$, CFG, '', [cand('t1', 'one')]);
    expect(noSession.skipped).toEqual({ no_session: 1 });
    expect(none.files.size).toBe(0);
  });

  it('a file that holds the same text is reused and not written again; a file of the same size with other text, or of another size, is written again', async () => {
    const c = cand('t1', 'result one');
    const path = `${ARCHIVE}/${SESSION}/t1.txt`;
    const same = unitHost({ initial: [[path, archiveContentOf(c)]] });
    const a = await run(same, [c]);
    expect(a).toMatchObject({ written: 0, reused: 1, rewritten: 0 });
    expect(same.stats.writes).toEqual([]);
    expect(a.byId.get('t1').path).toBe(path);
    const content = archiveContentOf(c);
    const sameSize = unitHost({ initial: [[path, `${content.slice(0, -1)}#`]] });
    const b = await run(sameSize, [c]);
    expect(b).toMatchObject({ written: 1, reused: 0, rewritten: 1 });
    expect(sameSize.files.get(path)).toBe(content);
    const longer = unitHost({ initial: [[path, `${content} and more`]] });
    const d = await run(longer, [c]);
    expect(d).toMatchObject({ written: 1, rewritten: 0 });
    expect(longer.files.get(path)).toBe(content);
  });

  it('a result that an earlier compaction cut and that names its file keeps pointing at that file: reused, never overwritten with the cut text', async () => {
    const path = `${ARCHIVE}/${SESSION}/t1.txt`;
    const full = archiveContentOf(cand('t1', 'the whole result '.repeat(100)));
    const cut = cand('t1', `the whole result the whole result\n[result shortened at compaction: kept 300 of 1700 chars; full call and result: ${path}]`);
    const host = unitHost({ initial: [[path, full]] });
    const out = await run(host, [cut]);
    expect(out).toMatchObject({ written: 0, reused: 1 });
    expect(out.byId.get('t1').path).toBe(path);
    expect(host.files.get(path)).toBe(full);
    expect(host.stats.writes).toEqual([]);
    const gone = unitHost();
    const none = await run(gone, [cut]);
    expect(none.byId.get('t1')).toMatchObject({ skipped: 'after_compaction' });
    expect(gone.files.size).toBe(0);
    const other = cand('t1', 'cut text\n[result shortened at compaction: kept 300 of 1700 chars; full call and result: /elsewhere/t1.txt]');
    const third = unitHost({ initial: [[path, full]] });
    expect((await run(third, [other])).byId.get('t1')).toMatchObject({ skipped: 'after_compaction' });
    expect(third.files.get(path)).toBe(full);
  });

  it('a write that fails, or a file that does not read back equal, gives no path: the item is counted as an error and no trace may name it', async () => {
    const list = [cand('t1', 'one'), cand('t2', 'two'), cand('t3', 'three')];
    const failing = unitHost({ failWrite: (p) => p.endsWith('/t2.txt') });
    const a = await run(failing, list);
    expect(a).toMatchObject({ written: 2, errors: 1 });
    expect(a.byId.get('t2').path).toBeUndefined();
    expect(a.byId.get('t2').error).toContain('disk full');
    expect(a.byId.get('t1').path).toBeDefined();
    const corrupt = unitHost({ corrupt: (p) => p.endsWith('/t3.txt') });
    const b = await run(corrupt, list);
    expect(b).toMatchObject({ written: 2, errors: 1 });
    expect(b.byId.get('t3')).toMatchObject({ error: 'read_mismatch' });
    expect(b.byId.get('t3').path).toBeUndefined();
    const unchecked = await run(unitHost({ corrupt: (p) => p.endsWith('/t3.txt') }), list, { verify: false });
    expect(unchecked.errors).toBe(0);
  });

  it('at most eight files are in flight at a time', async () => {
    const host = unitHost({ delay: 12 });
    const list = Array.from({ length: 30 }, (_, k) => cand(`t${k}`, `result ${k}`));
    const out = await run(host, list);
    expect(out.written).toBe(30);
    expect(host.stats.peak).toBeLessThanOrEqual(8);
    expect(host.stats.peak).toBeGreaterThan(1);
    const serial = unitHost({ delay: 5 });
    await run(serial, list.slice(0, 6), { parallel: 1 });
    expect(serial.stats.peak).toBe(1);
  });

  it('no write starts after the time of the batch: the rest is skipped as time, with no file and no path', async () => {
    const host = unitHost({ delay: 25 });
    const list = Array.from({ length: 40 }, (_, k) => cand(`t${k}`, `result ${k}`));
    const out = await run(host, list, { budgetMs: 60 });
    expect(out.written).toBeGreaterThan(0);
    expect(out.written).toBeLessThan(40);
    expect(out.skipped.time).toBe(40 - out.written);
    expect(out.timedOut).toBe(out.skipped.time);
    expect(host.files.size).toBe(out.written);
    for (const c of list) if (out.byId.get(c.id).skipped === 'time') expect(host.files.has(`${ARCHIVE}/${SESSION}/${c.id}.txt`)).toBe(false);
    const all = unitHost({ delay: 5 });
    expect((await run(all, list.slice(0, 20), { budgetMs: Infinity })).written).toBe(20);
  });

  it('nothing starts after the compaction\'s own deadline, not even the list or the marker', async () => {
    const host = unitHost();
    const out = await run(host, [cand('t1', 'one'), cand('t2', 'two')], { leftMs: 0, marker: true });
    expect(out.skipped).toEqual({ time: 2 });
    expect(host.stats.writes).toEqual([]);
    expect(host.stats.reads).toEqual([]);
    expect(out.marker).toBe(false);
  });

  it('after a host call hit its cap no call starts at all: the item is an error, the rest is skipped', async () => {
    const host = unitHost({ hang: (p, op) => op === 'write' && p.endsWith('/t1.txt') });
    const list = Array.from({ length: 5 }, (_, k) => cand(`t${k + 1}`, `result ${k + 1}`));
    const out = await run(host, list, { parallel: 1 });
    expect(out.stalled).toBe(true);
    expect(out.byId.get('t1')).toMatchObject({ error: 'host_time' });
    expect(out.skipped).toEqual({ time: 4 });
    expect(out.timedOut).toBe(5);
    expect(host.stats.writes).toEqual([`${ARCHIVE}/${SESSION}/t1.txt`]);
  });

  it('an input that cannot be scanned counts as a secret and does not throw out of the batch', async () => {
    const circular = { command: 'x' };
    circular.self = circular;
    const host = unitHost();
    const out = await run(host, [cand('t1', 'one', { input: circular }), cand('t2', 'two')]);
    expect(out.byId.get('t2').path).toBeDefined();
    expect(out.byId.get('t1')).toEqual({ id: 't1', bytes: 0, skipped: 'secret' });
    expect(host.files.has(`${ARCHIVE}/${SESSION}/t1.txt`)).toBe(false);
  });
});

describe('archive: merging neighbouring traces of one identical call', () => {
  const trace = (id, extra = {}) => ({ kind: 'trace', id, tool: 'Read', target: 'a.txt', key: 'k1', msg: 0, line: `[compacted] Read(a.txt) - result of 100 chars removed; full call and result: ${ARCHIVE}/${SESSION}/${id}.txt`, resultChars: 100, isError: false, note: false, textOnly: true, path: `${ARCHIVE}/${SESSION}/${id}.txt`, ...extra });

  it('two or more neighbours with the same tool, the same whole input and the same API message become one entry with a counter, the sizes added and the files listed', () => {
    const out = mergeTraceEntries([{ kind: 'text', text: 'Step.' }, trace('t1'), trace('t2', { resultChars: 250, isError: true }), trace('t3'), { kind: 'call' }]);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ merged: true, id: 't1', ids: ['t1', 't2', 't3'], count: 3, resultChars: 450, errors: 1 });
    expect(out[1].line).toBe(`[compacted] Read(a.txt) x3 - results of 450 chars removed, including 1 error; full calls and results: ${ARCHIVE}/${SESSION}/ (t1.txt, t2.txt, t3.txt)`);
  });

  it('different calls of one target never merge: another input (a read at another offset), another tool, another API message', () => {
    const other = (id, extra) => trace(id, extra);
    expect(mergeTraceEntries([trace('t1'), other('t2', { key: 'k2' })]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1'), other('t2', { tool: 'Grep' })]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1'), other('t2', { msg: 1 })]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1'), other('t2')]).some((e) => e.merged)).toBe(true);
  });

  it('a kept call, a kept result or any text between two traces parts them, a blank text does not, and a notification or a result without text never merges', () => {
    expect(mergeTraceEntries([trace('t1'), { kind: 'call' }, trace('t2')]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1'), { kind: 'result' }, trace('t2')]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1'), { kind: 'text', text: 'words' }, trace('t2')]).some((e) => e.merged)).toBe(false);
    const blank = mergeTraceEntries([trace('t1'), { kind: 'text', text: '  \n' }, trace('t2')]);
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatchObject({ merged: true, count: 2 });
    expect(mergeTraceEntries([trace('t1', { note: true }), trace('t2', { note: true })]).some((e) => e.merged)).toBe(false);
    expect(mergeTraceEntries([trace('t1', { textOnly: false }), trace('t2', { textOnly: false })]).some((e) => e.merged)).toBe(false);
  });

  it('a run that holds traces without a file names the files it has, "k of n"; files in several directories are listed whole', () => {
    const run = mergeTraceEntries([trace('t1'), trace('t2', { path: undefined }), trace('t3', { path: '/other/dir/t3.txt' })]);
    expect(run[0].line).toContain(`; full calls and results 2 of 3: ${ARCHIVE}/${SESSION}/t1.txt, /other/dir/t3.txt`);
    expect(mergeTraceEntries([trace('t1', { path: undefined }), trace('t2', { path: undefined })])[0].line).toBe('[compacted] Read(a.txt) x2 - results of 200 chars removed');
    expect(mergeTraceEntries([trace('t1', { isError: true }), trace('t2', { isError: true })])[0].line).toContain(', including 2 errors');
  });
});

describe('archive: in the compaction', () => {
  /** One compaction through register(on); Jev scores every result 0, so every result is cut. `fsFail` makes the write of a path throw, `corrupt` makes one read back wrong. */
  async function compactRun(env, messages, { tokens = 30000, score = 0, fsFail = () => false, corrupt = () => false, preset = [] } = {}) {
    const store = new Map(preset);
    const e = { ...ACTIVE_ENV, ...env };
    const api = [];
    for (const m of messages) {
      const content = m.role === 'assistant'
        ? [{ type: 'text', text: m.text }, ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
        : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
      if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
    }
    const $ = {
      env: { get: async (n) => e[n] },
      settings: { read: async () => undefined },
      fs: {
        read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); },
        exists: async (p) => store.has(p),
        stat: async () => ({ kind: 'file', size: 1, mtimeMs: 0, isLink: false }),
        write: async (p, t) => { if (fsFail(p)) throw new Error('disk full'); store.set(p, corrupt(p) ? `${t}!` : t); },
        list: async (dir) => [...store.entries()].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, t]) => ({ name: p.slice(dir.length + 1), kind: 'file', size: Buffer.byteLength(t) })),
      },
      http: { fetch: async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: 'score', score, confidence: 0.9 }])) }) }; } },
      clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('sleep'); } },
      session: { id: async () => SESSION, usage: async () => ({ context: { tokens, window: 200000 } }), messages: async (o) => (o?.as === 'api' ? api : messages), compact: async () => ({}) },
      ui: { log: () => {}, toast: () => {} },
    };
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const out = await handlers['session.compact']($, Object.freeze({ trigger: 'manual', messages }), async () => ({ messages: [] }));
    const record = [...store.entries()].filter(([p]) => p.includes('compaction-spool')).map(([, t]) => JSON.parse(t)).find((r) => r.event === 'compact');
    return { out, record, store, archived: () => new Map([...store.entries()].filter(([p]) => p.startsWith(`${ARCHIVE}/`) && !p.endsWith('/.compaction'))) };
  }

  const pair = (i, tool, input, text, isError = false) => [assistant(`Step ${i}.`, [{ tool_use_id: `t${i}`, tool, input }]), row('', { toolResults: [{ tool_use_id: `t${i}`, text, isError }] })];
  const body = (i) => `Line of notes ${i}. `.repeat(400);
  /** Twelve results to cut (the sixth and the eighth are for the secret checks), among talk. */
  function shape({ results = (i) => body(i), inputs = (i) => ({ command: `cat notes-${i}.txt` }) } = {}) {
    const w = talk(30);
    return [w[0], ...Array.from({ length: 12 }, (_, i) => pair(i + 1, 'Bash', inputs(i + 1), results(i + 1))).flat(), ...w.slice(1)];
  }
  const CASCADE = { OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
  const textsOf = (out) => (out.messages || []).flatMap((m) => [m.text ?? '', ...(m.toolResults || []).map((r) => r.text)]);
  const traceLinesOf = (out) => textsOf(out).flatMap((t) => t.split('\n')).filter((l) => l.startsWith('[compacted] '));

  it('active: every cut result is written whole under the session, and its trace names the file; the record counts them', async () => {
    const { out, record, archived } = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape());
    expect(record).toMatchObject({ result: 'jev', archive_mode: 'active', archive_written: 12, archive_reused: 0, archive_errors: 0, archive_marker: true, merged_traces: 0 });
    expect(record.archive_bytes).toBeGreaterThan(12 * 6800);
    expect(archived().size).toBe(12);
    const lines = traceLinesOf(out);
    expect(lines).toHaveLength(12);
    for (const [k, line] of lines.entries()) {
      const path = `${ARCHIVE}/${SESSION}/t${k + 1}.txt`;
      expect(line).toBe(`[compacted] Bash(cat notes-${k + 1}.txt) - result of ${body(k + 1).length} chars removed; full call and result: ${path}`);
      expect(archived().get(path)).toMatch(new RegExp(`^\\[compaction archive\\] call Bash, tool_use_id t${k + 1}\\n--- input \\(masked\\) ---\\n\\{\\n  "command": "cat notes-${k + 1}.txt"\\n\\}\\n--- result \\(${body(k + 1).length} chars, unchanged\\) ---\\nLine of notes ${k + 1}\\. `));
      expect(archived().get(path).endsWith(body(k + 1))).toBe(true);
    }
  });

  it('a call and a result that may hold a secret stay out of the archive and their trace names no file, next to neighbours that are archived', async () => {
    const results = (i) => (i === 6 ? `${body(i)} and the password is hunter2` : i === 8 ? `${body(i)} API_KEY=abcdef0123456789abcdef` : body(i));
    const inputs = (i) => (i === 3 ? { command: 'cat ~/.ssh/id_rsa' } : { command: `cat notes-${i}.txt` });
    const { out, record, archived } = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape({ results, inputs }));
    expect(record).toMatchObject({ archive_written: 9, archive_skipped: { secret: 1, secret_in_result: 2 } });
    const names = [...archived().keys()].map((p) => p.split('/').pop());
    expect(names).not.toContain('t3.txt');
    expect(names).not.toContain('t6.txt');
    expect(names).not.toContain('t8.txt');
    expect(names).toContain('t5.txt');
    expect(names).toContain('t7.txt');
    for (const text of archived().values()) { expect(text).not.toContain('hunter2'); expect(text).not.toContain('abcdef0123456789abcdef'); }
    const lines = traceLinesOf(out);
    expect(lines.filter((l) => l.includes('full call and result: '))).toHaveLength(9);
    expect(lines.find((l) => l.includes('notes-6.txt'))).toBe(`[compacted] Bash(cat notes-6.txt) - result of ${`${body(6)} and the password is hunter2`.length} chars removed`);
    expect(lines.find((l) => l.includes('id_rsa'))).not.toContain('full call and result');
    expect(lines.find((l) => l.includes('notes-5.txt'))).toContain(`${ARCHIVE}/${SESSION}/t5.txt`);
  });

  it('a trace names its file only when the file was written and read back: a failed write or a bad read leaves the trace without a path and counts an error', async () => {
    const failed = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape(), { fsFail: (p) => p.endsWith('/t2.txt') });
    expect(failed.record).toMatchObject({ archive_written: 11, archive_errors: 1 });
    expect(traceLinesOf(failed.out).find((l) => l.includes('notes-2.txt'))).toBe(`[compacted] Bash(cat notes-2.txt) - result of ${body(2).length} chars removed`);
    expect(traceLinesOf(failed.out).filter((l) => l.includes('full call and result: '))).toHaveLength(11);
    const bad = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape(), { corrupt: (p) => p.endsWith('/t4.txt') });
    expect(bad.record).toMatchObject({ archive_written: 11, archive_errors: 1 });
    expect(traceLinesOf(bad.out).find((l) => l.includes('notes-4.txt'))).not.toContain('full call and result');
  });

  it('a second compaction finds the files written and reuses them without writing again', async () => {
    const first = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape());
    const preset = [...first.archived().entries()];
    const second = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape(), { preset });
    expect(second.record).toMatchObject({ archive_written: 0, archive_reused: 12, archive_errors: 0 });
    expect(traceLinesOf(second.out).filter((l) => l.includes('full call and result: '))).toHaveLength(12);
  });

  it('shadow only counts: no file, no path, and the conversation is the one built without the switch', async () => {
    const off = await compactRun(CASCADE, shape());
    const shadow = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'shadow' }, shape());
    expect(shadow.archived().size).toBe(0);
    expect([...shadow.store.keys()].some((p) => p.includes('compaction-archive'))).toBe(false);
    expect(shadow.out.messages).toEqual(off.out.messages);
    expect(shadow.record).toMatchObject({ result: 'jev', archive_mode: 'shadow', archive_planned: 12, merged_traces: 0 });
    expect(shadow.record).not.toHaveProperty('archive_written');
    const withSecret = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'shadow' }, shape({ results: (i) => (i === 2 ? 'the password is x' : body(i)) }));
    expect(withSecret.record).toMatchObject({ archive_planned: 11, archive_skipped: { secret_in_result: 1 } });
  });

  it('shadow in a compaction that is not active counts the same, and active without the point active behaves as shadow', async () => {
    const asShadowPoint = await compactRun({ ...CASCADE, OMC_JEV: 'compaction', OMC_JEV_COMPACT_ARCHIVE: 'active' }, shape());
    expect(asShadowPoint.record).toMatchObject({ mode: 'shadow', archive_mode: 'shadow', archive_planned: 12 });
    expect(asShadowPoint.archived().size).toBe(0);
  });

  it('with the switch off or unset the record has none of its fields, no file is written and the result is the same', async () => {
    const unset = await compactRun(CASCADE, shape());
    for (const value of ['off', '', '1', 'on']) {
      const run = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: value }, shape());
      expect(run.out.messages).toEqual(unset.out.messages);
      expect(Object.keys(run.record).filter((k) => k.startsWith('archive_') || k.startsWith('merged_'))).toEqual([]);
      expect(run.archived().size).toBe(0);
    }
    expect(traceLinesOf(unset.out).every((l) => !l.includes('full call and result'))).toBe(true);
  });

  it('active counts the length of the paths in the prediction of the cascade, as the traces really stand (the floor drops results whole, so a path does not change it)', async () => {
    const env = { ...CASCADE };
    const big = shape();
    const off = await compactRun(env, big, { tokens: 60000 });
    const on = await compactRun({ ...env, OMC_JEV_COMPACT_ARCHIVE: 'active' }, big, { tokens: 60000 });
    expect(typeof off.record.floor_pred).toBe('number');
    expect(on.record.floor_pred).toBe(off.record.floor_pred);
    expect(on.record.cascade_predicted_tokens).toBeGreaterThan(off.record.cascade_predicted_tokens);
    const shadow = await compactRun({ ...env, OMC_JEV_COMPACT_ARCHIVE: 'shadow' }, big, { tokens: 60000 });
    expect(shadow.record.floor_pred).toBe(off.record.floor_pred);
    expect(shadow.record.cascade_predicted_tokens).toBe(off.record.cascade_predicted_tokens);
  });

  it('neighbouring traces of one identical call in one API message merge into one line with a counter; a different input does not merge', async () => {
    const same = { file_path: '/work/a.txt', offset: 0 };
    const w = talk(30);
    const messages = [w[0], assistant('Reading.', [
      { tool_use_id: 'r1', tool: 'Read', input: same }, { tool_use_id: 'r2', tool: 'Read', input: same }, { tool_use_id: 'r3', tool: 'Read', input: { ...same, offset: 100 } },
      { tool_use_id: 'r4', tool: 'Read', input: same }]),
    row('', { toolResults: ['r1', 'r2', 'r3', 'r4'].map((id, k) => ({ tool_use_id: id, text: `Content of the file ${k}. `.repeat(400), isError: false })) }), ...w.slice(1)];
    const run = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, messages);
    expect(run.record).toMatchObject({ archive_written: 4, merged_traces: 1, merged_items: 2 });
    const lines = traceLinesOf(run.out);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[compacted\] Read\(\/work\/a\.txt[^)]*\) x2 - results of \d+ chars removed; full calls and results: .*\/sess-arch\/ \(r1\.txt, r2\.txt\)$/);
    expect(lines[1]).toMatch(/offset|\/work\/a\.txt/);
    expect(lines[1]).not.toContain(' x');
    expect(lines[2]).toContain('r4.txt');
    expect(run.archived().size).toBe(4);
    const shadow = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'shadow' }, messages);
    expect(shadow.record).toMatchObject({ merged_traces: 1, merged_items: 2 });
    expect(traceLinesOf(shadow.out)).toHaveLength(4);
    const off = await compactRun(CASCADE, messages);
    expect(traceLinesOf(off.out)).toHaveLength(4);
  });

  it('identical calls in different API messages never merge', async () => {
    const same = { file_path: '/work/a.txt' };
    const w = talk(30);
    const messages = [w[0],
      assistant('First.', [{ tool_use_id: 'r1', tool: 'Read', input: same }]), row('', { toolResults: [{ tool_use_id: 'r1', text: 'Content. '.repeat(900), isError: false }] }),
      assistant('Second.', [{ tool_use_id: 'r2', tool: 'Read', input: same }]), row('', { toolResults: [{ tool_use_id: 'r2', text: 'Content. '.repeat(900), isError: false }] }),
      ...w.slice(1)];
    const run = await compactRun({ ...CASCADE, OMC_JEV_COMPACT_ARCHIVE: 'active' }, messages);
    expect(run.record).toMatchObject({ archive_written: 2, merged_traces: 0 });
    expect(traceLinesOf(run.out)).toHaveLength(2);
  });
});

describe('archive: the series of traces read the path and the counter only with the switch on', () => {
  const PATH = `${ARCHIVE}/${SESSION}/toolu_01AbCdEfGhIjKlMnOpQrStUvWxYz1234567.txt`;
  const withPath = `[compacted] Bash(make) - error of 40 chars removed; full call and result: ${PATH}`;
  const merged = `[compacted] Read(a.txt) x3 - results of 450 chars removed, including 2 errors; full calls and results: ${ARCHIVE}/${SESSION}/ (a.txt, b.txt, c.txt)`;
  const plain = '[compacted] Read(b.txt) - result of 10 chars removed';

  it('with the switch off a trace that ends in a path is a call without an error and without a file, and a counter is one call, as before', () => {
    const [run] = seriesRuns(`${withPath}\n${plain}`);
    expect(run.stats).toMatchObject({ traces: 2, calls: 2, errors: 0, file: false });
    const [counted] = seriesRuns(`${merged}\n${plain}`);
    expect(counted.stats).toMatchObject({ traces: 2, calls: 2, errors: 0, file: false });
  });

  it('with the switch on the path counts as a file and an error line with a path as an error, and a counter counts its calls and errors', () => {
    const [run] = seriesRuns(`${withPath}\n${plain}`, false, true);
    expect(run.stats).toMatchObject({ traces: 2, calls: 2, errors: 1, file: true });
    const [counted] = seriesRuns(`${merged}\n${plain}`, false, true);
    expect(counted.stats).toMatchObject({ traces: 4, calls: 4, errors: 2, file: true, tools: { Read: 4 } });
    expect(seriesRuns(`${plain}\n${plain}`, false, true)[0].stats).toMatchObject({ traces: 2, calls: 2, errors: 0, file: false });
  });

  it('a series of traces with archive paths is merged when the switch is on, and held as a secret when it is off (the long id is what the masker takes for one)', async () => {
    const lines = [1, 2, 3].map((k) => `[compacted] Read(file-${k}.txt) - result of 100 chars removed; full call and result: ${ARCHIVE}/${SESSION}/toolu_01AbCdEfGhIjKlMnOpQrStUvWxYz123456${k}.txt`);
    const messages = [{ role: 'user', text: 'Task.', toolUses: [], handle: 'h0' }, { role: 'user', text: 'go', toolUses: [], handle: 'h1' }, { role: 'assistant', text: 'Looking.', toolUses: [], handle: 'h2' },
      { role: 'assistant', text: lines.join('\n'), toolUses: [], handle: 'h3' }, { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h4' },
      ...Array.from({ length: 10 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', text: `tail ${k}`, toolUses: [], handle: `t${k}` }))].map((m) => Object.freeze(m));
    const api = [];
    for (const m of messages) {
      const content = m.role === 'assistant' ? [{ type: 'text', text: m.text }] : [{ type: 'text', text: m.text }];
      if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
    }
    const merge = async (archive) => {
      const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active', ...(archive ? { OMC_JEV_COMPACT_ARCHIVE: archive } : {}) };
      const cfg = await readConfig({ env: { get: async (name) => env[name] }, settings: { read: async () => undefined }, clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } } });
      const ctx = seriesContext(cfg, messages, api, messages.length);
      const items = seriesItems(cfg, messages, ctx, SESSION);
      const store = new Map();
      const $ = { clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } }, fs: { read: async (p) => { if (!store.has(p)) throw new Error('ENOENT'); return store.get(p); }, write: async (p, t) => { store.set(p, t); } } };
      const record = {};
      const edited = await mergeSeries($, cfg, record, messages, ctx, new Set(items.map((x) => x.key)), SESSION, Date.now() + 60000);
      return { record, edited, items };
    };
    const on = await merge('active');
    expect(on.record.series).toMatchObject({ series: 1, traces: 3, secret: 0 });
    expect(on.edited.size).toBe(1);
    const off = await merge(undefined);
    expect(off.record.series).toMatchObject({ series: 0, secret: 1 });
    expect(off.edited.size).toBe(0);
  });
});
