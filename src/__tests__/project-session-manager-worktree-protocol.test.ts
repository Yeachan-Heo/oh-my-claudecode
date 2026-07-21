import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKTREE_LIB_PATH = join(process.cwd(), 'skills', 'project-session-manager', 'lib', 'worktree.sh');
const PSM_PATH = join(process.cwd(), 'skills', 'project-session-manager', 'psm.sh');
const REAL_GIT = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf-8' }).trim();

function commandExit(script: string, env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  try {
    execFileSync('bash', ['-c', script], { env, encoding: 'utf-8', stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (error: unknown) {
    const processError = error as { status?: number; stderr?: Buffer | string };
    return { status: processError.status ?? 1, stderr: String(processError.stderr ?? '') };
  }
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not find closing brace for ${name}`);
}

describe('project-session-manager worktree result protocol', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it.each([
    { creator: 'psm_create_pr_worktree', args: ['demo', '42', 'head'], fields: 2, branch: 'psm-pr-42-review' },
    { creator: 'psm_create_issue_worktree', args: ['demo', '42', 'demo-fix', 'main'], fields: 3 },
    { creator: 'psm_create_feature_worktree', args: ['demo', 'Demo Feature', 'main'], fields: 3 },
  ])('keeps $creator stdout isolated from git output', ({ creator, args, fields, branch }) => {
    const root = mkdtempSync(join(tmpdir(), 'omc-psm-protocol-'));
    tempDirs.push(root);
    const repo = join(root, 'repo');
    const worktreeRoot = join(root, 'worktrees');
    const shimDir = join(root, 'shim');
    mkdirSync(repo, { recursive: true });
    mkdirSync(shimDir, { recursive: true });

    execFileSync(REAL_GIT, ['init', '-b', 'main'], { cwd: repo });
    execFileSync(REAL_GIT, ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync(REAL_GIT, ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'test\n');
    execFileSync(REAL_GIT, ['add', 'README.md'], { cwd: repo });
    execFileSync(REAL_GIT, ['commit', '-m', 'initial'], { cwd: repo });
    execFileSync(REAL_GIT, ['branch', 'origin/main'], { cwd: repo });
    if (branch) execFileSync(REAL_GIT, ['branch', branch], { cwd: repo });

    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/usr/bin/env bash
if [[ "$1" == "worktree" && "$2" == "add" ]]; then
  echo PSM_GIT_WORKTREE_STDOUT_SENTINEL
  exec "$REAL_GIT" "$@"
fi
if [[ "$1" == "fetch" ]]; then
  exit 0
fi
exec "$REAL_GIT" "$@"
`);
    chmodSync(shim, 0o755);

    // RED before the patch: the sentinel was captured before the protocol line; green after it.
    const stdout = execFileSync(
      'bash',
      ['-c', 'source "$SCRIPT_PATH"; psm_get_worktree_root() { printf "%s" "$WORKTREE_ROOT"; }; psm_sanitize() { echo "$1" | tr "[:upper:]" "[:lower:]" | sed "s/[^a-z0-9-]/-/g" | sed "s/--*/-/g" | head -c 30; }; "$CREATOR" "$REPO" "$@"', 'protocol', ...args],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          SCRIPT_PATH: WORKTREE_LIB_PATH,
          WORKTREE_ROOT: worktreeRoot,
          CREATOR: creator,
          REPO: repo,
          REAL_GIT,
          PATH: `${shimDir}:${process.env.PATH}`,
        },
      },
    );
    const record = stdout.trimEnd();
    expect(record).not.toContain('\n');
    expect(record).not.toContain('PSM_GIT_WORKTREE_STDOUT_SENTINEL');
    const resultFields = record.split('|');
    expect(resultFields).toHaveLength(fields);
    expect(resultFields[0]).toBe('created');
    expect(resultFields[1]).not.toBe('');
    if (fields === 3) expect(resultFields[2]).not.toBe('');
  });

  it.each([
    { raw: 'noise\ncreated|/tmp/wt', schema: 'pr', valid: false },
    { raw: 'noise\ncreated|/tmp/wt|feature/x', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt\nnoise', schema: 'pr', valid: false },
    { raw: '', schema: 'pr', valid: false },
    { raw: 'weird|/tmp/wt', schema: 'pr', valid: false },
    { raw: 'created|', schema: 'pr', valid: false },
    { raw: 'created||feature/x', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt|extra', schema: 'pr', valid: false },
    { raw: 'created|/tmp/wt', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt|', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt|feature/x|extra', schema: 'branched', valid: false },
    { raw: 'error|msg|extra', schema: 'pr', valid: false },
    { raw: 'created|/tmp/wt', schema: 'pr', valid: true },
    { raw: 'exists|/tmp/wt', schema: 'pr', valid: true },
    { raw: 'created|/tmp/wt|feature/x', schema: 'branched', valid: true },
    { raw: 'exists|/tmp/wt|feature/x', schema: 'branched', valid: true },
    { raw: 'error|Failed to create worktree', schema: 'pr', valid: true },
    { raw: 'error|Failed to create worktree', schema: 'branched', valid: true },
    { raw: 'created|   ', schema: 'pr', valid: false },
    { raw: 'created|   |feature/x', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt|   ', schema: 'branched', valid: false },
    { raw: 'created|/tmp/wt|', schema: 'pr', valid: false },
    { raw: 'error|   ', schema: 'pr', valid: false },
    { raw: 'created|/tmp/wt', schema: 'weird', valid: false },
  ])('validates raw protocol records ($schema, $raw)', ({ raw, schema, valid }) => {
    const result = commandExit('source "$PSM"; psm_validate_worktree_result "$ARG" "$SCHEMA"', {
      ...process.env,
      PSM: PSM_PATH,
      ARG: raw,
      SCHEMA: schema,
    });
    expect(result.status === 0).toBe(valid);
  });

  it.each([
    { result: 'exists|/tmp/wt|feature/demo', creatorRc: '1', status: 0, malformed: false },
    { result: 'error|Failed to create worktree', creatorRc: '1', status: 1, malformed: false },
    { result: 'HEAD is now at abc\ncreated|/tmp/wt|feature/demo', creatorRc: '3', status: 1, malformed: true },
  ])('handles cmd_feature creator results under errexit', ({ result, creatorRc, status, malformed }) => {
    const root = mkdtempSync(join(tmpdir(), 'omc-psm-feature-'));
    tempDirs.push(root);
    const repo = join(root, 'repo');
    const markers = join(root, 'markers');
    mkdirSync(repo, { recursive: true });
    mkdirSync(markers, { recursive: true });

    const execution = commandExit(`
source "$PSM"
psm_get_project() { printf 'repo|%s|main' "$REPO"; }
psm_create_feature_worktree() { printf '%s' "$RESULT"; return "$CREATOR_RC"; }
psm_create_tmux_session() { touch "$MARKERS/tmux"; }
psm_launch_claude() { touch "$MARKERS/claude"; }
psm_add_session() { touch "$MARKERS/session"; }
cmd_feature demo 'Demo Feature'
`, {
      ...process.env,
      PSM: PSM_PATH,
      REPO: repo,
      MARKERS: markers,
      RESULT: result,
      CREATOR_RC: creatorRc,
    });
    expect(execution.status).toBe(status);
    expect(readdirSync(markers)).toEqual([]);
    if (malformed) expect(execution.stderr).toContain('Malformed worktree result');
  });

  it('captures safely and validates before side effects in every consumer', () => {
    const source = readFileSync(PSM_PATH, 'utf-8');
    const cases = [
      {
        name: 'cmd_review', creator: 'psm_create_pr_worktree',
        sideEffects: ['psm_render_template', 'psm_create_tmux_session', 'psm_launch_claude', 'psm_add_session', 'context_file'],
      },
      {
        name: 'cmd_fix', creator: 'psm_create_issue_worktree',
        sideEffects: ['psm_render_template', 'psm_create_tmux_session', 'psm_launch_claude', 'psm_add_session', 'fix_context_file'],
      },
      {
        name: 'cmd_feature', creator: 'psm_create_feature_worktree',
        sideEffects: ['psm_create_tmux_session', 'psm_launch_claude', 'psm_add_session'],
      },
    ];

    for (const entry of cases) {
      const body = functionBody(source, entry.name);
      const capture = `worktree_result=$(%s`.replace('%s', entry.creator);
      const captureOffset = body.indexOf(capture);
      expect(captureOffset).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(capture, captureOffset + 1)).toBe(-1);
      const captureLineEnd = body.indexOf('\n', captureOffset);
      expect(body.slice(captureOffset, captureLineEnd)).toContain('|| worktree_rc=');

      const readOffset = body.indexOf("IFS='|' read -r", captureOffset);
      expect(readOffset).toBeGreaterThan(captureOffset);
      const validator = 'psm_validate_worktree_result "$worktree_result"';
      const validatorOffset = body.indexOf(validator, readOffset);
      expect(validatorOffset).toBeGreaterThan(readOffset);
      expect(body.slice(readOffset, validatorOffset)).toMatch(/^IFS='\|' read -r[^\n]*<<< "\$worktree_result"\n\s*if ! \s*$/);
      expect(body.slice(readOffset)).toMatch(/^IFS='\|' read -r[^\n]*<<< "\$worktree_result"\n\s*if ! psm_validate_worktree_result "\$worktree_result" (?:pr|branched); then\n\s*return 1\n\s*fi\n/);

      for (const sideEffect of entry.sideEffects) {
        expect(body.indexOf(sideEffect)).toBeGreaterThan(validatorOffset);
      }
    }
  });
});
