import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'workflow-drift-guard.mjs');

function runGuard(input: Record<string, unknown>, env: Record<string, string> = {}) {
  const output = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(output) as { decision?: string; reason?: string; suppressOutput?: boolean };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-workflow-drift-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'index.ts'), 'export const ok = true;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('workflow-drift-guard Stop hook', () => {

  it('is registered only on the Stop hook event', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    const events = Object.entries(manifest.hooks)
      .filter(([, groups]) => groups.some((group) => group.hooks?.some((hook) => hook.command?.includes('workflow-drift-guard.mjs'))))
      .map(([event]) => event);

    expect(events).toEqual(['Stop']);
  });

  it('blocks prose approval questions that should use AskUserQuestion', () => {
    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'I found two viable paths. Which approach should I take?',
      cwd: process.cwd(),
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('AskUserQuestion');
    expect(result.reason).toContain('allowOther');
  });

  it('allows valid Other/free-form user input questions', () => {
    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'Please choose PostgreSQL, SQLite, or Other/free-form?',
      cwd: process.cwd(),
    });

    expect(result.decision).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });

  it('blocks completion claims when changed code adds skipped tests', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.test.ts'), "import { test } from 'vitest';\ntest.skip('covers the edge case', () => {});\n");

    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'Implemented and complete.',
      cwd,
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('skipped test');
    expect(result.reason).toContain('index.test.ts');
  });



  it('allows ready-to-continue wording while work is not being claimed complete', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');

    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'I am ready to continue after checking the next step.',
      cwd,
    });

    expect(result.decision).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });

  it('reports real file line numbers for tracked-file blockers', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), [
      'export const ok = true;',
      '',
      'export function later() {',
      '  const value = 1;',
      '  return value;',
      '  // TODO: implement blocker',
      '}',
    ].join('\n'));

    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'Implemented and complete.',
      cwd,
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('index.ts:6');
  });

  it('allows TODO blockers while work is not being claimed complete', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');

    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'I found the next implementation step and will continue after checking tests.',
      cwd,
    });

    expect(result.decision).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });



  it('allows detector and test fixture literals that mention blocker patterns', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'fixtures.ts'), [
      'const regex = /\\b(?:stub|placeholder|not implemented|unimplemented)\\b/i;',
      'const sampleTodo = "// TODO: implement fixture";',
      'const skippedTestFixture = "test.skip(\'covers fixture\', () => {})";',
    ].join('\n'));

    const result = runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'Implemented and complete.',
      cwd,
    });

    expect(result.decision).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });

  it('fails open when already continuing from a Stop hook', () => {
    const result = runGuard({
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: 'Complete, but which approach should I take?',
      cwd: process.cwd(),
    });

    expect(result.decision).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });
});
