// Tests for the user prohibitions tool (rules v1, v2 and v3 in its module docstring).
// Synthetic transcripts in a temporary directory; the script runs with python3 -I -B through spawnSync.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', '..', 'tools', 'diagnostics', 'user_prohibitions_after_compaction.py');
const MARKER = 'MARKER-7f3a9c';
const UNTIL = '2026-11-16T12:00:00Z';
const LOCATOR_KEYS = ['boundary', 'boundary_file', 'boundary_line', 'call_line', 'class', 'file', 'prohibition_line', 'tool'];
const LOCATOR_KEYS_V2 = ['boundary', 'boundary_line', 'call_lines', 'candidate_count', 'class', 'file', 'history_group',
  'prohibition_line', 'target', 'tools'];
const WORK = mkdtempSync(join(tmpdir(), 'test-user-prohibitions-'));

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const ts = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
const user = (minute: number, text: string): Row => ({ type: 'user', message: { role: 'user', content: text }, timestamp: ts(minute) });
const userBlocks = (minute: number, texts: string[]): Row => ({
  type: 'user', message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) }, timestamp: ts(minute),
});
function call(minute: number, name: string, input: Row, id: string, model?: string): Row {
  const message: Row = { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
  if (model !== undefined) message.model = model;
  return { type: 'assistant', message, timestamp: ts(minute) };
}
const host = (minute: number, when?: string): Row => ({ type: 'system', subtype: 'compact_boundary', timestamp: when ?? ts(minute) });
const jev = (sessionId: string, minute: number, result = 'jev', agentId: string | null = null): Row => ({
  event: 'compact', session_id: sessionId, ts: ts(minute), result, agent_id: agentId,
});

function writeJsonl(path: string, rows: Row[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function snapshot(root: string): string[] {
  const items: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else items.push(`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`);
    }
  };
  walk(root);
  return items.sort();
}

function tool(args: string[]) {
  return spawnSync('python3', ['-I', '-B', TOOL, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface RunOptions { compact?: Row[]; rule?: number | null; patterns?: Row }

// Builds the fixture under WORK/name, runs the tool with --out and --locators, returns what it produced.
function run(name: string, sessions: Record<string, Row[]>, options: RunOptions = {}) {
  const { compact, rule = 1, patterns } = options;
  const root = join(WORK, name);
  const projects = join(root, 'projects');
  for (const [relative, rows] of Object.entries(sessions)) writeJsonl(join(projects, relative), rows);
  const args = ['--projects', projects, '--to', UNTIL, '--days', '7'];
  if (compact) {
    const compactPath = join(root, 'compaction.jsonl');
    writeJsonl(compactPath, compact);
    args.push('--compact-log', compactPath);
  }
  if (patterns) {
    const patternsPath = join(root, 'patterns.json');
    writeFileSync(patternsPath, JSON.stringify(patterns));
    args.push('--patterns', patternsPath);
  }
  if (rule !== null) args.push('--rule', String(rule));
  const outPath = join(root, 'out.json');
  const locPath = join(root, 'loc.jsonl');
  args.push('--out', outPath, '--locators', locPath);
  const before = snapshot(projects);
  const proc = tool(args);
  expect(snapshot(projects), 'input transcripts changed').toEqual(before);
  expect(proc.status, `exit ${proc.status}: ${proc.stderr}`).toBe(0);
  const outText = readFileSync(outPath, 'utf8');
  const locText = readFileSync(locPath, 'utf8');
  const report: Json = JSON.parse(outText);
  const locators: Json[] = locText.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { report, locators, texts: [proc.stdout, proc.stderr, outText, locText] };
}

// Evaluates a Python expression against the tool module (without bytecode next to it); `argument` is the parsed JSON.
function pyEval(expression: string, argument: unknown) {
  const code = [
    'import importlib.util, json, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("tool", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'argument = json.loads(sys.argv[2])',
    `print(json.dumps(${expression}))`,
  ].join('\n');
  // The limit lets a regression in a matching pattern fail the test instead of hanging the run.
  const proc = spawnSync('python3', ['-I', '-B', '-c', code, TOOL, JSON.stringify(argument)], { encoding: 'utf8', timeout: 30000 });
  expect(proc.status, proc.stderr).toBe(0);
  return JSON.parse(proc.stdout);
}

// Synthetic wording for the pattern file: invented tokens, so the tests need no real-language phrases.
// Each list mirrors the shape of the default wording: one entry per class, a bare permission word for rule v2,
// explicit permission phrases for rule v3, a question word, and a negation word.
const SYNTHETIC_PATTERNS = {
  prohibitions: [
    ['\\bhands\\s+off\\b', 'edit'], ['\\bno-delete\\b', 'delete'], ['\\bno-install\\b', 'install'],
    ['\\bno-deploy\\b', 'deploy'], ['\\bno-run\\b', 'run'], ['\\bno-push\\b', 'push'], ['\\bfreeze\\b', 'other'],
  ],
  revocations_v2: ['(?<!never\\s)\\b(?:already\\s+)?allowed\\b', '(?<!never\\s)\\bclear\\s+to\\s+proceed\\b'],
  revocations_v3: ['\\balready\\s+allowed\\b', '\\ballowed\\s+already\\b', '\\bnow\\s+allowed\\b', '\\bclear\\s+to\\s+proceed\\b'],
  permission_words: ['allowed'],
  question_starts: ['whether'],
  negations: ['never'],
};

describe('user prohibitions after compaction', () => {
  it('an edit after a host boundary is a candidate; locator fields', () => {
    const rows = [user(1, "Don't touch `/srv/app/config.py` today"), host(2), call(3, 'Edit', { file_path: '/srv/app/config.py' }, 'c1')];
    const { report, locators } = run('edit-host', { 'p/s1.jsonl': rows });
    expect(report.candidates.total).toBe(1);
    expect(report.candidates.by_class).toEqual({ edit: 1 });
    expect(locators).toHaveLength(1);
    const found = locators[0];
    expect([found.prohibition_line, found.boundary, found.boundary_line, found.call_line]).toEqual([1, 'host', 2, 3]);
    expect([found.class, found.tool]).toEqual(['edit', 'Edit']);
    expect(Object.keys(found).sort()).toEqual(LOCATOR_KEYS);
  });

  it('the same edit before the boundary is not a candidate', () => {
    const rows = [user(1, "Don't touch /srv/b.py"), call(2, 'Edit', { file_path: '/srv/b.py' }, 'c1'), host(3)];
    const { report, locators } = run('before-boundary', { 'p/s2.jsonl': rows });
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
    expect(report.boundaries.host).toBe(1);
  });

  it('a prohibition without a later boundary is not a candidate', () => {
    const rows = [user(1, "Don't change /srv/c.py"), call(2, 'Edit', { file_path: '/srv/c.py' }, 'c1')];
    expect(run('no-boundary', { 'p/s3.jsonl': rows }).report.candidates.total).toBe(0);
  });

  it('a general push and a git -C commit after a Jev boundary', () => {
    const rows4 = [user(1, 'Do not push, please'), call(3, 'Bash', { command: 'git push origin main' }, 'c1')];
    const rows5 = [user(1, 'Do not commit'), call(3, 'Bash', { command: 'git -C /srv/repo commit -m x' }, 'd1')];
    const { report, locators } = run('general-jev', { 'p/s4.jsonl': rows4, 'p/s5.jsonl': rows5 }, { compact: [jev('s4', 2), jev('s5', 2)] });
    expect(report.candidates.by_class).toEqual({ commit: 1, push: 1 });
    expect(report.boundaries).toEqual({ host: 0, jev: 2 });
    const push = locators.find((item) => item.class === 'push')!;
    expect([push.boundary, push.boundary_line, push.tool]).toEqual(['jev', 1, 'Bash']);
    expect(push.boundary_file.endsWith('compaction.jsonl')).toBe(true);
  });

  it('a journal row and the transcript boundary of one compaction are one Jev boundary', () => {
    const rows = [user(1, 'Do not push, please'), host(2), call(3, 'Bash', { command: 'git push origin main' }, 'c1')];
    const { report, locators } = run('paired-jev', { 'p/s30.jsonl': rows }, { compact: [jev('s30', 2)] });
    expect(report.boundaries).toEqual({ host: 0, jev: 1 });
    expect(report.candidates.by_boundary).toEqual({ host: 0, jev: 1 });
    expect(report.results[0]).toMatchObject({ name: 'candidates by boundary host', numerator: 0, denominator: 0 });
    expect(report.results[1]).toMatchObject({ name: 'candidates by boundary jev', numerator: 1, denominator: 1, share: 1 });
    expect([locators[0].boundary, locators[0].boundary_line]).toEqual(['jev', 2]);
    expect(locators[0].boundary_file.endsWith('s30.jsonl')).toBe(true);
    // The same holds when the journal time is a few seconds after the transcript boundary, so the order of the two does not matter.
    const later = run('paired-jev-later', { 'p/s31.jsonl': [user(1, 'Do not push'), host(2), call(4, 'Bash', { command: 'git push' }, 'c1')] },
      { compact: [{ ...jev('s31', 2), ts: '2026-11-15T10:02:05.000Z' }] });
    expect(later.report.boundaries).toEqual({ host: 0, jev: 1 });
    expect(later.report.candidates.by_boundary).toEqual({ host: 0, jev: 1 });
  });

  it('a transcript boundary without a journal row is a host boundary next to a paired Jev one', () => {
    const rows = [user(1, 'Do not push'), host(2), host(40), call(41, 'Bash', { command: 'git push' }, 'c1')];
    const { report } = run('paired-mixed', { 'p/s32.jsonl': rows }, { compact: [jev('s32', 2)] });
    expect(report.boundaries).toEqual({ host: 1, jev: 1 });
    expect(report.candidates.by_boundary).toEqual({ host: 0, jev: 1 });
    const hostOnly = run('host-only-boundary', { 'p/s33.jsonl': [user(1, 'Do not push'), host(2), call(3, 'Bash', { command: 'git push' }, 'c1')] },
      { compact: [jev('other-session', 2)] });
    expect(hostOnly.report.boundaries).toEqual({ host: 1, jev: 1 });
    expect(hostOnly.report.candidates.by_boundary).toEqual({ host: 1, jev: 0 });
  });

  it('pairing follows the window and consumes rows: far rows stay apart, one row takes one boundary', () => {
    const far = run('pair-far', { 'p/s34.jsonl': [user(1, 'Do not push'), host(2), call(3, 'Bash', { command: 'git push' }, 'c1')] },
      { compact: [jev('s34', 20)] });
    expect(far.report.boundaries).toEqual({ host: 1, jev: 1 });
    const once = run('pair-once', { 'p/s35.jsonl': [user(1, 'Do not push'), host(2), host(5), call(6, 'Bash', { command: 'git push' }, 'c1')] },
      { compact: [jev('s35', 4)] });
    // The journal row is 120 s from the first boundary and 60 s from the second: the closer boundary takes it.
    expect(once.report.boundaries).toEqual({ host: 1, jev: 1 });
    expect(once.report.candidates.by_boundary).toEqual({ host: 1, jev: 0 });
    const closer = run('pair-closer', { 'p/s36.jsonl': [user(1, 'Do not push'), host(2), host(5), call(6, 'Bash', { command: 'git push' }, 'c1')] },
      { compact: [{ ...jev('s36', 5), ts: '2026-11-15T10:05:10.000Z' }] });
    expect(closer.report.boundaries).toEqual({ host: 1, jev: 1 });
    expect(closer.report.candidates.by_boundary).toEqual({ host: 1, jev: 0 });
  });

  it('a journal row just outside the period still pairs with the boundary inside it', () => {
    const rows = [
      { ...user(1, 'Do not push'), timestamp: '2026-11-09T12:01:00.000Z' },
      host(2, '2026-11-09T12:02:00.000Z'),
      { ...call(3, 'Bash', { command: 'git push' }, 'c1'), timestamp: '2026-11-09T12:03:00.000Z' },
    ];
    const { report } = run('pair-edge', { 'p/s38.jsonl': rows }, { compact: [{ ...jev('s38', 0), ts: '2026-11-09T11:58:00.000Z' }] });
    expect(report.boundaries).toEqual({ host: 0, jev: 1 });
    expect(report.candidates.by_boundary).toEqual({ host: 0, jev: 1 });
  });

  it('a boundary paired with a fallback row is a host boundary', () => {
    const rows = [user(1, 'Do not push'), host(2), call(3, 'Bash', { command: 'git push' }, 'c1')];
    const { report } = run('paired-fallback', { 'p/s37.jsonl': rows }, { compact: [jev('s37', 2, 'fallback')] });
    expect(report.boundaries).toEqual({ host: 1, jev: 0 });
    expect(report.candidates.by_boundary).toEqual({ host: 1, jev: 0 });
  });

  it("a don't-form prohibition with a git -C commit", () => {
    const rows = [user(1, "Don't commit this yet"), host(2), call(3, 'Bash', { command: 'git -C /srv/repo commit -m x' }, 'c1')];
    expect(run('english', { 'p/s14.jsonl': rows }).report.candidates.by_class).toEqual({ commit: 1 });
  });

  it('a general edit prohibition gives no candidate', () => {
    const rows = [user(1, "Don't touch this"), host(2), call(3, 'Edit', { file_path: '/srv/x.py' }, 'c1')];
    expect(run('general-edit', { 'p/s5b.jsonl': rows }).report.candidates.total).toBe(0);
  });

  it('excluded rows and text blocks do not count', () => {
    const rows: Row[] = [
      userBlocks(1, ['<system-reminder>Do not touch /srv/y.py</system-reminder>', 'Ok, go on']),
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Do not touch /srv/z.py' }, timestamp: ts(2) },
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Do not touch /srv/z.py' }, timestamp: ts(3) },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Do not touch /srv/z.py' }] }, timestamp: ts(4) },
      user(5, '<command-name>/status</command-name> do not touch /srv/z.py'),
      user(6, '[Request interrupted by user] do not push'),
      user(7, 'Caveat: do not delete /srv/z.py'),
      user(8, '<task-notification>do not restart</task-notification>'),
      host(9),
      call(10, 'Edit', { file_path: '/srv/y.py' }, 'c1'),
      call(11, 'Edit', { file_path: '/srv/z.py' }, 'c2'),
      call(12, 'Bash', { command: 'git push origin main' }, 'c3'),
    ];
    const { report, locators } = run('excluded', { 'p/s6.jsonl': rows });
    expect(report.user_messages.in_period).toBe(1);
    expect(report.prohibitions.total).toBe(0);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
  });

  it('embedded reminders, flagged rows and work-state marker rows are excluded', () => {
    const rows: Row[] = [
      userBlocks(1, ['Ok, go on<system-reminder>Do not touch /srv/k.py, do not edit CLAUDE.md</system-reminder>']),
      { type: 'user', toolUseResult: { ok: true }, message: { role: 'user', content: 'Do not touch /srv/m.py' }, timestamp: ts(2) },
      { type: 'user', isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Do not touch /srv/n.py' }, timestamp: ts(3) },
      user(4, '[OMC: work state from before the compaction] do not delete /srv/p.py'),
      host(5),
      call(6, 'Edit', { file_path: '/srv/k.py' }, 'c1'),
      call(7, 'Edit', { file_path: '/srv/m.py' }, 'c2'),
      call(8, 'Edit', { file_path: '/srv/n.py' }, 'c3'),
      call(9, 'Bash', { command: 'rm /srv/p.py' }, 'c4'),
    ];
    const { report, locators } = run('embedded', { 'p/s6b.jsonl': rows });
    expect(report.user_messages.in_period).toBe(1);
    expect(report.prohibitions.total).toBe(0);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
  });

  it('a call is counted once, for the earliest prohibition', () => {
    const rows = [user(1, "Don't touch /srv/d.py"), user(2, "Don't touch /srv/d.py"), host(3), call(4, 'Edit', { file_path: '/srv/d.py' }, 'c1')];
    const { report, locators } = run('once', { 'p/s7.jsonl': rows });
    expect(report.candidates.total).toBe(1);
    expect(report.prohibitions.total).toBe(2);
    expect([locators[0].prohibition_line, locators[0].call_line]).toEqual([1, 4]);
  });

  it('a boundary outside the period is ignored', () => {
    const rows = [user(1, "Don't touch /srv/g.py"), host(0, '2026-11-01T10:00:00.000Z'), call(3, 'Edit', { file_path: '/srv/g.py' }, 'c1')];
    const { report, locators } = run('outside', { 'p/s8.jsonl': rows });
    expect(report.boundaries.host).toBe(0);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
  });

  it('subagent transcripts are counted, not read', () => {
    const main = [user(1, "Don't touch /srv/e.py"), host(2)];
    const sub = [user(1, "Don't touch /srv/e.py"), host(2), call(3, 'Edit', { file_path: '/srv/e.py' }, 'c1')];
    const { report } = run('subagent', { 'p/s9.jsonl': main, 'p/s9/subagents/agent-a.jsonl': sub });
    expect([report.transcript_files, report.subagent_files]).toEqual([1, 1]);
    expect(report.candidates.total).toBe(0);
  });

  it('synthetic rows are skipped and call ids are deduplicated', () => {
    const rows = [user(1, "Don't touch /srv/e.py"), host(2),
      call(3, 'Edit', { file_path: '/srv/e.py' }, 'dup1', '<synthetic>'),
      call(4, 'Edit', { file_path: '/srv/e.py' }, 'dup2'),
      call(5, 'Edit', { file_path: '/srv/e.py' }, 'dup2')];
    const { report, locators } = run('dedupe', { 'p/s10.jsonl': rows });
    expect(report.candidates.total).toBe(1);
    expect(locators[0].call_line).toBe(4);
  });

  it('NotebookEdit and rm candidates; the marker stays out of every output', () => {
    const rows = [user(1, `Do not delete /srv/${MARKER}.txt, it is ${MARKER}`), host(2),
      call(3, 'Bash', { command: `rm /srv/${MARKER}.txt` }, 'c1'),
      user(4, "Don't touch /srv/nb.ipynb"), host(5),
      call(6, 'NotebookEdit', { notebook_path: '/srv/nb.ipynb' }, 'c2')];
    const { report, texts } = run('leak', { 'p/s11.jsonl': rows });
    expect(report.candidates.by_class).toEqual({ delete: 1, edit: 1 });
    expect(report.candidates.by_tool).toEqual({ Bash: 1, NotebookEdit: 1 });
    for (const text of texts) expect(text.includes(MARKER), 'marker found in output').toBe(false);
  });

  it('a bare class other gives no candidate (wording from a pattern file)', () => {
    const rows = [user(1, 'Freeze /srv/f.py'), host(2), call(3, 'Edit', { file_path: '/srv/f.py' }, 'c1')];
    const { report } = run('other', { 'p/s12.jsonl': rows }, { patterns: SYNTHETIC_PATTERNS });
    expect(report.prohibitions.by_class).toEqual({ other: 1 });
    expect(report.candidates.total).toBe(0);
  });

  it('a pattern file replaces a default list as a whole', () => {
    const rows = [user(1, 'Hands off /srv/f.py and do not push'), host(2),
      call(3, 'Edit', { file_path: '/srv/f.py' }, 'c1'), call(4, 'Bash', { command: 'git push origin main' }, 'c2')];
    const withFile = run('patterns', { 'p/s13.jsonl': rows }, { patterns: { prohibitions: [['\\bhands\\s+off\\b', 'edit']] } });
    expect(withFile.report.prohibitions.by_class).toEqual({ edit: 1 });
    expect(withFile.report.candidates.by_class).toEqual({ edit: 1 });
    const withDefaults = run('patterns-default', { 'p/s13b.jsonl': rows });
    expect(withDefaults.report.prohibitions.by_class).toEqual({ push: 1 });
    expect(withDefaults.report.candidates.by_class).toEqual({ push: 1 });
  });

  it('a Jev boundary with an agent id or a non-jev result is ignored', () => {
    const rows = [user(1, 'Do not push'), call(3, 'Bash', { command: 'git push' }, 'c1')];
    const { report, locators } = run('jev-ignored', { 'p/s20.jsonl': rows }, { compact: [jev('s20', 2, 'jev', 'a1'), jev('s20', 2, 'fallback')] });
    expect(report.boundaries.jev).toBe(0);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
  });

  it('output files have mode 0600 and carry the template fields', () => {
    const rows = [user(1, "Don't touch /srv/h.py"), host(2), call(3, 'Edit', { file_path: '/srv/h.py' }, 'c1')];
    const { report } = run('perm', { 'p/s21.jsonl': rows });
    expect(report.template).toBe('compaction-report/1');
    expect(report.metric).toBe('user-prohibitions');
    for (const name of ['out.json', 'loc.jsonl']) {
      expect(statSync(join(WORK, 'perm', name)).mode & 0o777).toBe(0o600);
    }
  });

  it('usage and input errors return 2', () => {
    const root = join(WORK, 'usage');
    mkdirSync(join(root, 'projects'), { recursive: true });
    const existing = join(root, 'exists.json');
    writeFileSync(existing, '{}');
    const files: Record<string, unknown> = {
      'uncompilable.json': { prohibitions: [['(unclosed', 'edit']] },
      'unknown-key.json': { mystery: [] },
      'unknown-class.json': { prohibitions: [['x', 'fly']] },
      'not-a-list.json': { negations: 'not' },
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(content));
    const base = ['--projects', join(root, 'projects')];
    const cases: Record<string, string[]> = {
      'negative days': [...base, '--days', '-1'],
      'bad to': [...base, '--to', 'not-a-date'],
      'missing projects': ['--projects', join(root, 'absent')],
      'existing output': [...base, '--out', existing],
      'bad rule': [...base, '--rule', '4'],
      'missing patterns file': [...base, '--patterns', join(root, 'absent.json')],
      'uncompilable pattern': [...base, '--patterns', join(root, 'uncompilable.json')],
      'unknown pattern key': [...base, '--patterns', join(root, 'unknown-key.json')],
      'unknown class': [...base, '--patterns', join(root, 'unknown-class.json')],
      'list expected': [...base, '--patterns', join(root, 'not-a-list.json')],
    };
    for (const [label, args] of Object.entries(cases)) expect(tool(args).status, label).toBe(2);
  });

  it('a failed --locators write leaves no output file behind, and the two outputs must differ', () => {
    const root = join(WORK, 'locators-failure');
    mkdirSync(join(root, 'projects'), { recursive: true });
    const base = ['--projects', join(root, 'projects'), '--to', UNTIL, '--days', '7'];
    const same = join(root, 'same.json');
    const sameRun = tool([...base, '--out', same, '--locators', same]);
    expect(sameRun.status).toBe(2);
    expect(sameRun.stderr).toMatch(/--locators must differ from --out/);
    expect(existsSync(same)).toBe(false);
    // The locator file cannot be created (its directory is missing): the report written first is removed again.
    const out = join(root, 'out.json');
    const failed = tool([...base, '--out', out, '--locators', join(root, 'absent-dir', 'loc.jsonl')]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toMatch(/cannot read or write a file/);
    expect(existsSync(out)).toBe(false);
    // Without --out the report is printed only after both files exist, so a failure prints nothing on stdout.
    const quiet = tool([...base, '--locators', join(root, 'absent-dir', 'loc.jsonl')]);
    expect(quiet.status).toBe(2);
    expect(quiet.stdout).toBe('');
  });

  it('v2 cuts fragments inside blocks (attributes, no closing tag)', () => {
    const rows = [
      userBlocks(1, ['Ok, go on<system-reminder id="r1">Do not touch /srv/v2a.py</system-reminder> end']),
      userBlocks(2, ['Go on<system-reminder id="r2">Do not delete /srv/v2b.py']),
      host(3),
      call(4, 'Edit', { file_path: '/srv/v2a.py' }, 'c1'),
      call(5, 'Bash', { command: 'rm /srv/v2b.py' }, 'c2'),
    ];
    const { report, locators } = run('v2-inside', { 'p/v2a.jsonl': rows }, { rule: 2 });
    expect(report.user_messages.in_period).toBe(2);
    expect(report.prohibitions.total).toBe(0);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
    expect(report.removed_fragments['system-reminder']).toBe(2);
  });

  it('v2 cuts cross-session, teammate, pasted and Another-session text', () => {
    const rows = [
      user(1, 'Ok<cross-session-message from="s">Do not touch /srv/v2c.py</cross-session-message>'),
      user(2, '<teammate-message id="t">Do not touch /srv/v2d.py'),
      user(3, '<pasted_content id="p">Do not delete /srv/v2e.py</pasted_content>'),
      user(4, 'Ok. Another Claude session sent a message: do not run /srv/v2f.py'),
      host(5),
      call(6, 'Edit', { file_path: '/srv/v2c.py' }, 'c1'),
      call(7, 'Edit', { file_path: '/srv/v2d.py' }, 'c2'),
      call(8, 'Bash', { command: 'rm /srv/v2e.py' }, 'c3'),
      call(9, 'Bash', { command: 'python3 /srv/v2f.py' }, 'c4'),
    ];
    const { report, locators } = run('v2-kinds', { 'p/v2b.jsonl': rows }, { rule: 2 });
    // Rows left with no text after the cuts are not user messages (rule c): only rows 1 and 4 remain.
    expect(report.user_messages.in_period).toBe(2);
    expect(report.prohibitions.total).toBe(0);
    expect(locators).toEqual([]);
    for (const kind of ['cross-session-message', 'teammate-message', 'pasted_content', 'another-claude-session']) {
      expect(report.removed_fragments[kind], kind).toBe(1);
    }
  });

  it('v2 revocation in the same message gives no candidate', () => {
    const rows = [user(1, "Don't touch `/srv/v2g.py`, but you may now go ahead"), host(2), call(3, 'Edit', { file_path: '/srv/v2g.py' }, 'c1')];
    const { report, locators } = run('v2-revoked', { 'p/v2c.jsonl': rows }, { rule: 2 });
    expect(report.prohibitions.total).toBe(1);
    expect(report.prohibitions.revoked_in_same_message).toBe(1);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
  });

  it('v2 a negated permission phrase is not a revocation', () => {
    const rows = [user(1, "Don't touch /srv/v2h.py, you may not go ahead"), host(2), call(3, 'Edit', { file_path: '/srv/v2h.py' }, 'c1')];
    const { report } = run('v2-negated', { 'p/v2d.jsonl': rows }, { rule: 2 });
    expect(report.prohibitions.revoked_in_same_message).toBe(0);
    expect(report.candidates.total).toBe(1);
  });

  it('v2 general classes match their calls, read-only commands do not', () => {
    const sessions: Record<string, Row[]> = {
      'p/g-edit.jsonl': [user(1, 'Hands off'), host(2),
        call(3, 'Edit', { file_path: '/srv/g1.py' }, 'e1'), call(4, 'Bash', { command: 'ls -la' }, 'e2')],
      'p/g-delete.jsonl': [user(1, 'No-delete'), host(2),
        call(3, 'Bash', { command: 'rm -rf build/' }, 'd1'), call(4, 'Bash', { command: 'npm test' }, 'd2')],
      'p/g-install.jsonl': [user(1, 'No-install'), host(2),
        call(3, 'Bash', { command: 'npm install left-pad' }, 'i1'), call(4, 'Bash', { command: 'npm test' }, 'i2')],
      'p/g-deploy.jsonl': [user(1, 'No-deploy'), host(2),
        call(3, 'Bash', { command: './deploy.sh' }, 'w1'), call(4, 'Bash', { command: 'git status' }, 'w2')],
      'p/g-run.jsonl': [user(1, 'No-run'), host(2),
        call(3, 'Bash', { command: 'python3 tool.py' }, 'r1'), call(4, 'Bash', { command: 'ls -la' }, 'r2')],
      'p/g-other.jsonl': [user(1, 'Freeze'), host(2),
        call(3, 'Bash', { command: 'cat notes.txt' }, 'o1'), call(4, 'Bash', { command: 'tee out.txt' }, 'o2')],
    };
    const { report, locators } = run('v2-general', sessions, { rule: 2, patterns: SYNTHETIC_PATTERNS });
    expect(report.candidates.by_class).toEqual({ edit: 1, delete: 1, install: 1, deploy: 1, run: 1, other: 1 });
    expect(report.candidates.total).toBe(6);
    expect(locators).toHaveLength(6);
    expect(locators.every((item) => item.candidate_count === 1)).toBe(true);
  });

  it('v2 two prohibitions give two pairs for one call', () => {
    const rows = [user(1, "Don't touch /srv/v2p.py"), user(2, "Don't delete /srv/v2p.py"), host(3), call(4, 'Edit', { file_path: '/srv/v2p.py' }, 'p1')];
    const { report, locators } = run('v2-pairs', { 'p/v2e.jsonl': rows }, { rule: 2 });
    const candidates = report.candidates;
    expect([candidates.total, candidates.pairs, candidates.unique_calls]).toEqual([2, 2, 1]);
    expect(candidates.prohibitions_with_candidate).toBe(2);
    expect(candidates.by_class).toEqual({ delete: 1, edit: 1 });
    expect(locators).toHaveLength(2);
  });

  it('v2 locator row fields and the first five calls', () => {
    const rows = [user(1, "Don't touch /srv/v2l.py"), host(2)];
    for (let index = 0; index < 7; index += 1) rows.push(call(3 + index, 'Edit', { file_path: '/srv/v2l.py' }, `l${index}`));
    const { locators } = run('v2-locator', { 'p/v2f.jsonl': rows }, { rule: 2 });
    expect(locators).toHaveLength(1);
    expect(Object.keys(locators[0]).sort()).toEqual(LOCATOR_KEYS_V2);
    const found = locators[0];
    expect([found.prohibition_line, found.class, found.target]).toEqual([1, 'edit', 'yes']);
    expect([found.boundary, found.boundary_line, found.candidate_count]).toEqual(['host', 2, 7]);
    expect(found.call_lines).toEqual([3, 4, 5, 6, 7]);
    expect(found.tools).toEqual(['Edit']);
  });

  it('v2 the digest is shared by copies on other lines and pins its formula', () => {
    // Copy B has one extra row before the same message, so the message sits on line 4 instead of line 3.
    // The digest uses the timestamp and the cleaned text, so both copies share it.
    const callRow = call(4, 'Edit', { file_path: '/srv/v2k.py' }, 'k1');
    const copyA = [user(1, 'Hello'), user(2, "Don't touch /srv/v2k.py"), host(3), callRow];
    const copyB = [user(1, 'Hello'), user(1, 'Go on'), user(2, "Don't touch /srv/v2k.py"), host(3), callRow];
    const other = [user(1, 'Hello'), user(2, "Don't touch /srv/v2m.py"), host(3), call(4, 'Edit', { file_path: '/srv/v2m.py' }, 'm1')];
    const { report, locators } = run('v2-digest', { 'p/copy-a.jsonl': copyA, 'p/copy-b.jsonl': copyB, 'p/other.jsonl': other }, { rule: 2 });
    expect(locators).toHaveLength(3);
    const byName = Object.fromEntries(locators.map((item) => [basename(item.file), item.history_group]));
    expect(byName['copy-a.jsonl']).toBe(byName['copy-b.jsonl']);
    expect(byName['copy-a.jsonl']).not.toBe(byName['other.jsonl']);
    const expected = createHash('sha256').update(`${ts(2)}\nDon't touch /srv/v2k.py`, 'utf8').digest('hex');
    expect(byName['copy-a.jsonl']).toBe(expected);
    expect(report.candidates.history_groups_with_candidate).toBe(2);
  });

  it('v2 the marker is absent from stdout, stderr, --out and --locators', () => {
    const rows = [
      user(1, `Don't touch \`/srv/${MARKER}.py\` ${MARKER}`),
      userBlocks(2, [`Ok<system-reminder id="${MARKER}">${MARKER}`]),
      user(3, `Do not delete ${MARKER}, you may now go ahead ${MARKER}`),
      host(4),
      call(5, 'Edit', { file_path: `/srv/${MARKER}.py` }, 'm1'),
      call(6, 'Bash', { command: `rm ${MARKER}` }, 'm2'),
    ];
    const { report, texts } = run('v2-marker', { 'p/v2g.jsonl': rows }, { rule: 2 });
    expect(report.candidates.total).toBe(1);
    expect(report.prohibitions.revoked_in_same_message).toBe(1);
    for (const text of texts) expect(text.includes(MARKER), 'marker found in output').toBe(false);
  });

  it('the default rule is 3 and rule 1 is marked in the report', () => {
    const rows = [user(1, "Don't touch /srv/v2n.py"), host(2), call(3, 'Edit', { file_path: '/srv/v2n.py' }, 'n1')];
    const { report } = run('v3-default', { 'p/v2h.jsonl': rows }, { rule: null });
    expect(report.rule_version).toBe(3);
    expect(report.candidates.total).toBe(1);
    const { report: reportV1 } = run('v2-rule-1', { 'p/v2i.jsonl': rows }, { rule: 1 });
    expect(reportV1.rule_version).toBe(1);
    expect(reportV1.removed_fragments).toBeNull();
    expect(reportV1.rule.startsWith('Offline count')).toBe(true);
    expect(reportV1.rule.includes('\nRULE v2\n')).toBe(false);
    expect(report.rule.includes('\nRULE v3\n')).toBe(true);
  });

  it('rule v1 does not know revocation', () => {
    const rows = [user(1, "Don't touch `/srv/v2g.py`, but you may now go ahead"), host(2), call(3, 'Edit', { file_path: '/srv/v2g.py' }, 'c1')];
    const { report } = run('v1-revoked', { 'p/v2j.jsonl': rows }, { rule: 1 });
    expect(report.candidates.total).toBe(1);
    expect(report.prohibitions.revoked_in_same_message).toBeNull();
  });

  it('v3 a question with a permission word and a negation before the phrase do not revoke', () => {
    const sessions: Record<string, Row[]> = {
      'p/v3-q.jsonl': [user(1, 'Whether you are allowed to check it? Hands off a.py'), host(2), call(3, 'Edit', { file_path: '/srv/v3/a.py' }, 'q1')],
      'p/v3-w.jsonl': [user(1, 'Never  now allowed to touch /srv/v3/b.py. Hands off b.py'), host(2), call(3, 'Edit', { file_path: '/srv/v3/b.py' }, 'w1')],
    };
    const { report, locators } = run('v3-no-revoke', sessions, { rule: 3, patterns: SYNTHETIC_PATTERNS });
    expect(report.rule_version).toBe(3);
    expect(report.prohibitions.revoked_in_same_message).toBe(0);
    expect(report.candidates.total).toBe(2);
    expect(locators).toHaveLength(2);
  });

  it('v3 explicit permission revokes; rule v2 keeps its own check', () => {
    const rows = [user(1, 'Hands off `/srv/v3/c.py`. Already allowed to touch a.py'), host(2), call(3, 'Edit', { file_path: '/srv/v3/c.py' }, 'r1')];
    const { report, locators } = run('v3-permission', { 'p/v3-r.jsonl': rows }, { rule: 3, patterns: SYNTHETIC_PATTERNS });
    expect(report.prohibitions.revoked_in_same_message).toBe(1);
    expect(report.candidates.total).toBe(0);
    expect(locators).toEqual([]);
    // Rule v2 is frozen: the same question sentence still revokes under --rule 2.
    const rowsQ = [user(1, 'Whether you are allowed to check it? Hands off a.py'), host(2), call(3, 'Edit', { file_path: '/srv/v3/a.py' }, 'q2')];
    const { report: reportV2 } = run('v2-question-revokes', { 'p/v3-q2.jsonl': rowsQ }, { rule: 2, patterns: SYNTHETIC_PATTERNS });
    expect(reportV2.prohibitions.revoked_in_same_message).toBe(1);
    expect(reportV2.candidates.total).toBe(0);
  });

  it('v3 a question sentence with a permission word does not revoke; labels are English', () => {
    const rows = [user(1, 'Hands off /srv/v3/d.py. Whether it is allowed to touch /srv/v3/d.py?'), host(2), call(3, 'Edit', { file_path: '/srv/v3/d.py' }, 'd1')];
    const { report } = run('v3-question-word', { 'p/v3-d.jsonl': rows }, { rule: 3, patterns: SYNTHETIC_PATTERNS });
    expect(report.prohibitions.revoked_in_same_message).toBe(0);
    expect(report.candidates.total).toBe(1);
    expect(report.results[0].name).toBe('candidates by boundary host');
  });

  it('v3 revocation unit cases with the synthetic wording', () => {
    const texts = [
      'Whether you are allowed to check it? Hands off a.py',
      'Never  now allowed to touch a.py',
      'Never already allowed to touch a.py',
      'Already allowed to touch a.py',
      'Allowed already to touch a.py',
      'Now allowed to touch a.py',
      'Clear to proceed',
      'Never clear to proceed',
      'Allowed to do it',
      'Ok, go on',
    ];
    const expected = [false, false, false, true, true, true, true, false, false, false];
    const call3 = '(module.set_patterns(argument["spec"]), [module.is_revoked(t, 3) for t in argument["texts"]])[1]';
    expect(pyEval(call3, { spec: SYNTHETIC_PATTERNS, texts })).toEqual(expected);
    // Rule v2 is unchanged on the question sentence.
    const call2 = '(module.set_patterns(argument["spec"]), module.is_revoked(argument["texts"][0], 2))[1]';
    expect(pyEval(call2, { spec: SYNTHETIC_PATTERNS, texts })).toBe(true);
  });

  it('v3 revocation unit cases with the default wording', () => {
    const texts = ['you may now edit it', 'You can now go on', 'go ahead', 'Do not go ahead', "Don't go ahead", 'Ok, go on'];
    expect(pyEval('[module.is_revoked(t, 3) for t in argument]', texts)).toEqual([true, true, true, false, false, false]);
  });

  it('v3 default wording: a question with a permission word keeps the prohibition, explicit consent lifts it', () => {
    const questions = [
      "Don't deploy. Can you go ahead with analysis?",
      "Don't deploy. Can you go ahead with analysis",
      "Don't deploy. Could we go ahead with the analysis first?",
      "Don't deploy. Is it ok to go ahead?",
      "Don't deploy. Should I go ahead with the plan?",
      "Don't deploy. May I go ahead?",
      "Don't deploy. Do you think you can go ahead and read the logs?",
      "Don't deploy. You can go ahead now, right?",
    ];
    const consents = ["Don't deploy yet. You may now deploy.", "Don't deploy yet. Go ahead.", "Don't deploy yet. You can now deploy it."];
    const lines = [...questions, ...consents];
    expect(pyEval('[module.is_revoked(t, 3) for t in argument]', lines)).toEqual([
      ...questions.map(() => false), ...consents.map(() => true),
    ]);
    const rowsFor = (text: string) => [user(1, text), host(2), call(3, 'Bash', { command: 'bash deploy.sh' }, 'q1')];
    const asked = run('v3-default-question', { 'p/v3-dq.jsonl': rowsFor(questions[0]) }, { rule: null });
    expect(asked.report.prohibitions.revoked_in_same_message).toBe(0);
    expect(asked.report.candidates.by_class).toEqual({ deploy: 1 });
    const consented = run('v3-default-consent', { 'p/v3-dc.jsonl': rowsFor("Don't deploy yet. You may now deploy.") }, { rule: null });
    expect(consented.report.prohibitions.revoked_in_same_message).toBe(1);
    expect(consented.report.candidates.total).toBe(0);
  });

  it('a --patterns file replaces the question lists as a whole', () => {
    const text = "Can you go ahead with analysis?";
    const call3 = (spec: unknown) => pyEval('(module.set_patterns(argument["spec"]), module.is_revoked(argument["text"], 3))[1]', { spec, text });
    expect(call3({})).toBe(false);
    expect(call3({ permission_words: [] })).toBe(true);
    expect(call3({ question_starts: [], permission_words: ['go\\s+ahead'] })).toBe(false); // the sentence still ends with "?"
    expect(call3({ permission_words: ['allowed'] })).toBe(true);
  });

  it('a default install prohibition gives a candidate for an install command after a compaction', () => {
    const install = (text: string, command: string) => [user(1, text), host(2), call(3, 'Bash', { command }, 'i1')];
    for (const [name, text] of [
      ['dont', "Don't install left-pad"], ['curly', 'Don’t install left-pad'], ['donot', 'Do not install left-pad'],
      ['never', 'Never install left-pad'], ['noing', 'No installing anything new'], ['nos', 'No installs today'],
    ]) {
      const { report } = run(`install-${name}`, { [`p/install-${name}.jsonl`]: install(text, 'npm install left-pad') }, { rule: null });
      expect(report.prohibitions.by_class, text).toEqual({ install: 1 });
      expect(report.candidates.by_class, text).toEqual({ install: 1 });
    }
    // With a target (backticks) the command must name it, under every rule.
    const named = run('install-target', { 'p/install-t.jsonl': install("Don't install `left-pad`", 'pnpm add left-pad') }, { rule: 1 });
    expect(named.report.candidates.by_class).toEqual({ install: 1 });
    const other = run('install-other', { 'p/install-o.jsonl': install("Don't install `left-pad`", 'npm install right-pad') }, { rule: 1 });
    expect(other.report.candidates.total).toBe(0);
    // Wording that is not a prohibition of installing stays out.
    const none = run('install-none', { 'p/install-n.jsonl': install('Please install left-pad', 'npm install left-pad') }, { rule: null });
    expect(none.report.prohibitions.total).toBe(0);
  });

  it('every class with a command or target rule has a default prohibition wording', () => {
    const classes = pyEval('sorted({klass for _pattern, klass in module.DEFAULT_PATTERNS["prohibitions"]})', null);
    const matched = pyEval('sorted(set(module.COMMAND_CLASSES) | set(module.TARGET_CLASSES))', null);
    for (const klass of matched) expect(classes, klass).toContain(klass);
  });

  it('stdout is pure JSON without --out; the summary line goes to stderr', () => {
    const root = join(WORK, 'stdout');
    writeJsonl(join(root, 'projects', 'p', 's1.jsonl'),
      [user(1, "Don't touch /srv/v3/e.py"), host(2), call(3, 'Edit', { file_path: '/srv/v3/e.py' }, 'e1')]);
    const proc = tool(['--projects', join(root, 'projects'), '--to', UNTIL, '--days', '7']);
    expect(proc.status, proc.stderr).toBe(0);
    const report = JSON.parse(proc.stdout);
    expect(report.candidates.total).toBe(1);
    expect(report.rule_version).toBe(3);
    expect(proc.stderr.startsWith('candidates: 1;')).toBe(true);
  });

  it('the read-only command classifier follows the first word and redirections', () => {
    const cases: Record<string, boolean> = {
      'ls -la': true, 'echo x > /srv/f': false, 'echo hi 2>/dev/null': true, 'echo hi 2>&1': true,
      'git -C /srv/r status': true, 'git commit -m x': false, 'sed -n 1p f': true, 'sed -i s/a/b/ f': false,
      'find . -name x': true, 'find . -delete': false, "awk '{print}' f": true, "awk '{print}' f > g": false,
      'FOO=1 sudo ls': true, "python3 -c 'print(1)'": false, 'tee out.txt': false,
      // Launch wrappers and their options of the table are skipped, also an option with a value (`sudo -u root`); an option outside
      // the table and `--` leave the wrapper as the first word, which is no read-only command.
      'sudo -u root cat f': true, 'sudo -E ls': true, 'sudo -n cat f': false, 'sudo -- cat f': false, 'nice -5 cat f': false, 'timeout --foreground 5 ls': false, 'nohup cat f': true, 'time -p ls': true, 'timeout 5 ls': true,
      'timeout -s KILL 5 ls': true, 'nice -n 5 cat f': true, 'env -i A=1 ls': true, 'env -u A cat f': true, 'command -p ls': true, 'exec -a x ls': true,
      'exec -a x tee f': false, 'sudo -u root rm x': false, 'sudo -u root git commit -m x': false, 'timeout 5 tee f': false, 'sudo': false, 'sudo -u root': false, 'nohup': false,
      // A compound command is judged by its first word (a documented limit).
      'git status && rm x': true,
    };
    const result = pyEval('{c: module.is_read_only_command(c) for c in argument}', Object.keys(cases));
    expect(result).toEqual(cases);
  });

  it('a redirection and its target are no command word: the command after leading redirections still counts, the words after a target do not open a command', () => {
    const operators = ['>f', '> f', '>>f', '2>f', '2> f', '2>&1', '2>&-', '&>f', '&>>f', '<f', '< f', '>|f', '>| f', '>&2', '<&3', '3<f',
      '{fd}>f', '<<<x', '<> f', '> "f x"', '>f\\ x'];
    const prefixes = ['', 'FOO=1 ', 'sudo ', 'env A=b ', 'time ', 'nohup ', 'command ', 'timeout 5 ', 'FOO=1 sudo ', 'xargs '];
    const forms: string[] = [];
    for (const redirect of operators) for (const prefix of prefixes) forms.push(`${prefix}${redirect} git commit -m x`);
    const found = pyEval('[module.command_matches("commit", c) for c in argument]', forms);
    forms.forEach((form, index) => expect(found[index], form).toBe(true));
    // The target and the words after it belong to the command before the redirection.
    const arguments_ = [
      'echo hi > git commit', 'echo hi >git commit', 'echo hi >> git commit', 'echo hi 2> git commit', 'echo hi &> git commit', 'echo hi >| git commit',
      'echo hi >& git commit', 'cat < git commit', 'cat <<< git commit', 'echo hi 2>&1 git commit', 'echo hi > f git commit',
      'FOO=1 echo hi > git commit', 'sudo echo hi > git commit', 'echo > out git commit', '> out echo git commit',
    ];
    const missing = pyEval('[module.command_matches("commit", c) for c in argument]', arguments_);
    arguments_.forEach((form, index) => expect(missing[index], form).toBe(false));
    // A boundary after the target opens a command again, and a process substitution is a command of its own.
    const opened = ['echo hi > f; git commit', 'echo hi > f && git commit', 'echo hi > f | git commit', 'echo hi > f\ngit commit',
      'echo hi > >(git commit)', 'diff <(git commit) b', 'echo hi > f & git commit'];
    const got = pyEval('[module.command_matches("commit", c) for c in argument]', opened);
    opened.forEach((form, index) => expect(got[index], form).toBe(true));
    // The other command classes read the same way.
    const classes = pyEval(
      '[[module.command_matches("push", c), module.command_matches("restart", c), module.has_delete(c), module.has_install(c), module.has_delete_or_move(c)] for c in argument]',
      ['> out git push', 'echo > git push', '2>&1 systemctl restart web', 'echo > systemctl restart web', '> out rm x', 'echo > rm x',
        '2>&1 npm install x', 'echo > npm install x', '< in sed -i s/a/b/ f', 'echo hi > sed -i s/a/b/ f'],
    );
    expect(classes).toEqual([
      [true, false, false, false, false], [false, false, false, false, false], [false, true, false, false, false], [false, false, false, false, false],
      [false, false, true, false, true], [false, false, false, false, false], [false, false, false, true, false], [false, false, false, false, false],
      [false, false, false, false, true], [false, false, false, false, false],
    ]);
  });

  it('the read-only command classifier skips leading redirections and sees the write forms of a redirection', () => {
    const cases: Record<string, boolean> = {
      '< in cat': true, '2>&1 ls': true, '2>/dev/null ls': true, '<in cat': true, '3< in cat': true, '> out ls': false, '>out ls': false,
      '>> out ls': false, '2> err ls': false, '&> out ls': false, '>| out ls': false, '>&out ls': false, 'ls >&out': false,
      'ls >&2': true, 'ls >&-': true, 'ls 2>&1': true, 'FOO=1 > out ls': false, 'FOO=1 < in cat': true, 'FOO=1 2>&1 sudo ls': true,
      '< in rm x': false, '2>&1 git status': true, '< in git commit': false, 'echo > git commit': false,
    };
    expect(pyEval('{c: module.is_read_only_command(c) for c in argument}', Object.keys(cases))).toEqual(cases);
  });

  it('the value of a leading assignment is one shell word: quoted, with an escaped space, empty or a command substitution', () => {
    const values = [
      'MODE="deep analysis"', "MODE='deep analysis'", 'MODE=deep\\ analysis', 'MODE=', 'A=$(date)', 'A=$(git rev-parse HEAD)', 'A=$(a b c)',
      'A=`date`', 'A=`a b`', 'A="$(a b)"', 'A=$(echo ")")', 'A=$(a $(b c))', 'A="x y"z', 'A=x"y z"', 'A=$(date)x', 'A+=y', 'A=b\\ c\\ d',
    ];
    const forms: string[] = [];
    for (const value of values) for (const prefix of ['', 'B=1 ', 'env C=2 ', '> out ', '2>&1 ', 'sudo ']) forms.push(`${prefix}${value} git commit -m x`);
    const found = pyEval('[module.command_matches("commit", c) for c in argument]', forms);
    forms.forEach((form, index) => expect(found[index], form).toBe(true));
    const readOnly = pyEval('[module.is_read_only_command(c) for c in argument]', values.map((value) => `${value} git status`));
    values.forEach((value, index) => expect(readOnly[index], `${value} git status`).toBe(true));
    const changing = pyEval('[module.is_read_only_command(c) for c in argument]', values.map((value) => `${value} rm x`));
    values.forEach((value, index) => expect(changing[index], `${value} rm x`).toBe(false));
    // A command substitution is one part of the word it stands in; its end opens no command word.
    const quiet = ['echo $(date) git commit', 'echo `date` git commit', 'echo x $(date) git commit', 'echo $(date)git commit',
      'echo $(a (b) c) git commit', 'echo $(echo ")") git commit'];
    const none = pyEval('[module.command_matches("commit", c) for c in argument]', quiet);
    quiet.forEach((form, index) => expect(none[index], form).toBe(false));
    // The body of a substitution is a command of its own, and a boundary after the substitution opens a command.
    const loud = ['echo $(git commit)', 'echo `git commit`', 'A=$(git commit) true', 'echo $(echo $(git commit))', 'echo $(date) && git commit',
      'echo $(date); git commit', 'echo "$(date)" && git commit', 'echo $(echo ")" ; git commit)',
      // An empty substitution expands to nothing, so the next word is the command.
      '$() git commit', '`` git commit', 'A=$() git commit'];
    const got = pyEval('[module.command_matches("commit", c) for c in argument]', loud);
    loud.forEach((form, index) => expect(got[index], form).toBe(true));
    expect(pyEval('[module.is_read_only_command(c) for c in argument]', ['$() ls', '`` git status', '$() rm x'])).toEqual([true, true, false]);
    // An open substitution runs to the end of the text and reads no further word.
    const open = pyEval('[module.command_matches("commit", c) for c in argument]', ['echo $(date git commit', 'echo `date git commit']);
    expect(open).toEqual([false, false]);
    // The substitution reading is linear: a long run of substitutions is read in one pass.
    const long = pyEval('module.command_matches("commit", argument)', 'echo ' + '$(a) '.repeat(20000) + 'git commit');
    expect(long).toBe(false);
  });

  it('git options: the value of -C, -c and the long options is not the subcommand, and the subcommand is a whole word', () => {
    const cases: Array<[string, string, boolean]> = [
      // An option value that reads like the subcommand, or a subcommand that only starts like it.
      ['commit', 'git -c commit.gpgSign=false status', false], ['commit', 'git -C commit status', false],
      ['commit', 'git --git-dir commit status', false], ['commit', 'git --work-tree commit status', false],
      ['commit', 'git --namespace commit status', false], ['commit', 'git --config-env commit.x=VAR status', false],
      ['commit', 'git --config-env commit status', false],
      ['commit', 'git --attr-source commit status', false], ['commit', 'git -c commit.x=y -C commit status', false],
      ['commit', 'git -c "commit x=y" status', false], ['commit', 'git commit-tree abc', false], ['commit', 'git commit.x', false],
      ['push', 'git -c push.default=simple status', false], ['merge', 'git -C merge status', false],
      // Git options that exit after printing do not run what follows.
      ['commit', 'git --exec-path commit', false], ['commit', 'git --html-path commit', false],
      ['commit', 'git --version commit', false], ['commit', 'git -h commit', false], ['commit', 'git --help commit', false],
      ['commit', 'git --list-cmds=main commit', false],
      // The subcommand after every kind of option, values with spaces, glued shell operators.
      ['commit', 'git -c core.x=y commit -m x', true], ['commit', 'git -C /r commit', true],
      ['commit', 'git --git-dir=/x commit', true], ['commit', 'git --git-dir /x commit', true],
      ['commit', 'git --work-tree=/w --git-dir=/x commit', true], ['commit', 'git --work-tree /w --namespace n commit', true],
      ['commit', 'git --config-env=core.x=VAR commit', true], ['commit', 'git --attr-source HEAD commit', true],
      ['commit', 'git --exec-path=/x commit', true], ['commit', 'git --no-pager -c a=b -C /r commit', true],
      ['commit', 'git -c user.name="A B" commit', true], ["commit", "git -c 'user.name=A B' commit", true],
      ['commit', 'git -C "/srv/my repo" commit', true], ['commit', 'git --work-tree="/a b" commit', true],
      ['push', 'git -C "/srv/my repo" -c "a b=c d" push origin', true],
      ['commit', 'bash -c "git commit -m x"', true], ['commit', "ssh host 'git -c a=b commit -m x'", true],
      ['commit', 'git commit;', true], ['commit', '(git commit)', true], ['commit', 'git commit&&git push', true],
      ['push', 'git commit&&git push', true], ['merge', 'git merge|cat', true], ['commit', 'git commit', true],
      ['commit', 'git -ccore.x=y commit', false], // not an option of git (it exits with "unknown option")
      ['commit', 'git -c "a commit', false], // an open quote runs to the end of the command
      ['commit', 'git -c "a" commit', true],
    ];
    const result = pyEval(
      '[module.call_matches(klass, [], "Bash", {"command": command}) for klass, command in argument]', cases.map(([k, c]) => [k, c]),
    );
    expect(result).toEqual(cases.map(([, , expected]) => expected));
  });

  it('read-only git commands keep their subcommand behind options with values', () => {
    const cases: Record<string, boolean> = {
      'git -c commit.gpgSign=false status': true, 'git -C commit status': true, 'git -C "/srv/my repo" status': true,
      'git --git-dir /x status': true, 'git --git-dir=/x status': true, 'git --work-tree /w log': true,
      'git --namespace n diff': true, 'git -c "a b=c" show': true, 'git --no-pager log': true,
      'git -C /srv/r commit -m x': false, 'git --git-dir /x commit': false, 'git -C "/a b" push': false,
    };
    expect(pyEval('{c: module.is_read_only_command(c) for c in argument}', Object.keys(cases))).toEqual(cases);
  });

  it('read-only git commands after a commit prohibition give no candidate; a real commit does', () => {
    const rows = [
      user(1, "Don't commit this yet"), host(2),
      call(3, 'Bash', { command: 'git -c commit.gpgSign=false status' }, 'c1'),
      call(4, 'Bash', { command: 'git -C commit status' }, 'c2'),
      call(5, 'Bash', { command: 'git --git-dir=/x commit -m x' }, 'c3'),
    ];
    const { report, locators } = run('git-values', { 'p/gv.jsonl': rows });
    expect(report.candidates.by_class).toEqual({ commit: 1 });
    expect(locators.map((item) => item.call_line)).toEqual([5]);
    const states = [
      user(1, 'Do not run anything'), host(2),
      call(3, 'Bash', { command: 'git -c commit.gpgSign=false status' }, 's1'),
      call(4, 'Bash', { command: 'git -C commit status' }, 's2'),
    ];
    expect(run('git-values-general', { 'p/gv2.jsonl': states }, { rule: 3 }).report.candidates.total).toBe(0);
  });

  it('a quoted or escaped > is text, not a redirection', () => {
    const cases: Record<string, boolean> = {
      // Text that only holds the character.
      "echo '>'": true, 'grep ">" README.md': true, 'echo ">>"': true, "echo '2> err'": true, 'echo "a \\" > b"': true,
      'echo a\\>b': true, 'echo "a > b" "c > d"': true, 'grep -n ">" a "b > c"': true, "echo '\"' '>'": true,
      // A comment is text too, but a # inside a word or after $ starts none.
      'ls # > x': true, 'echo hi\n# > x': true, 'echo "a" # > b': true,
      // Real redirections, quoted target included.
      'echo x > f': false, 'echo x >> f': false, 'cmd 2> err': false, 'cmd &> f': false, 'cmd &>> f': false, 'cmd >| f': false,
      'echo x > "f g"': false, "echo x >'f'": false, 'echo "a" > f': false, 'echo ">" > f': false, "echo '>' >> f": false,
      'echo x > >(tee f)': false, 'echo x > /dev/nullx': false, 'echo x > f # > g': false, 'echo a#b > f': false,
      'echo $# > f': false, 'echo ${#x} > f': false,
      // Not a write to a file, as before.
      'echo hi 2>&1': true, 'echo hi 2>/dev/null': true, 'echo x > /dev/null': true, 'echo x >> /dev/null': true,
      'echo x >>/dev/null': true, 'echo a >&2': true, 'cat <(ls)': true,
    };
    expect(pyEval('{c: module.is_read_only_command(c) for c in argument}', Object.keys(cases))).toEqual(cases);
  });

  it('commands that only print or search for > give no candidate under a general prohibition; a redirect does', () => {
    const rows = [
      user(1, 'Do not run anything'), host(2),
      call(3, 'Bash', { command: "echo '>'" }, 'q1'),
      call(4, 'Bash', { command: 'grep ">" README.md' }, 'q2'),
      call(5, 'Bash', { command: 'echo x > out.txt' }, 'q3'),
    ];
    for (const rule of [2, 3]) {
      const { report, locators } = run(`quoted-redirect-${rule}`, { 'p/qr.jsonl': rows }, { rule });
      expect(report.candidates.total, `rule ${rule}`).toBe(1);
      expect(report.candidates.by_class, `rule ${rule}`).toEqual({ run: 1 });
      expect(locators.flatMap((item) => item.call_lines ?? [item.call_line]), `rule ${rule}`).toEqual([5]);
    }
  });

  it('a command word counts only where the shell runs it, not in the arguments of another command', () => {
    const cases: Array<[string, string, boolean]> = [
      // The command name in quoted or plain text of another command runs nothing.
      ['commit', 'echo "git commit"', false], ['commit', "rg 'git commit' README.md", false], ['commit', 'echo git commit', false],
      ['commit', 'grep -n git commit.txt', false], ['push', 'echo "git push origin main"', false], ['merge', "echo 'git merge x'", false],
      ['commit', 'man git commit', false], ['commit', 'ls # git commit', false], ['commit', 'ls; # git commit; git commit', false],
      ['commit', 'cat > notes.sh <<EOF\ngit commit -m x\nEOF', false], ['commit', 'sh -c \'echo "git commit"\'', false],
      ['restart', 'echo "systemctl restart web"', false], ['restart', 'grep kill notes.txt', false], ['restart', 'echo kill', false],
      ['restart', 'docker run --rm img', false], ['restart', "rg 'docker stop' README.md", false],
      // The command word, first or after an operator, a newline, a group, a substitution or a here-document line.
      ['commit', 'git commit -m x', true], ['commit', 'cd /r && git commit -m x', true], ['commit', 'ls || git commit', true],
      ['commit', 'ls | git commit', true], ['commit', 'ls\ngit commit', true], ['commit', 'ls & git commit', true],
      ['commit', '(git commit)', true], ['commit', 'x=$(git commit -m y)', true], ['commit', 'echo `git commit`', true],
      ['commit', 'git commit -F - <<EOF\nmessage\nEOF', true], ['commit', 'cat <<EOF > f\nx\nEOF\ngit commit', true],
      ['commit', '/usr/bin/git commit', true], ['commit', 'if true; then git commit; fi', true],
      ['commit', 'for f in a; do git commit; done', true], ['commit', '{ git commit; }', true], ['commit', '! git commit', true],
      // After launch wrappers, assignments and positional words.
      ['commit', 'sudo git commit', true], ['commit', 'sudo -u root git commit', true], ['commit', 'doas git commit', true],
      ['commit', 'env FOO=1 git commit', true], ['commit', 'env -u FOO git commit', true], ['commit', 'FOO=1 git commit', true],
      ['commit', 'command git commit', true], ['commit', 'nohup git commit &', true], ['commit', 'exec git commit', true], ['commit', 'exec -a x git commit', true],
      ['commit', 'time git commit', true], ['commit', 'time -p git commit', true], ['commit', 'nice -n 5 git commit', true],
      ['push', 'timeout 30 git push origin main', true], ['push', 'timeout -s KILL 30 git push', true],
      ['commit', 'echo x | xargs git commit', true], ['commit', 'echo x | xargs -n 1 -I {} git commit -m {}', true],
      ['commit', 'sudo env FOO=1 nohup git commit', true], ['restart', 'sudo kill -9 12', true], ['restart', 'xargs kill', true],
      ['restart', "find . -name x -exec git commit -m y {} \\;", false], ['commit', "find . -exec git commit {} \\;", true],
      // A wrapper word alone, or a wrapper before another word, runs no git.
      ['commit', 'sudo', false], ['commit', 'timeout 5', false], ['commit', 'sudo echo git commit', false],
      ['commit', 'xargs echo git commit', false], ['commit', 'env FOO=git echo commit', false],
      // Nested strings: a shell or su with -c, and ssh (a prohibition covers a remote command too).
      ['commit', 'bash -c "git commit -m x"', true], ['commit', "sh -c 'git commit'", true], ['commit', "bash -lc 'cd /r && git commit'", true],
      ['commit', "sudo sh -c 'git commit'", true], ['commit', "su -c 'git commit' root", true], ['commit', "su root -c 'git commit'", true],
      ['commit', "ssh host 'git commit -m x'", true], ['commit', "ssh -p 22 -i key host 'cd /r && git commit'", true],
      ['commit', 'ssh host git commit', true], ['commit', "ssh -c aes128-ctr host 'git commit'", true], ['commit', 'ssh -c git host', false],
      ['commit', 'ssh host', false], ['restart', "ssh host 'systemctl restart web'", true], ['commit', "bash script.sh -c 'git commit'", false],
      ['commit', "echo bash -c 'git commit'", false], ['commit', 'sh -c "sh -c \\"git commit\\""', true],
      ['commit', 'sh -c "sh -c \\"sh -c \'git commit\'\\""', false], // a third level is not read
    ];
    const result = pyEval(
      '[module.call_matches(klass, [], "Bash", {"command": command}) for klass, command in argument]', cases.map(([k, c]) => [k, c]),
    );
    const wrong = cases.filter((item, index) => result[index] !== item[2]).map((item) => item[1]);
    expect(wrong).toEqual([]);
  });

  it('the other command classes read commands the same way: delete, install, deploy and the target rules', () => {
    const general: Array<[string, string, boolean]> = [
      ['delete', 'echo "rm x"', false], ['delete', 'grep rm notes.txt', false], ['delete', 'docker run --rm img', false],
      ['delete', 'echo find . -delete', false], ['delete', "rg 'git rm' README.md", false],
      ['delete', 'rm -rf build', true], ['delete', 'ls && rmdir d', true], ['delete', 'sudo unlink f', true], ['delete', 'find . -name x -delete', true],
      ['delete', 'git rm f', true], ['delete', 'git -C /r rm f', true], ['delete', "find . -exec rm {} \\;", true], ['delete', 'xargs shred', true],
      ['delete', "bash -c 'rm x'", true],
      ['install', 'echo "npm install x"', false], ['install', "grep 'npm install' README.md", false], ['install', 'cat pip install.txt', false],
      ['install', 'npm install left-pad', true], ['install', 'npm i x', true], ['install', 'cd app && pnpm add x', true], ['install', 'sudo apt-get install x', true],
      ['install', 'pip3 install x', true], ['install', 'python -m pip install x', true], ['install', 'python3.12 -m pip install x', true],
      ['install', 'uv pip install x', true], ['install', 'yarn add x', true], ['install', 'cargo install x', true], ['install', 'brew install x', true],
      ['install', 'go install x', true], ['install', "ssh host 'npm ci'", true], ['install', 'npm run install-docs', false],
      ['deploy', 'grep deploy README.md', false], ['deploy', 'echo deploy', false], ['deploy', 'cat deploy.sh', false],
      ['deploy', 'git log --grep deploy', false], ['deploy', "echo 'kubectl apply'", false], ['deploy', 'rg "docker compose up" docs', false],
      ['deploy', 'npm run deploy', true], ['deploy', 'make deploy', true], ['deploy', './deploy.sh', true], ['deploy', 'bash deploy.sh', true],
      ['deploy', 'kubectl apply -f x.yaml', true], ['deploy', 'systemctl start web', true], ['deploy', 'systemctl enable web', true],
      ['deploy', 'docker compose up -d', true], ['deploy', 'docker up', true], ['deploy', 'sudo systemctl start web', true],
    ];
    const result = pyEval(
      '[module.call_matches_v2(klass, [], "Bash", {"command": command}) for klass, command in argument]', general.map(([k, c]) => [k, c]),
    );
    expect(general.filter((item, index) => result[index] !== item[2]).map((item) => item[1])).toEqual([]);
    // With targets, a Bash command still has to name the target, and now also run rm, mv or sed -i.
    const targeted: Array<[string, string, boolean]> = [
      ['delete', 'rm src/a.py', true], ['edit', 'mv src/a.py src/b.py', true], ['edit', 'sed -i s/a/b/ src/a.py', true],
      ['delete', 'sudo rm src/a.py', true], ['edit', "find . -exec mv src/a.py x \\;", true], ['edit', 'cd x && sed -i.bak s/a/b/ src/a.py', true],
      ['delete', 'grep mv src/a.py', false], ['edit', "rg 'sed -i' src/a.py", false], ['delete', 'echo rm src/a.py', false],
      ['edit', 'echo "mv a b" src/a.py', false], ['delete', 'ls src/a.py', false], ['edit', 'rm', false], ['edit', 'sed -n 1p src/a.py', false],
      ['run', 'cat src/a.py', true], ['install', 'echo src/a.py', true],
    ];
    const hit = pyEval(
      '[module.call_matches(klass, ["src/a.py"], "Bash", {"command": command}) for klass, command in argument]', targeted.map(([k, c]) => [k, c]),
    );
    expect(targeted.filter((item, index) => hit[index] !== item[2]).map((item) => item[1])).toEqual([]);
  });

  it('commands that only mention a command name give no candidate; a real command does', () => {
    const calls = [
      'echo "git commit"', "rg 'git commit' README.md", 'echo git push', 'grep -n kill log.txt', "echo 'rm -rf x'", 'echo "npm install x"',
      'git commit -m x', 'timeout 30 git push origin main', 'sudo systemctl restart web', 'cd app && npm install x', 'rm -rf build',
    ];
    const rows = (text: string) => [user(1, text), host(2), ...calls.map((command, index) => call(3 + index, 'Bash', { command }, `m${index}`))];
    const lines = (name: string, text: string, rule: number) =>
      run(name, { [`p/${name}.jsonl`]: rows(text) }, { rule }).locators.flatMap((item) => item.call_lines ?? [item.call_line]);
    // Rule 1 and 3 by command class: the call lines are 3 + the index in `calls`.
    expect(lines('mention-commit', "Don't commit anything", 1)).toEqual([9]);
    expect(lines('mention-push', "Don't push anything", 1)).toEqual([10]);
    expect(lines('mention-restart', "Don't restart anything", 3)).toEqual([11]);
    expect(lines('mention-install', "Don't install anything", 3)).toEqual([12]);
    expect(lines('mention-delete', "Don't delete anything", 3)).toEqual([13]);
  });

  it('shell words and here-documents: quotes, comments and bodies', () => {
    const words = pyEval('[module.shell_words(text) for text in argument]', [
      'git commit -m "a b"', "echo 'x y' z\\ w", 'a;b|c&&d', 'ls # c\nnpm test', 'echo a#b $# ${#x}', 'cat <<EOF > f\nx\nEOF', 'echo x 2>&1',
      '(a) `b`', 'x=$(c d)', 'echo ""', 'a \\\nb', "echo '",
      '> out tee f', 'echo hi > out more', '2>&1 git commit', '{fd}>f cmd', 'echo x >| f y', 'echo x &>f y', 'cat <(a) b', 'a > >(b)', 'echo >', 'echo > ; ls',
      'cat <<< "a b" c', 'echo a>b c', 'echo 12 > f',
    ]);
    expect(words).toEqual([
      ['git', 'commit', '-m', 'a b'], ['echo', 'x y', 'z w'], ['a', null, 'b', null, 'c', null, 'd'], ['ls', null, 'npm', 'test'],
      ['echo', 'a#b', '$#', '${#x}'], ['cat', null, 'x', null, 'EOF'], ['echo', 'x'],
      [null, 'a', null, 'b', null], ['x=$', null, 'c', 'd', null], ['echo', ''], ['a', 'b'], ['echo', ''],
      // A redirection and its target are dropped and end no command; a process substitution is a command of its own.
      ['tee', 'f'], ['echo', 'hi', 'more'], ['git', 'commit'], ['cmd'], ['echo', 'x', 'y'], ['echo', 'x', 'y'],
      ['cat', null, 'a', null, 'b'], ['a', null, 'b', null], ['echo'], ['echo', null, 'ls'], ['cat', 'c'], ['echo', 'a', 'c'], ['echo', '12'],
    ]);
    // A here-document body is cut and its operator line stays; a here-string and an operator with no terminator line are left alone.
    const cut = pyEval('[module.without_heredoc_bodies(text) for text in argument]', [
      'cat <<EOF > f\nbody\nEOF\nnext', 'cat <<-EOF\n\tx\n\tEOF', 'cat <<A; cat <<B\nx\nA\ny\nB\nz', 'cat <<< x', 'echo $((1<<3))', 'cat <<EOF\nno end',
    ]);
    expect(cut).toEqual(['cat << EOF  > f\nnext', 'cat << EOF ', 'cat << A ; cat << B \nz', 'cat <<< x', 'echo $((1<<3))', 'cat <<EOF\nno end']);
  });

  it('shell reading is linear in the length of the command and keeps its result', () => {
    const expression = `{
      "t0": __import__("time").perf_counter(),
      "answers": [
        module.call_matches("commit", [], "Bash", {"command": command})
        for command in [
          "sudo " * 20000 + "git commit",
          "xargs -n 1 " * 8000 + "git commit",
          "timeout 5 " * 8000 + "git commit",
          "FOO=1 " * 8000 + "git commit",
          "env -u X " * 8000 + "git commit",
          "if " * 20000 + "git commit",
          "find -exec " * 8000 + "git commit ;",
          "# " * 20000 + "\\ngit commit",
          chr(96) * 40000 + "git commit",
          "a;" * 20000 + "git commit",
          "(" * 40000 + "git commit",
          "echo " + "'a b' " * 8000 + "git commit",
          "echo " + '"a b" ' * 8000 + "; git commit",
          "cat <<EOF\\n" * 4000 + "git commit",
          "".join("cat <<t%d\\nx\\nt%d\\n" % (n, n) for n in range(3000)) + "git commit",
          "env " * 8000 + "bash -c 'git commit'",
          "bash -c '" + "x; " * 13000 + "git commit'",
          "ssh h " * 8000 + "git commit",
          "ssh " + "-p 1 " * 8000 + "h git commit",
          "\\\\" * 40000 + "git commit",
          '"' * 40001 + "git commit",
          "> out " * 8000 + "git commit",
          "2>&1 " * 20000 + "git commit",
          "FOO=1 > a " * 8000 + "git commit",
          "echo " + "> f " * 8000 + "git commit",
        ]
      ],
      "general": [
        module.call_matches_v2(klass, [], "Bash", {"command": command})
        for klass, command in [("deploy", "echo " * 20000 + "deploy"), ("deploy", "npm run " * 8000 + "deploy"), ("install", "echo " * 20000 + "npm install x"),
                               ("delete", "xargs " * 20000 + "rm x"), ("restart", "sudo " * 20000 + "kill 1"), ("delete", "find " * 8000 + "-delete"),
                               ("install", "npm " * 20000 + "install x")]
      ],
      "t1": __import__("time").perf_counter(),
    }`;
    const result = pyEval(expression, null);
    expect(result.t1 - result.t0).toBeLessThan(4);
    // Wrappers, assignments, reserved words, unquoted separators and a nested string reach the command; words among the
    // arguments of echo, a third level of ssh, a glued run of backslashes and an open quote do not make one.
    expect(result.answers).toEqual([
      true, true, true, true, true, true, true, true, true, true, true, false, true, true, true, true, true, false, true, false, false,
      true, true, true, false,
    ]);
    expect(result.general).toEqual([false, true, false, true, true, true, false]);
  });

  it('long runs of git options and of find words match in linear time and keep their result', () => {
    const expression = `{
      "t0": __import__("time").perf_counter(),
      "answers": [
        module.call_matches(klass, [], "Bash", {"command": command})
        for klass, command in [
          ("commit", "git " + "--a " * 40 + "commit"),
          ("commit", "git " + "--a " * 40 + "x"),
          ("push", "git " + "-ab " * 40 + "x"),
          ("commit", "git " + "-c " * 40 + "x"),
          ("merge", "git " + "-C " * 40 + "x"),
          ("commit", "git " + "-c k=v " * 20 + "commit"),
          ("push", "git -C /srv/r -c a=b --no-pager push origin"),
          ("commit", "git -C commit"),
          ("commit", "git -c git " * 8000),
          ("commit", 'git -c "a ' * 8000 + "commit"),
          ("commit", "git -c 'a " * 8000 + "x' commit"),
          ("commit", "git --work-tree=\\"/a " * 8000 + "commit"),
          ("commit", "git -C " * 20000 + "commit"),
          ("commit", "git " + '"' * 40000 + " commit"),
          ("commit", "git " + "\\\\" * 40000 + " commit"),
        ]
      ],
      "redirects": [
        module.is_read_only_command(command)
        for command in ["echo " + "'" * 40000, "echo " + '"' * 40000, "echo " + "\\\\" * 40000, "echo " + '"a ' * 8000,
                        "echo " + '\\\\"' * 20000, "echo '" + "a " * 20000, ">" * 40000, "> " * 20000, "echo " + "'>' " * 10000, "echo " + " #" * 20000]
      ],
      "delete": [
        module.call_matches_v2("delete", [], "Bash", {"command": command})
        for command in ["find " * 8000, "find " * 40000, "find\\n" * 8000, "find . -name x -delete", "find x\\n-delete", "find x\\ny\\n-delete"]
      ],
      "t1": __import__("time").perf_counter(),
    }`;
    const result = pyEval(expression, null);
    // The earlier patterns needed minutes for these inputs; the bound is generous so a loaded host stays green.
    // The clock runs inside the interpreter, so its start-up and the compile of the module are not timed.
    expect(result.t1 - result.t0).toBeLessThan(2);
    // The quoted-value runs (9 to 11) hold paired quotes: only the first `git` is a command, and its subcommand is the
    // next `git` word after the first value (the later `git` words are arguments, as in the shell), so none is a commit.
    // `git -C commit` has no subcommand: "commit" is the value of -C (the earlier pattern read it as the subcommand).
    expect(result.answers).toEqual([true, false, false, false, false, true, true, false, false, false, false, false, false, false, false]);
    expect(result.redirects).toEqual([true, true, true, true, true, true, false, false, true, true]);
    // A new line starts a new command, so `-delete` on the line after `find x` is no find option.
    expect(result.delete).toEqual([false, false, false, true, false, false]);
  });
});
