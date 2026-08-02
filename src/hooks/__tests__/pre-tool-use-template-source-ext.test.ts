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

  it('does not warn for stderr-to-null redirect alongside source extensions', () => {
    const output = runPreToolUseHook(
      'ls ~/.claude/hooks/*.mjs ~/.claude/hooks/*.sh 2>/dev/null | wc -l',
    );

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('does not warn for fd duplication (2>&1) on a source file command', () => {
    const output = runPreToolUseHook('node script.mjs 2>&1 | head -5');

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('does not warn for comparison operators in inline snippets naming source files', () => {
    const output = runPreToolUseHook(
      "grep -c 'def ' app.py | awk '{ exit !($1 >= 3) }'",
    );

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('still warns for appending to a source file', () => {
    const output = runPreToolUseHook('cat extra.py >> main.py');
    const hookSpecificOutput = output.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;

    expect(output.continue).toBe(true);
    expect(hookSpecificOutput?.additionalContext).toContain(
      'Bash command may modify source files',
    );
  });

  it('still warns for sed -i on a source file', () => {
    const output = runPreToolUseHook("sed -i '' 's/a/b/' src/app.ts");
    const hookSpecificOutput = output.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;

    expect(output.continue).toBe(true);
    expect(hookSpecificOutput?.additionalContext).toContain(
      'Bash command may modify source files',
    );
  });
});
