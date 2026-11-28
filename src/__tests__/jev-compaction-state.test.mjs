/* global process */
/**
 * Tests for scripts/lib/jev-compaction-state.mjs (classic-hook side of the Jev compaction module):
 * the work-state registry written by PostToolUse/PostToolUseFailure, the move of the module's spool
 * records to compaction.jsonl at SessionStart, `module_missing`, and the hook entry points
 * (session-start.mjs, post-tool-verifier.mjs, post-tool-use-failure.mjs) with and without the point.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { archiveSegment } from '../../hooks/jev-compaction.mjs';
import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import {
  afterSessionStart, archiveDays, foldRegistry, MISSING_MESSAGE, pastesDays, recordCompactionState, REGISTRY_CHARS, registryBudgets, registryByWindowOn, registryPath, renderRegistry, sweepArchive,
  sweepPastes,
} from '../../scripts/lib/jev-compaction-state.mjs';
import * as writers from '../../scripts/lib/context-text-sanitize.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const tmp = mkdtempSync(join(tmpdir(), 'jev-compaction-state-'));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ } });

let n = 0;
function setup() {
  const dir = join(tmp, `case-${++n}`);
  const env = { OMC_JEV: 'all:active,compaction:active', TYPESAFE_API_KEY: 'k', OMC_JEV_LOG_DIR: join(dir, 'jev') };
  return { dir, env, sid: `sess-${n}`, spool: join(dir, 'jev', 'compaction-spool'), log: join(dir, 'jev', 'compaction.jsonl') };
}
const post = (env, sid, tool_name, tool_input, extra = {}) => recordCompactionState('post', { session_id: sid, tool_name, tool_input, ...extra }, env);
const fail = (env, sid, tool_name, tool_input, error) => recordCompactionState('failure', { session_id: sid, tool_name, tool_input, error }, env);
function spoolRecord(spool, sid, record, ageMs = 0) {
  mkdirSync(spool, { recursive: true });
  const ts = new Date(Date.now() - ageMs).toISOString();
  const name = `${sid}--${Date.now() - ageMs}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(spool, name), JSON.stringify({ ts, point: 'compaction', event: 'compact', session_id: sid, agent_id: null, ...record }));
  return name;
}
const logRows = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('jev-compaction-state: secret masking keeps commit hashes in the registry', () => {
  it('masks a 40-character hex string in general text but keeps it in the git lines of the registry', () => {
    const { env, sid } = setup();
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(maskSecrets('revert ' + sha)).toBe('revert ***');
    expect(maskSecrets('revert ' + sha, { keepGitHashes: true })).toBe('revert ' + sha);
    expect(maskSecrets('token ' + 'Ab3'.repeat(14), { keepGitHashes: true })).toBe('token ***');
    post(env, sid, 'Bash', { command: 'git revert ' + sha });
    expect(readFileSync(registryPath(sid, undefined, env), 'utf8')).toContain(sha);
  });

  it('reads the camelCase toolInput of a hook input too', () => {
    const { env, sid } = setup();
    recordCompactionState('post', { session_id: sid, tool_name: 'Write', toolInput: { file_path: '/p/camel.ts' } }, env);
    expect(readFileSync(registryPath(sid, undefined, env), 'utf8')).toContain('/p/camel.ts');
  });
});

describe('jev-compaction-state: registry', () => {
  it('writes nothing unless OMC_JEV names compaction (all:active is not enough)', () => {
    const { env, sid } = setup();
    for (const OMC_JEV of [undefined, 'all', 'all:active', 'off']) {
      post({ ...env, OMC_JEV }, sid, 'Write', { file_path: '/p/a.ts' });
      fail({ ...env, OMC_JEV }, sid, 'Bash', { command: 'npm test' }, 'boom');
    }
    post({ ...env, TYPESAFE_API_KEY: undefined }, sid, 'Write', { file_path: '/p/a.ts' });
    expect(existsSync(registryPath(sid, undefined, env))).toBe(false);
    expect(existsSync(join(env.OMC_JEV_LOG_DIR))).toBe(false);
  });

  it('records changed files, repository-changing git commands, tasks and the last unresolved error', () => {
    const { env, sid } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    post(env, sid, 'Edit', { file_path: '/p/b.ts' });
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    post(env, sid, 'Bash', { command: 'git status' });
    post(env, sid, 'Bash', { command: 'git -C /p commit -m "fix" --author "x" && echo token=abcdef1234567890abcdef1234567890ab' });
    post(env, sid, 'Bash', { command: 'git push' });
    post(env, sid, 'TodoWrite', { todos: [{ content: 'write tests', status: 'in_progress' }, { content: 'done one', status: 'completed' }] });
    post(env, sid, 'TaskCreate', { subject: 'review' }, { tool_response: { task: { id: '7' } } });
    post(env, sid, 'TaskCreate', { subject: 'ship' }, { tool_response: 'Task #8 created' });
    post(env, sid, 'TaskUpdate', { taskId: '8', status: 'completed' });
    fail(env, sid, 'Bash', { command: 'npm test -- --run' }, '3 failed');
    post(env, sid, 'Bash', { command: 'ls' });
    const reg = foldRegistry(sid, undefined, env);
    expect(reg.files).toEqual(['/p/b.ts', '/p/a.ts']);
    expect(reg.git).toHaveLength(2);
    expect(reg.git[0]).toMatch(/commit/);
    expect(reg.git[0]).not.toContain('abcdef1234567890');
    expect(reg.git[1]).toBe('git push');
    expect(reg.tasks).toEqual([{ text: 'write tests', status: 'in_progress' }, { id: '7', text: 'review', status: 'pending' }]);
    expect(reg.error).toMatchObject({ tool: 'Bash', text: '3 failed' });
    post(env, sid, 'Bash', { command: 'npm test -- --run --reporter=dot' });
    expect(foldRegistry(sid, undefined, env).error).toBeNull();
  });

  it('keeps separate registries per agent and renders within REGISTRY_CHARS, dropping the oldest files first', () => {
    const { env, sid } = setup();
    for (let i = 0; i < 200; i++) post(env, sid, 'Write', { file_path: `/project/src/some/deep/folder/file-${i}.ts` });
    post(env, sid, 'Write', { file_path: '/sub/only.ts' }, { agent_id: 'agent-1' });
    const text = renderRegistry(sid, undefined, env);
    expect(text.length).toBeLessThanOrEqual(REGISTRY_CHARS);
    expect(text).toMatch(/^\[OMC: work state from before the compaction/);
    expect(text).toContain('file-199.ts');
    expect(text).not.toContain('/sub/only.ts');
    expect(renderRegistry(sid, 'agent-1', env)).toContain('/sub/only.ts');
    expect(renderRegistry('nobody', undefined, env)).toBe('');
  });

  it('writes the changed files exactly when the cleaning writers are passed, and as they were without them', () => {
    const { env, sid } = setup();
    const gear = '/p/gear\ufe0f/a.ts';
    for (const file of [gear, '"quoted".ts', '/p/plain.ts']) post(env, sid, 'Write', { file_path: file });
    const exact = renderRegistry(sid, undefined, env, writers);
    const list = exact.split('\n').find((line) => line.startsWith('Changed files (newest last): '));
    expect(list).toBe('Changed files (newest last): "/p/gear\\ufe0f/a.ts"; "\\"quoted\\".ts"; /p/plain.ts');
    expect(exact.includes('\ufe0f')).toBe(false);
    expect(writers.cleanTextBlock(exact)).toBe(exact);
    expect(renderRegistry(sid, undefined, env)).toContain(`Changed files (newest last): ${gear}; "quoted".ts; /p/plain.ts`);
    expect(renderRegistry(sid, undefined, env, undefined)).toBe(renderRegistry(sid, undefined, env));
  });

  // An identifier whose written form (escaped, quoted) has exactly `length` characters: `count` removed characters of `junk`
  // (6 written characters each, 12 for an astral one) and plain characters for the rest.
  const writtenLength = (length, junk, count) => `${'x'.repeat(length - 2 - count * (junk.length === 2 ? 12 : 6))}${junk.repeat(count)}`;

  for (const [label, junk, count] of [['variation selector', '\ufe0f', 1], ['variation selector', '\ufe0f', 15], ['astral tag character', String.fromCodePoint(0xE0041), 1], ['astral tag character', String.fromCodePoint(0xE0041), 8]]) {
    it(`file limit of 250 written characters, one on each side: ${count} x ${label}`, () => {
      for (const length of [249, 250, 251]) {
        const { env, sid } = setup();
        const file = writtenLength(length, junk, count);
        expect(writers.escapeIdentifier(file).length).toBe(length);
        post(env, sid, 'Write', { file_path: file });
        const written = renderRegistry(sid, undefined, env, writers).split('Changed files (newest last): ')[1];
        if (length <= 250) expect(JSON.parse(written), `${length}`).toBe(file);
        else expect(written, `${length}`).toBe('[identifier of 251 characters not shown]');
      }
    });
  }

  it('text limit of REGISTRY_CHARS, one on each side: the whole text or whole lines', () => {
    const unfitted = { ...writers, fitLines: (value) => String(value) };
    const lengthWith = (text) => {
      const { env, sid } = setup();
      post(env, sid, 'TodoWrite', { todos: [...Array.from({ length: 11 }, (_, index) => ({ content: `${index}`.repeat(100), status: 'pending' })), { content: text, status: 'pending' }] });
      return { env, sid, full: renderRegistry(sid, undefined, env, unfitted) };
    };
    const base = lengthWith('t').full.length;
    for (const length of [REGISTRY_CHARS - 1, REGISTRY_CHARS, REGISTRY_CHARS + 1]) {
      const { env, sid, full } = lengthWith('t'.repeat(length - base + 1));
      expect(full.length).toBe(length);
      const text = renderRegistry(sid, undefined, env, writers);
      if (length <= REGISTRY_CHARS) {
        expect(text, `${length}`).toBe(full);
      } else {
        // No file is left to drop, so the lines go whole from the end: the task line first.
        expect(text, `${length}`).toBe(`${full.split('\n')[0]}\n…`);
      }
    }
  });

  it('with the writers drops the oldest files whole to fit REGISTRY_CHARS and replaces a file over 250 characters by a notice', () => {
    const { env, sid } = setup();
    for (let i = 0; i < 120; i++) post(env, sid, 'Write', { file_path: `/project/src/gear\ufe0f/deep/folder/file-${i}.ts` });
    post(env, sid, 'Write', { file_path: `/p/${'\ufe0f'.repeat(60)}.ts` });
    const text = renderRegistry(sid, undefined, env, writers);
    expect(text.length).toBeLessThanOrEqual(REGISTRY_CHARS);
    const entries = text.split('Changed files (newest last): ')[1].split('; ');
    expect(entries.at(-1)).toMatch(/^\[identifier of \d+ characters not shown\]$/);
    for (const entry of entries.slice(0, -1)) expect(JSON.parse(entry)).toMatch(/^\/project\/src\/gear\ufe0f\/deep\/folder\/file-\d+\.ts$/);
    expect(entries.length).toBeLessThan(121);
  });
});

describe('jev-compaction-state: SessionStart', () => {
  it('does nothing unless OMC_JEV names compaction: the spool stays, no log', () => {
    const { env, sid, spool, log } = setup();
    const name = spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout' });
    for (const OMC_JEV of [undefined, 'all:active']) {
      expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, { ...env, OMC_JEV })).toEqual({});
    }
    expect(readdirSync(spool)).toEqual([name]);
    expect(existsSync(log)).toBe(false);
  });

  it('after a Jev compaction: moves the record to compaction.jsonl and adds no context', () => {
    const { env, sid, spool, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    spoolRecord(spool, sid, { result: 'jev', reduction: 0.5 });
    expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, env)).toEqual({});
    expect(logRows(log)).toEqual([expect.objectContaining({ result: 'jev', reduction: 0.5 })]);
    expect(readdirSync(spool)).toEqual([]);
  });

  it('after the built-in summary (fallback or shadow): adds the registry as context', () => {
    for (const record of [{ result: 'fallback', reason: 'jev_error' }, { result: 'shadow', mode: 'shadow' }]) {
      const { env, sid, spool, log } = setup();
      post(env, sid, 'Write', { file_path: '/p/a.ts' });
      spoolRecord(spool, sid, record);
      const out = afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
      expect(out.context).toMatch(/Changed files \(newest last\): \/p\/a\.ts/);
      expect(out.systemMessage).toBeUndefined();
      expect(logRows(log)).toHaveLength(1);
    }
  });

  it('without a record: module_missing with the registry; one systemMessage after three within a day', () => {
    const { env, sid, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    const outs = [1, 2, 3, 4].map(() => afterSessionStart({ session_id: sid, source: 'compact' }, {}, env));
    expect(outs.map((o) => Boolean(o.context))).toEqual([true, true, true, true]);
    expect(outs.map((o) => o.systemMessage)).toEqual([undefined, undefined, MISSING_MESSAGE, undefined]);
    expect(logRows(log).map((r) => r.event)).toEqual(['module_missing', 'module_missing', 'module_missing', 'module_missing']);
    expect(MISSING_MESSAGE).not.toMatch(/CLAUDE_CODE_ENABLE_FUNCTION_HOOKS/);
  });

  it('a session that started before the module was installed: no module_missing, but the registry still goes in', () => {
    const { dir, env, sid, log } = setup();
    post(env, sid, 'Write', { file_path: '/p/a.ts' });
    const transcript = join(dir, 'old.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00.000Z' })}\n`);
    const out = afterSessionStart({ session_id: sid, source: 'compact', transcript_path: transcript }, {}, env);
    expect(out.context).toContain('/p/a.ts');
    expect(out.systemMessage).toBeUndefined();
    expect(logRows(log).map((r) => r.event)).toEqual(['session_before_module']);
  });

  it('claims the record of the compacting subagent and leaves the main loop\'s fresh record for its own SessionStart', () => {
    const { env, sid, spool, log } = setup();
    spoolRecord(spool, sid, { result: 'jev' });
    spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout', agent_id: 'abc123' });
    post(env, sid, 'Write', { file_path: '/sub/x.ts' }, { agent_id: 'abc123' });
    const sub = afterSessionStart({ session_id: sid, source: 'compact', transcript_path: `/t/${sid}/subagents/agent-abc123.jsonl` }, {}, env);
    expect(sub.context).toContain('/sub/x.ts');
    expect(logRows(log).map((r) => r.agent_id)).toEqual(['abc123']);
    expect(readdirSync(spool)).toHaveLength(1);
    expect(afterSessionStart({ session_id: sid, source: 'compact' }, {}, env)).toEqual({});
    expect(logRows(log).map((r) => r.result)).toEqual(['fallback', 'jev']);
  });

  it('leaves other sessions\' files alone, logs unreadable files, and sweeps week-old files at startup', () => {
    const { env, sid, spool, log } = setup();
    const other = spoolRecord(spool, 'other-session', { result: 'jev' });
    writeFileSync(join(spool, `${sid}--1-broken.json`), '{not json');
    afterSessionStart({ session_id: sid, source: 'resume' }, {}, env);
    expect(logRows(log)).toEqual([expect.objectContaining({ event: 'bad_module_file', session_id: sid, file: `${sid}--1-broken.json` })]);
    expect(readdirSync(spool)).toEqual([other]);
    const old = (Date.now() - 8 * 24 * 3600_000) / 1000;
    utimesSync(join(spool, other), old, old);
    post(env, 'stale', 'Write', { file_path: '/p/a.ts' });
    utimesSync(registryPath('stale', undefined, env), old, old);
    afterSessionStart({ session_id: sid, source: 'startup' }, {}, env);
    expect(readdirSync(spool)).toEqual([]);
    expect(existsSync(registryPath('stale', undefined, env))).toBe(false);
  });
});

describe('jev-compaction-state: pasted text kept for the traces of the module (OMC_JEV_COMPACT_PASTES)', () => {
  const DAY = 24 * 3600_000;
  const pastesRoot = (env) => join(env.OMC_JEV_LOG_DIR, 'compaction-pastes');
  /** A session directory with one file last changed `ageDays` days ago. */
  function pastes(env, session, ageDays, name = 'a1b2.txt') {
    const dir = join(pastesRoot(env), session);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, 'pasted');
    const when = new Date(Date.now() - ageDays * DAY);
    utimesSync(file, when, when);
    utimesSync(dir, when, when);
    return dir;
  }

  it('OMC_JEV_PASTES_DAYS is a whole number of days from 1 to 99999, 14 when unset; anything else keeps everything', () => {
    expect(pastesDays({})).toBe(14);
    expect(pastesDays({ OMC_JEV_PASTES_DAYS: '' })).toBe(14);
    expect(pastesDays({ OMC_JEV_PASTES_DAYS: ' 3 ' })).toBe(3);
    expect(pastesDays({ OMC_JEV_PASTES_DAYS: '99999' })).toBe(99999);
    for (const bad of ['0', '-1', '1.5', '01', '100000', 'abc', '3d', '1e2', '+3']) expect(pastesDays({ OMC_JEV_PASTES_DAYS: bad })).toBe(0);
  });

  it('removes the session directories whose newest file is older than the days; keeps newer ones, the current session (and marks it), and links', () => {
    const { env } = setup();
    const old = pastes(env, 'old-session', 20);
    const young = pastes(env, 'young-session', 3);
    const mixed = pastes(env, 'mixed-session', 20, 'old.txt');
    writeFileSync(join(mixed, 'new.txt'), 'fresh');
    const mine = pastes(env, 'my-session', 40);
    const target = join(tmp, `link-target-${n}`);
    mkdirSync(target, { recursive: true });
    let linked = true;
    try { symlinkSync(target, join(pastesRoot(env), 'linked-session'), 'dir'); } catch { linked = false; }
    expect(sweepPastes('my-session', Date.now(), env)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(mixed)).toBe(true);
    expect(existsSync(mine)).toBe(true);
    expect(Date.now() - statSync(join(mine, '.compaction')).mtimeMs).toBeLessThan(DAY);
    expect(existsSync(join(mine, 'a1b2.txt'))).toBe(true);
    if (linked) expect(existsSync(target)).toBe(true);
    expect(sweepPastes('my-session', Date.now() + 30 * DAY, { ...env, OMC_JEV_PASTES_DAYS: '0' })).toBe(0);
    expect(existsSync(young)).toBe(true);
    expect(sweepPastes('my-session', Date.now() + 30 * DAY, { ...env, OMC_JEV_PASTES_DAYS: '5' })).toBe(2);
    expect(existsSync(young)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  it('removes and touches nothing without a session id, and does not fail without the directory', () => {
    const { env } = setup();
    const old = pastes(env, 'old-session', 20);
    expect(sweepPastes(undefined, Date.now(), env)).toBe(0);
    expect(sweepPastes('', Date.now(), env)).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(sweepPastes('x', Date.now(), { OMC_JEV_LOG_DIR: join(tmp, 'no-such-state-dir') })).toBe(0);
  });

  it('without a compaction-pastes directory nothing is created and nothing else is removed, with and without OMC_JEV_COMPACT_PASTES', () => {
    const { env, sid } = setup();
    const state = env.OMC_JEV_LOG_DIR;
    mkdirSync(join(state, 'compaction-registry'), { recursive: true });
    writeFileSync(join(state, 'other.txt'), 'kept');
    const before = readdirSync(state).sort();
    for (const extra of [{}, { OMC_JEV_COMPACT_PASTES: 'active' }, { OMC_JEV_COMPACT_PASTES: 'off' }]) {
      expect(sweepPastes('my-session', Date.now() + 90 * DAY, { ...env, ...extra })).toBe(0);
      afterSessionStart({ session_id: sid, source: 'startup' }, {}, { ...env, ...extra });
      expect(existsSync(join(state, 'compaction-pastes'))).toBe(false);
      expect(existsSync(join(state, 'other.txt'))).toBe(true);
      expect(existsSync(join(state, 'compaction-registry'))).toBe(true);
    }
    expect(readdirSync(state).filter((name) => before.includes(name)).sort()).toEqual(before);
  });

  it('SessionStart sweeps at startup, on resume and on clear, but not after a compaction and not when the point is not named', () => {
    const { env, sid } = setup();
    const old = pastes(env, 'old-session', 20);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
    expect(existsSync(old)).toBe(true);
    afterSessionStart({ session_id: sid, source: 'startup' }, {}, { ...env, OMC_JEV: 'all:active' });
    expect(existsSync(old)).toBe(true);
    for (const source of ['startup', 'resume', 'clear']) {
      const dir = pastes(env, `old-${source}`, 20);
      afterSessionStart({ session_id: sid, source }, {}, env);
      expect(existsSync(dir)).toBe(false);
    }
    expect(existsSync(old)).toBe(false);
  });
});

describe('jev-compaction-state: archive of calls and results kept for the traces of the module (OMC_JEV_COMPACT_ARCHIVE)', () => {
  const DAY = 24 * 3600_000;
  const archiveRoot = (env) => join(env.OMC_JEV_LOG_DIR, 'compaction-archive');
  /** A session directory with the given files, each last changed `ageDays` days ago (the directory too). */
  function archive(env, session, ageDays, names = ['toolu_a.txt']) {
    const dir = join(archiveRoot(env), session);
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - ageDays * DAY);
    for (const name of names) {
      const file = join(dir, name);
      writeFileSync(file, 'result text');
      utimesSync(file, when, when);
    }
    utimesSync(dir, when, when);
    return dir;
  }

  it('OMC_JEV_ARCHIVE_DAYS is a whole number of days from 1 to 99999, 14 when unset; anything else keeps everything', () => {
    expect(archiveDays({})).toBe(14);
    expect(archiveDays({ OMC_JEV_ARCHIVE_DAYS: '' })).toBe(14);
    expect(archiveDays({ OMC_JEV_ARCHIVE_DAYS: ' 7 ' })).toBe(7);
    expect(archiveDays({ OMC_JEV_ARCHIVE_DAYS: '99999' })).toBe(99999);
    for (const bad of ['0', '-1', '1.5', '01', '100000', 'abc', '7d', '1e2', '+7']) expect(archiveDays({ OMC_JEV_ARCHIVE_DAYS: bad })).toBe(0);
  });

  it('removes the session directories whose newest file is older than the days, with the given time; keeps newer ones, the current session and links', () => {
    const { env } = setup();
    const old = archive(env, 'old-session', 20, ['toolu_a.txt', 'toolu_b.txt']);
    const young = archive(env, 'young-session', 3);
    const mixed = archive(env, 'mixed-session', 20, ['old.txt']);
    writeFileSync(join(mixed, 'new.txt'), 'fresh');
    const mine = archive(env, 'my-session', 40);
    const target = join(tmp, `archive-link-target-${n}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep.txt'), 'outside');
    let linked = true;
    try { symlinkSync(target, join(archiveRoot(env), 'linked-session'), 'dir'); } catch { linked = false; }
    const out = sweepArchive('my-session', Date.now(), env);
    expect(out).toMatchObject({ days: 14, removed_dirs: 1, removed_files: 2, stopped: false });
    expect(out.removed_bytes).toBe(2 * 'result text'.length);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(mixed)).toBe(true);
    expect(existsSync(mine)).toBe(true);
    if (linked) { expect(existsSync(join(target, 'keep.txt'))).toBe(true); expect(out.links_skipped).toBe(1); }
    // The time is a parameter: 30 days later the young directory is old too (the current session's directory never goes).
    expect(sweepArchive('my-session', Date.now() + 30 * DAY, { ...env, OMC_JEV_ARCHIVE_DAYS: '5' })).toMatchObject({ removed_dirs: 2 });
    expect(existsSync(young)).toBe(false);
    expect(existsSync(mixed)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  it('a live session is told by its newest file, the marker included, not by its first file', () => {
    const { env } = setup();
    const live = archive(env, 'live-session', 30, ['toolu_a.txt', '.compaction']);
    const fresh = new Date();
    utimesSync(join(live, '.compaction'), fresh, fresh);
    const idle = archive(env, 'idle-session', 30, ['toolu_a.txt', '.compaction']);
    expect(sweepArchive('my-session', Date.now(), env)).toMatchObject({ removed_dirs: 1 });
    expect(existsSync(join(live, 'toolu_a.txt'))).toBe(true);
    expect(existsSync(idle)).toBe(false);
  });

  it('the current session is found by the name the module gives its directory, also for ids with a dot, a slash or a device name, and a directory that only looks like it goes', () => {
    const ids = ['a/b', 'a.b', 'a b', 'CON', 'nul', 'x'.repeat(100), '123e4567-e89b-12d3-a456-426614174000'];
    for (const id of ids) {
      const { env } = setup();
      const mine = archive(env, archiveSegment(id), 40);
      const lookalike = archive(env, id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80), 40);
      const other = archive(env, 'other-session', 40);
      expect(sweepArchive(id, Date.now(), env), id).toMatchObject({ stopped: false });
      expect(existsSync(mine), id).toBe(true);
      expect(existsSync(other), id).toBe(false);
      expect(existsSync(lookalike), id).toBe(lookalike === mine);
    }
    const { env } = setup();
    const a = archive(env, archiveSegment('a/b'), 40);
    const b = archive(env, archiveSegment('a_b'), 40);
    expect(archiveSegment('a/b')).not.toBe(archiveSegment('a_b'));
    sweepArchive('a_b', Date.now(), env);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(a)).toBe(false);
  });

  it('keeps a directory that holds anything but plain files, and finishes a directory that was renamed to be removed, whatever its age', () => {
    const { env } = setup();
    const nested = archive(env, 'nested-session', 20);
    mkdirSync(join(nested, 'inner'));
    const longAgo = new Date(Date.now() - 20 * DAY);
    utimesSync(nested, longAgo, longAgo);
    const doomed = archive(env, 'half.abc123.removing', 0, ['x.txt', 'y.txt']);
    const out = sweepArchive('my-session', Date.now(), env);
    expect(out).toMatchObject({ removed_dirs: 1, removed_files: 3 });
    expect(existsSync(doomed)).toBe(false);
    expect(readdirSync(archiveRoot(env)).filter((name) => name.startsWith('nested-session')).length).toBe(1);
    expect(existsSync(join(archiveRoot(env), 'nested-session', 'inner'))).toBe(false);
  });

  it('stops when the time budget is used, after at least one file, and the next start finishes', () => {
    const { env } = setup();
    for (const name of ['s1', 's2', 's3', 's4']) archive(env, name, 20, ['a.txt', 'b.txt', 'c.txt']);
    const first = sweepArchive('my-session', Date.now(), env, 0);
    expect(first.stopped).toBe(true);
    expect(first.removed_files).toBeGreaterThanOrEqual(1);
    expect(first.removed_files).toBeLessThan(12);
    let guard = 0;
    while (readdirSync(archiveRoot(env)).length && guard++ < 20) sweepArchive('my-session', Date.now(), env, 0);
    expect(readdirSync(archiveRoot(env))).toEqual([]);
  });

  it('removes and touches nothing without a session id or with the days turned off, and does not fail without the directory', () => {
    const { env } = setup();
    const old = archive(env, 'old-session', 20);
    expect(sweepArchive(undefined, Date.now(), env)).toBeUndefined();
    expect(sweepArchive('', Date.now(), env)).toBeUndefined();
    expect(sweepArchive('x', Date.now() + 90 * DAY, { ...env, OMC_JEV_ARCHIVE_DAYS: '0' })).toBeUndefined();
    expect(existsSync(old)).toBe(true);
    expect(sweepArchive('x', Date.now(), { OMC_JEV_LOG_DIR: join(tmp, 'no-such-archive-state-dir') })).toBeUndefined();
  });

  it('SessionStart removes old archive directories and logs a row at startup, on resume and on clear, but not after a compaction and not when the point is not named', () => {
    const { env, sid, log } = setup();
    const old = archive(env, 'old-session', 20);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
    expect(existsSync(old)).toBe(true);
    afterSessionStart({ session_id: sid, source: 'startup' }, {}, { ...env, OMC_JEV: 'all:active' });
    expect(existsSync(old)).toBe(true);
    const out = afterSessionStart({ session_id: sid, source: 'startup' }, {}, env);
    expect(out).toEqual({});
    expect(existsSync(old)).toBe(false);
    const rows = logRows(log).filter((r) => r.event === 'archive_retention');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'compaction', session_id: sid, removed_dirs: 1, removed_files: 1, days: 14 });
    // Nothing removed, nothing logged.
    afterSessionStart({ session_id: sid, source: 'resume' }, {}, env);
    expect(logRows(log).filter((r) => r.event === 'archive_retention')).toHaveLength(1);
    // The same on resume and on clear: an old directory goes and a row says so.
    for (const [k, source] of ['resume', 'clear'].entries()) {
      const older = archive(env, `older-${source}`, 20);
      afterSessionStart({ session_id: sid, source }, {}, env);
      expect(existsSync(older), source).toBe(false);
      expect(logRows(log).filter((r) => r.event === 'archive_retention'), source).toHaveLength(k + 2);
    }
  });

  it('a directory that keeps a link or a subdirectory after the removal does not add a row at every start: the row says what was removed, and only that', () => {
    const { env, sid, log } = setup();
    const target = join(tmp, `archive-kept-target-${n}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep.txt'), 'outside');
    const doomed = archive(env, 'half.abc123.removing', 0, ['x.txt']);
    let linked = true;
    try { symlinkSync(join(target, 'keep.txt'), join(doomed, 'link.txt')); } catch { linked = false; }
    mkdirSync(join(doomed, 'inner'));
    afterSessionStart({ session_id: sid, source: 'startup' }, {}, env);
    const rows = () => logRows(log).filter((r) => r.event === 'archive_retention');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ removed_dirs: 0, removed_files: 1, links_skipped: linked ? 1 : 0 });
    expect(existsSync(doomed)).toBe(true);
    for (const source of ['resume', 'clear', 'startup']) afterSessionStart({ session_id: sid, source }, {}, env);
    expect(rows()).toHaveLength(1);
    expect(sweepArchive(sid, Date.now(), env)).toMatchObject({ removed_files: 0, removed_dirs: 0, links_skipped: linked ? 1 : 0 });
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });
});

describe('jev-compaction-state: compaction.jsonl rotation', () => {
  const ROTATED = /^compaction-\d{8}-\d{6}-\d+\.jsonl$/;
  // Just above 1 MiB (OMC_JEV_LOG_MAX_MB=1).
  const OLD_LOG = ('x'.repeat(99) + '\n').repeat(11_000);

  it('renames a file above OMC_JEV_LOG_MAX_MB before the next append, like the other Jev logs', () => {
    const { env, sid, log } = setup();
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, OLD_LOG);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, { ...env, OMC_JEV_LOG_MAX_MB: '1' });
    const rotated = readdirSync(dirname(log)).filter((name) => ROTATED.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(dirname(log), rotated[0]), 'utf8')).toBe(OLD_LOG);
    expect(logRows(log)).toEqual([expect.objectContaining({ event: 'module_missing', session_id: sid })]);
  });

  it('keeps appending to the same file without the variable', () => {
    const { env, sid, log } = setup();
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, OLD_LOG);
    afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
    expect(readdirSync(dirname(log)).filter((name) => ROTATED.test(name))).toEqual([]);
    expect(readFileSync(log, 'utf8').startsWith(OLD_LOG)).toBe(true);
    expect(readFileSync(log, 'utf8').length).toBeGreaterThan(OLD_LOG.length);
  });
});

describe('jev-compaction-state: hook entry points', () => {
  function cleanEnv(extra) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(OMC_|TYPESAFE_|CLAUDE_PLUGIN_ROOT$|DISABLE_OMC$)/.test(k)) env[k] = v;
    return { ...env, ...extra };
  }
  function run(script, payload, env) {
    return execFileSync(NODE, [join(root, 'scripts', script)], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
  }
  function project() {
    const dir = join(tmp, `hook-${++n}`);
    const home = join(dir, 'home');
    const cwd = join(dir, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore', windowsHide: true });
    return { home, cwd };
  }
  const homeEnv = (home) => ({ HOME: home, USERPROFILE: home, OMC_SKIP_HOOKS: '' });

  it('without the point the hooks write no compaction state and SessionStart prints the same output', () => {
    const { home, cwd } = project();
    const sid = 'sess-off';
    const spool = join(home, '.omc', 'state', 'jev', 'compaction-spool');
    spoolRecord(spool, sid, { result: 'fallback', reason: 'timeout' });
    const outputs = [undefined, 'all:active'].map((OMC_JEV) => {
      const env = cleanEnv({ ...homeEnv(home), ...(OMC_JEV ? { OMC_JEV, TYPESAFE_API_KEY: 'k' } : {}) });
      run('post-tool-verifier.mjs', { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'a.txt') }, tool_response: { success: true } }, env);
      run('post-tool-use-failure.mjs', { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'boom' }, env);
      return run('session-start.mjs', { session_id: sid, cwd, source: 'compact', hook_event_name: 'SessionStart' }, env);
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[0]).not.toMatch(/work state from before the compaction/);
    expect(existsSync(join(home, '.omc', 'state', 'jev', 'compaction-registry'))).toBe(false);
    expect(readdirSync(spool)).toHaveLength(1);
    expect(existsSync(join(cwd, '.omc', 'state', 'jev', 'compaction.jsonl'))).toBe(false);
  });

  it('with compaction named: PostToolUse records, SessionStart:compact moves the record and adds the registry after a fallback', () => {
    const { home, cwd } = project();
    const sid = 'sess-on';
    const env = cleanEnv({ ...homeEnv(home), OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'k' });
    run('post-tool-verifier.mjs', { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'changed.txt') }, tool_response: { success: true } }, env);
    run('post-tool-use-failure.mjs', { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'npm run lint' }, error: 'lint failed' }, env);
    spoolRecord(join(home, '.omc', 'state', 'jev', 'compaction-spool'), sid, { result: 'fallback', reason: 'timeout' });
    const out = JSON.parse(run('session-start.mjs', { session_id: sid, cwd, source: 'compact', hook_event_name: 'SessionStart' }, env).trim().split('\n').pop());
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('changed.txt');
    expect(context).toContain('lint failed');
    const rows = logRows(join(cwd, '.omc', 'state', 'jev', 'compaction.jsonl'));
    expect(rows).toEqual([expect.objectContaining({ result: 'fallback', reason: 'timeout', session_id: sid })]);
  });
});

describe('jev-compaction-state: registry limits by window (OMC_JEV_COMPACT_REGISTRY_BY_WINDOW)', () => {
  const SWITCH = 'OMC_JEV_COMPACT_REGISTRY_BY_WINDOW';
  const section = (text, label, separator) => {
    const line = String(text ?? '').split('\n').find((l) => l.startsWith(label));
    return line === undefined ? [] : line.slice(label.length).split(separator);
  };
  const filesOf = (text) => section(text, 'Changed files (newest last): ', '; ');
  const tasksOf = (text) => section(text, 'Open tasks: ', '; ');
  const gitOf = (text) => section(text, 'Recent git changes: ', ' | ');
  const pad = (i) => String(i).padStart(3, '0');
  const todos = (count) => Array.from({ length: count }, (_, i) => ({ content: `task ${pad(i + 1)}`, status: 'pending' }));
  const eventsOf = (env, sid) => readFileSync(registryPath(sid, undefined, env), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // A registry written through the hook entry point (60 files, 20 git lines, 60 tasks), then a SessionStart after the built-in
  // summary whose module record names `window`; `record: false` leaves no module record.
  function scenario(extraEnv, window, { pathPadding = 0, record = true } = {}) {
    const { env: base, sid, spool } = setup();
    const env = { ...base, ...extraEnv };
    for (let i = 1; i <= 60; i++) post(env, sid, 'Write', { file_path: `/p/${'x'.repeat(pathPadding)}file-${pad(i)}.ts` });
    for (let i = 1; i <= 20; i++) post(env, sid, 'Bash', { command: `git commit -m "change ${pad(i)}"` });
    post(env, sid, 'TodoWrite', { todos: todos(60) });
    if (record) spoolRecord(spool, sid, { result: 'fallback', reason: 'jev_error', ...(window !== undefined ? { window } : {}) });
    const out = afterSessionStart({ session_id: sid, source: 'compact' }, {}, env);
    return { out, env, sid };
  }

  it('is on only for exactly 1, surrounding spaces ignored', () => {
    expect(registryByWindowOn({})).toBe(false);
    for (const value of ['1', ' 1 ', '1\n']) expect(registryByWindowOn({ [SWITCH]: value }), JSON.stringify(value)).toBe(true);
    for (const value of ['', '0', '2', 'true', 'yes', 'on', 'active', '01', '1.0', 'off']) expect(registryByWindowOn({ [SWITCH]: value }), JSON.stringify(value)).toBe(false);
  });

  it('scales the limits with the window and keeps them for a window that is not an integer from 10000 to 10000000', () => {
    const reference = { chars: 1500, files: 20, git: 5, tasks: 15 };
    expect(registryBudgets(400_000)).toEqual(reference);
    expect(registryBudgets(1_000_000)).toEqual({ chars: 3750, files: 50, git: 13, tasks: 38 });
    expect(registryBudgets(200_000)).toEqual({ chars: 750, files: 10, git: 3, tasks: 8 });
    expect(registryBudgets(10_000)).toEqual({ chars: 38, files: 1, git: 1, tasks: 1 });
    expect(registryBudgets(10_000_000)).toEqual({ chars: 37500, files: 500, git: 125, tasks: 375 });
    for (const window of [undefined, null, 0, -400_000, NaN, Infinity, 400_000.5, 9999, 10_000_001, '1000000', {}]) {
      expect(registryBudgets(window), `window ${String(window)}`).toEqual(reference);
    }
  });

  it('unset or with any other value: 20 files, 5 git lines, 15 tasks written and shown, 1500 characters, whatever the window', () => {
    const base = scenario({}, 1_000_000);
    expect(base.out.context.length).toBeLessThanOrEqual(REGISTRY_CHARS);
    expect([filesOf(base.out.context).length, gitOf(base.out.context).length, tasksOf(base.out.context).length]).toEqual([20, 5, 15]);
    const written = eventsOf(base.env, base.sid);
    expect(written.find((e) => e.t === 'tasks').v).toHaveLength(15);
    for (const value of ['', '0', 'off', 'true', 'active', 'on', '2', '01']) {
      const other = scenario({ [SWITCH]: value }, 1_000_000);
      expect(other.out, JSON.stringify(value)).toEqual(base.out);
      expect(eventsOf(other.env, other.sid), JSON.stringify(value)).toEqual(written);
    }
  });

  it('with the switch on and a window of 1000000: the newest 50 files and 13 git lines, the first 38 tasks, 3750 characters', () => {
    const { out } = scenario({ [SWITCH]: '1' }, 1_000_000);
    expect(filesOf(out.context)).toHaveLength(50);
    expect(filesOf(out.context)[0]).toBe('/p/file-011.ts');
    expect(filesOf(out.context).at(-1)).toBe('/p/file-060.ts');
    expect(gitOf(out.context)).toHaveLength(13);
    expect(gitOf(out.context).at(-1)).toBe('git commit -m "change 020"');
    expect(tasksOf(out.context)).toHaveLength(38);
    expect(tasksOf(out.context)[0]).toBe('[pending] task 001');
    expect(tasksOf(out.context).at(-1)).toBe('[pending] task 038');
    // Long paths: the character limit drops the oldest files first.
    const long = scenario({ [SWITCH]: '1' }, 1_000_000, { pathPadding: 70 }).out.context;
    expect(long.length).toBeLessThanOrEqual(3750);
    expect(long.length).toBeGreaterThan(REGISTRY_CHARS);
    expect(filesOf(long).length).toBeLessThan(50);
    expect(filesOf(long).at(-1)).toMatch(/file-060\.ts$/);
  });

  it('with the switch on and a window of 200000: the newest 10 files and 3 git lines, the first 8 tasks, 750 characters', () => {
    const { out } = scenario({ [SWITCH]: '1' }, 200_000);
    expect(filesOf(out.context)).toHaveLength(10);
    expect(filesOf(out.context)[0]).toBe('/p/file-051.ts');
    expect(gitOf(out.context)).toHaveLength(3);
    expect(tasksOf(out.context)).toHaveLength(8);
    expect(tasksOf(out.context).at(-1)).toBe('[pending] task 008');
    expect(out.context.length).toBeLessThanOrEqual(750);
    expect(scenario({ [SWITCH]: '1' }, 200_000, { pathPadding: 70 }).out.context.length).toBeLessThanOrEqual(750);
  });

  it('with the switch on, a window of 400000, no usable window or no record: the same text as with the switch off', () => {
    const off = scenario({}, 400_000).out;
    for (const window of [400_000, undefined, null, 0, 'abc', '1000000', 9999]) {
      expect(scenario({ [SWITCH]: '1' }, window).out, `window ${String(window)}`).toEqual(off);
    }
    expect(scenario({ [SWITCH]: '1' }, undefined, { record: false }).out).toEqual(scenario({}, undefined, { record: false }).out);
  });

  it('takes the window of the record it claims: a subagent compaction gets the limits of the subagent', () => {
    const { env: base, sid, spool } = setup();
    const env = { ...base, [SWITCH]: '1' };
    for (let i = 1; i <= 60; i++) post(env, sid, 'Write', { file_path: `/sub/file-${pad(i)}.ts` }, { agent_id: 'abc123' });
    spoolRecord(spool, sid, { result: 'fallback', window: 1_000_000 });
    spoolRecord(spool, sid, { result: 'fallback', window: 200_000, agent_id: 'abc123' }, 1000);
    const out = afterSessionStart({ session_id: sid, source: 'compact', transcript_path: `/t/${sid}/subagents/agent-abc123.jsonl` }, {}, env);
    expect(filesOf(out.context)).toHaveLength(10);
  });

  it('applies the scaled character limit with the cleaning writers and without them', () => {
    const { env, sid } = setup();
    const on = { ...env, [SWITCH]: '1' };
    post(on, sid, 'TodoWrite', { todos: Array.from({ length: 20 }, (_, i) => ({ content: `${pad(i)}`.repeat(50), status: 'pending' })) });
    post(on, sid, 'Bash', { command: 'git push' });
    const budgets = registryBudgets(1_600_000);
    const fitted = renderRegistry(sid, undefined, on, writers, budgets);
    expect(fitted.length).toBeGreaterThan(REGISTRY_CHARS);
    expect(fitted).toContain('git push');
    expect(renderRegistry(sid, undefined, on, undefined, budgets)).toBe(fitted);
    for (const text of [renderRegistry(sid, undefined, on, writers, registryBudgets(200_000)), renderRegistry(sid, undefined, on, undefined, registryBudgets(200_000))]) {
      expect(text.length).toBeLessThanOrEqual(750);
      expect(text.endsWith('\u2026')).toBe(true);
    }
  });

  it('writes a task list of up to 100 entries while the switch is on, for TodoWrite and a plan tool, and 15 while it is off', () => {
    for (const [extraEnv, count] of [[{ [SWITCH]: '1' }, 100], [{}, 15], [{ [SWITCH]: 'off' }, 15]]) {
      const { env: base, sid } = setup();
      const env = { ...base, ...extraEnv };
      post(env, sid, 'TodoWrite', { todos: todos(120) });
      post(env, sid, 'mcp__x__update_plan', { items: todos(120) });
      expect(eventsOf(env, sid).map((e) => e.v.length), JSON.stringify(extraEnv)).toEqual([count, count]);
    }
  });

  // Made-up keys, put together here: the first is known to the shared mask, the other two only to the mask of a series.
  const KEYS = [['sk-ant-', 'api03-', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'], ['gsk_', 'a1B2c3D4', 'e5F6g7H8', 'i9J0k1L2'], ['ASIA', 'QWER5TYU', 'IOP7ASDF']].map((parts) => parts.join(''));
  const withKeys = (env, sid) => {
    // The keys stand among the first 15 tasks, which are written without the switch too, and further on, where only the longer list reaches.
    const keyAt = (k) => (k % 20 >= 10 && k % 20 < 13 ? KEYS[(k % 20) - 10] : undefined);
    const list = Array.from({ length: 40 }, (_, k) => ({ content: keyAt(k) ? `rotate ${keyAt(k)}` : `task ${pad(k)}`, activeForm: 'x', status: 'pending' }));
    post(env, sid, 'TodoWrite', { todos: list });
    post(env, sid, 'TodoWrite', { todos: [{ activeForm: `Rotating ${KEYS[1]}`, status: 'in_progress' }] });
    post(env, sid, 'mcp__x__update_plan', { items: [{ content: `step ${KEYS[1]}`, status: 'pending' }, { content: `step ${KEYS[2]}`, status: 'pending' }] });
    post(env, sid, 'TaskCreate', { subject: `create ${KEYS[1]}` }, { tool_response: { task: { id: '1' } } });
    post(env, sid, 'TaskCreate', { description: `describe ${KEYS[2]}` }, { tool_response: { task: { id: '2' } } });
    post(env, sid, 'TaskUpdate', { taskId: '1', status: 'in_progress', subject: `update ${KEYS[0]}` });
    post(env, sid, 'TodoWrite', { todos: list });
  };

  it('masks the text of every task before it is written while the switch is on, so no longer list brings a key to the file or the context', () => {
    const { env: base, sid, spool } = setup();
    const env = { ...base, [SWITCH]: '1' };
    withKeys(env, sid);
    const written = readFileSync(registryPath(sid, undefined, env), 'utf8');
    spoolRecord(spool, sid, { result: 'fallback', window: 1_000_000 });
    const shown = afterSessionStart({ session_id: sid, source: 'compact' }, {}, env).context;
    expect(tasksOf(shown)).toHaveLength(38);
    for (const key of KEYS) for (const text of [written, shown]) expect(text).not.toContain(key.slice(-16));
    const texts = eventsOf(env, sid).flatMap((e) => (e.t === 'tasks' ? e.v.map((x) => x.text) : [e.text]));
    expect(texts).toHaveLength(40 + 1 + 2 + 3 + 40);
    expect(texts).toContain('task 000');
    for (const start of ['rotate ', 'Rotating ', 'step ', 'create ', 'describe ', 'update ']) expect(texts.some((t) => t.startsWith(start)), start).toBe(true);
  });

  it('reads a bounded start of a long task text for the masks and cuts it to 150 characters', () => {
    const { env: base, sid } = setup();
    const env = { ...base, [SWITCH]: '1' };
    post(env, sid, 'TaskCreate', { subject: `${' '.repeat(590)}head${' '.repeat(20)}tail` });
    post(env, sid, 'TaskCreate', { subject: 'word '.repeat(100) });
    const [bounded, cut] = eventsOf(env, sid).map((e) => e.text);
    expect(bounded).toBe('head');
    expect(cut).toHaveLength(150);
  });

  it('writes the task texts as they stand without the switch', () => {
    for (const value of [undefined, '', 'off', 'true']) {
      const { env: base, sid } = setup();
      const env = { ...base, [SWITCH]: value };
      withKeys(env, sid);
      post(env, sid, 'TaskCreate', { subject: `${' '.repeat(590)}head${' '.repeat(20)}tail` });
      const events = eventsOf(env, sid);
      expect(events[0].v.map((x) => x.text).slice(10, 13), String(value)).toEqual(KEYS.map((key) => `rotate ${key}`));
      expect(events.slice(1, 6).flatMap((e) => (e.t === 'tasks' ? e.v.map((x) => x.text) : [e.text]))).toEqual([
        `Rotating ${KEYS[1]}`, `step ${KEYS[1]}`, `step ${KEYS[2]}`, `create ${KEYS[1]}`, `describe ${KEYS[2]}`, `update ${KEYS[0]}`,
      ]);
      expect(events.at(-1).text).toBe('head tail');
    }
  });

  it('cuts the tasks when read: the first ones of a list, the newest of added ones', () => {
    const budgets = registryBudgets(200_000);
    const listed = setup();
    post({ ...listed.env, [SWITCH]: '1' }, listed.sid, 'TodoWrite', { todos: todos(30) });
    expect(foldRegistry(listed.sid, undefined, listed.env, budgets).tasks.map((t) => t.text)).toEqual(todos(8).map((t) => t.content));
    const added = setup();
    for (let i = 1; i <= 50; i++) post(added.env, added.sid, 'TaskCreate', { subject: `added ${pad(i)}` }, { tool_response: { task: { id: String(i) } } });
    expect(foldRegistry(added.sid, undefined, added.env, budgets).tasks.map((t) => t.text)).toEqual(Array.from({ length: 8 }, (_, i) => `added ${pad(i + 43)}`));
    expect(foldRegistry(added.sid, undefined, added.env).tasks).toHaveLength(15);
    expect(foldRegistry(added.sid, undefined, added.env, registryBudgets(1_000_000)).tasks).toHaveLength(38);
  });

  it('shows at most 15 tasks of a list written with the switch on once the switch is off', () => {
    const { env, sid, spool } = setup();
    post({ ...env, [SWITCH]: '1' }, sid, 'TodoWrite', { todos: todos(120) });
    for (const value of [undefined, 'off']) {
      const off = { ...env, [SWITCH]: value };
      expect(tasksOf(renderRegistry(sid, undefined, off)), String(value)).toHaveLength(15);
      spoolRecord(spool, sid, { result: 'fallback', window: 1_000_000 });
      expect(tasksOf(afterSessionStart({ session_id: sid, source: 'compact' }, {}, off).context), String(value)).toHaveLength(15);
    }
  });

  it('reaches the hooks through their environment: PostToolUse writes the longer list, SessionStart shows it', () => {
    const home = join(tmp, 'by-window-home');
    const cwd = join(tmp, 'by-window-project');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd });
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|CODEX|DISABLE_OMC)/i.test(k)));
    const env = { ...clean, HOME: home, USERPROFILE: home, OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'k', [SWITCH]: '1' };
    const run = (script, input) => execFileSync(NODE, [join(root, 'scripts', script)], { env, encoding: 'utf8', input: JSON.stringify(input), timeout: 30000 });
    const sid = 'sess-window';
    run('post-tool-verifier.mjs', { session_id: sid, cwd, tool_name: 'TodoWrite', tool_input: { todos: todos(30) }, tool_response: { success: true } });
    spoolRecord(join(home, '.omc', 'state', 'jev', 'compaction-spool'), sid, { result: 'fallback', reason: 'timeout', window: 1_000_000 });
    const out = JSON.parse(run('session-start.mjs', { session_id: sid, cwd, source: 'compact', hook_event_name: 'SessionStart' }).trim().split('\n').pop());
    expect(out.hookSpecificOutput.additionalContext).toContain('[pending] task 030');
  });
});
