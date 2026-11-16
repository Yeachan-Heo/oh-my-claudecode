import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO, 'tools', 'maintenance', 'compaction_review.mjs');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'compaction-review-test-')));
const logDir = join(root, 'jev');
const projects = join(root, 'projects');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const userResult = (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });
const apiError = (ts: string, text: string) => ({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } });
const plain = (ts: string) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'ok' }] } });

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const BOUNDARY = '2026-02-01T10:00:00.000Z';

beforeAll(() => {
  mkdirSync(logDir, { recursive: true });
  // Session A: the agent "rec" has a record, the agent "other" has none, the main session has none.
  const log = [
    { ts: BOUNDARY, event: 'compact', session_id: SESSION_A, agent_id: 'rec', kept_thinking: 2, result: 'summary', module_rev: 'abcdef0123456789' },
    { ts: '2026-02-01T10:05:00.000Z', event: 'compact', session_id: SESSION_A, agent_id: 'rec', kept_thinking: 0, result: 'summary' }, // kept_thinking 0: not a record
    { ts: '2025-12-01T10:00:00.000Z', event: 'compact', session_id: SESSION_B, agent_id: null, kept_thinking: 1, result: 'summary' }, // before --from
    { ts: '2026-02-02T10:00:00.000Z', event: 'other', session_id: SESSION_B, agent_id: null, kept_thinking: 1 },
    { ts: '2026-02-03T10:00:00.000Z', event: 'compact', session_id: SESSION_B, agent_id: 'gone', kept_thinking: 1, result: 'fallback' }, // no transcript file
  ];
  writeFileSync(join(logDir, 'compaction.jsonl'), lines(log) + 'not json\n');
  const proj = join(projects, 'proj');
  mkdirSync(join(proj, SESSION_A, 'subagents'), { recursive: true });
  mkdirSync(join(proj, SESSION_B), { recursive: true });
  writeFileSync(join(proj, `${SESSION_A}.jsonl`), lines([plain('2026-02-01T09:00:00.000Z'), apiError('2026-02-01T11:00:00.000Z', 'API Error: 400 invalid thinking block')]));
  writeFileSync(join(proj, SESSION_A, 'subagents', 'agent-rec.jsonl'), lines([
    userResult('2026-02-01T09:30:00.000Z', '[Tool result missing before]'),
    plain('2026-02-01T09:59:00.000Z'),
    plain('2026-02-01T10:01:00.000Z'),
    userResult('2026-02-01T10:02:00.000Z', '[Tool result missing after]'),
    { type: 'api-request-blob', message: { content: [{ type: 'tool_result', content: '[Tool result missing in a blob]' }] } },
    { type: 'attachment', timestamp: '2026-02-01T10:03:00.000Z' },
    { timestamp: undefined, type: 'assistant' },
  ]));
  writeFileSync(join(proj, SESSION_A, 'subagents', 'agent-other.jsonl'), lines([
    plain('2026-02-01T09:00:00.000Z'),
    { type: 'assistant', timestamp: '2026-02-01T12:00:00.000Z', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 overloaded' }] } },
  ]));
});

function run(args: string[], env: Record<string, string> = {}, cwd: string = root) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { ...process.env, HOME: root, OMC_JEV_LOG_DIR: '', CLAUDE_CONFIG_DIR: '', ...env } });
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}
const base = ['--from', '2026-01-01T00:00:00Z', '--log', join(logDir, 'compaction.jsonl'), '--projects', projects];

describe('compaction_review.mjs', () => {
  it('counts rows, errors and placeholder results on both sides of the boundary and splits the files by role', () => {
    const r = run([...base, '--json']);
    expect(r.status, r.out).toBe(1);
    const json = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{'))!);
    expect(json.records).toBe(2);
    expect(json.records_by_result).toEqual({ summary: 1, fallback: 1 });
    expect(json.missing_file).toEqual([{ session: 'bbbbbbbb', agent: 'gone', ts: '2026-02-03T10:00:00.000Z' }]);
    const byRole = (role: string) => json.files.filter((f: { role: string }) => f.role === role);
    const rec = byRole('agent with a record')[0];
    expect(rec.records).toBe(1);
    expect(rec.before).toMatchObject({ rows: 2, placeholders: 1, api_errors: 0 });
    expect(rec.after).toMatchObject({ rows: 2, placeholders: 1, api_errors: 0 });
    expect(rec.placeholders_in_blobs).toBe(1);
    expect(rec.record_results).toEqual(['summary']);
    const main = byRole('main session (records of agents only)')[0];
    expect(main.after).toMatchObject({ rows: 1, api_errors: 1, errors_400: 1, errors_400_thinking_invalid: 1 });
    const other = byRole('other agent of the session')[0];
    expect(other.after).toMatchObject({ rows: 1, api_errors: 1, errors_400: 0 });
    expect(other.before.rows).toBe(1);
    // the partition of the sums: one file with a record, two other files of the session
    expect(json.sums.files_with_a_record.files).toBe(1);
    expect(json.sums.other_files_of_the_sessions.files).toBe(2);
    expect(json.sums.total.files).toBe(3);
    expect(json.sums.total.after.errors_400).toBe(1);
    expect(json.sums.total.after.placeholders).toBe(1);
    expect(r.stdout).toContain('RESULT: 1 errors 400 and 1 placeholder results after the boundaries');
  });

  it('prints only files with a record or an error after the boundary unless --full is given', () => {
    const r = run(base);
    expect(r.out).toContain('- agent with a record: session aaaaaaaa agent rec');
    expect(r.out).toContain('NO FILE: session bbbbbbbb agent gone');
    const full = run([...base, '--full']);
    expect(full.out).not.toContain('skipped');
  });

  it('exits 0 with a clean result when a later window has no errors after the boundary', () => {
    const clean = join(root, 'clean');
    mkdirSync(join(clean, 'p'), { recursive: true });
    writeFileSync(join(clean, 'log.jsonl'), lines([{ ts: '2026-03-01T10:00:00.000Z', event: 'compact', session_id: 'cccccccc', agent_id: null, kept_thinking: 1, result: 'summary' }]));
    writeFileSync(join(clean, 'p', 'cccccccc.jsonl'), lines([plain('2026-03-01T10:01:00.000Z')]));
    const r = run(['--from', '2026-01-01T00:00:00Z', '--log', join(clean, 'log.jsonl'), '--projects', clean]);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain('RESULT: 0 errors 400 and 0 placeholder results');
  });

  it('--from is required and must be a time', () => {
    const missing = run(['--log', join(logDir, 'compaction.jsonl'), '--projects', projects]);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('--from is required');
    expect(run(['--from', 'yesterday-ish', '--log', join(logDir, 'compaction.jsonl'), '--projects', projects]).status).toBe(2);
  });

  it('defaults the journal to compaction.jsonl in OMC_JEV_LOG_DIR and the transcripts to CLAUDE_CONFIG_DIR/projects', () => {
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    mkdirSync(join(configDir, 'projects'));
    const r = run(['--from', '2026-01-01T00:00:00Z'], { OMC_JEV_LOG_DIR: logDir, CLAUDE_CONFIG_DIR: configDir });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`journal: ${join(logDir, 'compaction.jsonl')}`);
    expect(r.stdout).toContain('records: 2');
    expect(r.stdout).toContain('transcript files: 0');
  });

  it('without OMC_JEV_LOG_DIR defaults the journal to .omc/state/jev/compaction.jsonl under the current directory', () => {
    const cwd = join(root, 'cwd-default');
    const emptyProjects = join(root, 'cwd-default-projects');
    mkdirSync(emptyProjects);
    const projectLogDir = join(cwd, '.omc', 'state', 'jev');
    mkdirSync(projectLogDir, { recursive: true });
    copyFileSync(join(logDir, 'compaction.jsonl'), join(projectLogDir, 'compaction.jsonl'));
    const r = run(['--from', '2026-01-01T00:00:00Z', '--projects', emptyProjects], {}, cwd);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`journal: ${join(projectLogDir, 'compaction.jsonl')}`);
    expect(r.stdout).toContain('records: 2');
  });

  it('OMC_JEV_LOG_DIR wins over .omc/state/jev under the current directory', () => {
    const cwd = join(root, 'cwd-env-wins');
    const emptyProjects = join(root, 'cwd-env-wins-projects');
    mkdirSync(emptyProjects);
    mkdirSync(join(cwd, '.omc', 'state', 'jev'), { recursive: true });
    const r = run(['--from', '2026-01-01T00:00:00Z', '--projects', emptyProjects], { OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`journal: ${join(logDir, 'compaction.jsonl')}`);
  });

  it('input errors exit 2: missing journal, missing transcripts directory, unknown option, missing value', () => {
    expect(run(['--from', '2026-01-01', '--log', join(root, 'none.jsonl'), '--projects', projects]).status).toBe(2);
    expect(run(['--from', '2026-01-01', '--log', join(logDir, 'compaction.jsonl'), '--projects', join(root, 'none')]).status).toBe(2);
    expect(run([...base, '--bogus']).status).toBe(2);
    expect(run([...base, '--log']).status).toBe(2);
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('OMC_STATE_DIR');
  });
});
