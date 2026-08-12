import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const hookScript = resolve(__dirname, '../../../templates/hooks/pre-tool-use.mjs');

function runPreToolUseHook(command: string) {
  const payload = {
    tool_name: 'Bash',
    tool_input: { command },
  };

  const result = spawnSync('node', [hookScript], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('pre-tool-use template source extension detection', () => {
  it('does not warn for .json with stderr redirect', () => {
    const output = runPreToolUseHook(
      'cat ~/.claude/settings.json 2>/dev/null | python3 -m json.tool',
    );

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('still warns for real source files with redirection', () => {
    const output = runPreToolUseHook('cat src/app.js > /tmp/out.txt');
    const hookSpecificOutput = output.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;

    expect(output.continue).toBe(true);
    expect(hookSpecificOutput?.additionalContext).toContain(
      'Bash command may modify source files',
    );
  });

  describe('read-only commands stay quiet', () => {
    it.each([
      ['grep over source files with a stderr redirect', 'grep -n foo *.mjs 2>/dev/null | head'],
      ['cat of a source file with a stderr redirect', 'cat src/app.mjs 2>/dev/null | head -20'],
      ['find for source files with a stderr redirect', 'ls -la; find . -name "*.mjs" 2>/dev/null'],
      ['write and source mention in different segments', 'echo hi > notes.txt; grep -n pattern app.ts'],
      ['non-source write followed by a source read', 'printf "%s" x > README.md && node --check hooks/run.mjs'],
    ])('does not warn: %s', (_label, command) => {
      const output = runPreToolUseHook(command);

      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  describe('real source writes still warn', () => {
    it.each([
      ['in-place sed', 'sed -i s/a/b/ src/app.ts'],
      ['redirect into a source file', 'echo "x" > lib/util.js'],
      ['append into a source file', 'cat fragment.txt >> src/index.mjs'],
      ['source write after a read-only segment', 'ls -la | head; sed -i s/x/y/ src/main.py'],
    ])('warns: %s', (_label, command) => {
      const output = runPreToolUseHook(command);
      const hookSpecificOutput = output.hookSpecificOutput as
        | { additionalContext?: string }
        | undefined;

      expect(output.continue).toBe(true);
      expect(hookSpecificOutput?.additionalContext).toContain(
        'Bash command may modify source files',
      );
    });
  });
});
