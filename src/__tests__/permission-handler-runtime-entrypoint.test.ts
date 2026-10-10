import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'permission-handler.mjs');
const NODE = process.execPath;

function initializeGitRepo(directory: string): void {
  execFileSync('git', ['init', '--quiet'], {
    cwd: directory,
    stdio: 'pipe',
  });
}

function runPermissionHandler(command: string, cwd: string) {
  const result = spawnSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify({
      session_id: 'runtime-test-session',
      transcript_path: '/tmp/runtime-test-transcript.jsonl',
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'runtime-test-tool-use-id',
    }),
    encoding: 'utf-8',
    timeout: 10000,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  return JSON.parse(result.stdout.trim()) as {
    continue: boolean;
    hookSpecificOutput?: {
      decision?: {
        behavior?: string;
      };
    };
  };
}

describe('scripts/permission-handler.mjs runtime entrypoint', () => {
  let tempDir: string;
  let gitDir: string;
  let nonGitDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-permission-runtime-'));
    gitDir = join(tempDir, 'repo');
    nonGitDir = join(tempDir, 'scratch');

    mkdirSync(join(gitDir, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(gitDir, 'src', 'sample.ts'), 'export const value = 1;\n');
    writeFileSync(join(gitDir, 'src', '__tests__', 'sample.test.ts'), 'test("x", () => {});\n');
    initializeGitRepo(gitDir);

    mkdirSync(join(nonGitDir, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(nonGitDir, 'src', 'sample.ts'), 'export const value = 1;\n');
    writeFileSync(join(nonGitDir, 'src', '__tests__', 'sample.test.ts'), 'test("x", () => {});\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-allows repo-scoped inspection but not tests inside a git worktree', () => {
    const inspectionResult = runPermissionHandler('cat src/sample.ts', gitDir);
    expect(inspectionResult.continue).toBe(true);
    expect(inspectionResult.hookSpecificOutput?.decision?.behavior).toBe('allow');

    const targetedTestResult = runPermissionHandler('vitest run src/__tests__/sample.test.ts', gitDir);
    expect(targetedTestResult.continue).toBe(true);
    expect(targetedTestResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');
  });

  it('does not auto-allow ripgrep directory or hidden sweeps inside a git worktree', () => {
    writeFileSync(join(gitDir, '.env.local'), 'SECRET=1\n');

    const directorySweepResult = runPermissionHandler('rg -n SECRET .', gitDir);
    expect(directorySweepResult.continue).toBe(true);
    expect(directorySweepResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');

    const hiddenSweepResult = runPermissionHandler('rg --hidden SECRET .', gitDir);
    expect(hiddenSweepResult.continue).toBe(true);
    expect(hiddenSweepResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');
  });

  it('does not auto-allow broad tests or non-git temp directories', () => {
    const broadTestResult = runPermissionHandler('npm test', gitDir);
    expect(broadTestResult.continue).toBe(true);
    expect(broadTestResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');

    const nonGitInspectionResult = runPermissionHandler('cat src/sample.ts', nonGitDir);
    expect(nonGitInspectionResult.continue).toBe(true);
    expect(nonGitInspectionResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');

    const nonGitTargetedTestResult = runPermissionHandler('vitest run src/__tests__/sample.test.ts', nonGitDir);
    expect(nonGitTargetedTestResult.continue).toBe(true);
    expect(nonGitTargetedTestResult.hookSpecificOutput?.decision?.behavior).not.toBe('allow');
  });
});
