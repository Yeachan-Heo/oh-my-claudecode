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
      // A compound command is judged by its first word (a documented limit).
      'git status && rm x': true,
    };
    const result = pyEval('{c: module.is_read_only_command(c) for c in argument}', Object.keys(cases));
    expect(result).toEqual(cases);
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
        ]
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
    expect(result.answers).toEqual([true, false, false, false, false, true, true, true, false]);
    expect(result.delete).toEqual([false, false, false, true, true, false]);
  });
});
