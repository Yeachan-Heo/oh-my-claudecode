import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The options of sed and perl that matter for an in-place edit are one text that stands in two standalone scripts. Each script loads it
// into its own structure, so this test compares the text of the two copies byte for byte and the structure that the Python tool builds
// from it with the one the text gives.

const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const KINDS = ['flag', 'value', 'optional', 'octal', 'stop', 'script', 'inplace', 'quiet'];

function tableText(script: 'check_classifier.mjs' | 'user_prohibitions_after_compaction.py'): string {
  const pattern = script.endsWith('.mjs') ? /const EDIT_TABLE_TEXT = `([^`]*)`;/ : /EDIT_TABLE_TEXT = """([^"]*)"""/;
  const found = pattern.exec(readFileSync(join(TOOLS, script), 'utf8'));
  expect(found, `${script} has the table text`).not.toBeNull();
  return found![1];
}

describe('in-place option table: one text in two scripts', () => {
  it('the text is the same in both scripts, byte for byte', () => {
    expect(tableText('user_prohibitions_after_compaction.py')).toBe(tableText('check_classifier.mjs'));
  });

  it('every line is sed or perl, a known kind and options that start with a dash, and a kind comes once for a program', () => {
    const seen = new Set<string>();
    for (const line of tableText('check_classifier.mjs').split('\n')) {
      const [name, kind, ...options] = line.split(' ');
      expect(['sed', 'perl'], line).toContain(name);
      expect(KINDS, line).toContain(kind);
      expect(seen.has(`${name} ${kind}`), `${line} is a second line of its kind`).toBe(false);
      seen.add(`${name} ${kind}`);
      expect(options.length, line).toBeGreaterThan(0);
      for (const option of options) expect(option, line).toMatch(/^-[A-Za-z0-9]$|^--[a-z-]+$/);
      // perl has no long options
      if (name === 'perl') for (const option of options) expect(option, line).not.toMatch(/^--/);
    }
  });

  it.skipIf(!hasPython3)('the Python tool builds the sets of every program as the text says', () => {
    const code = [
      'import importlib.util, json, sys',
      'sys.dont_write_bytecode = True',
      'spec = importlib.util.spec_from_file_location("tool", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print(json.dumps({name: {k: sorted(v) for k, v in s.items() if k != "long"} for name, s in module.EDIT_TABLE.items()}))',
    ].join('\n');
    const proc = spawnSync('python3', ['-I', '-B', '-c', code, join(TOOLS, 'user_prohibitions_after_compaction.py')], { encoding: 'utf8', timeout: 60000 });
    expect(proc.status, proc.stderr).toBe(0);
    const want: Record<string, Record<string, string[]>> = {};
    for (const line of tableText('check_classifier.mjs').split('\n')) {
      const [name, kind, ...options] = line.split(' ');
      (want[name] ??= {})[kind] = [...options].sort();
    }
    expect(JSON.parse(proc.stdout)).toEqual(want);
  });
});
