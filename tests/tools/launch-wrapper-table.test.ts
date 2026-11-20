import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The table of launch wrappers (sudo, timeout, nice, env, nohup, time, command, exec) is one text that stands in four standalone
// scripts. Each script loads it into its own structure, so this test compares the text of the four copies byte for byte and the
// structures that the three Python tools build from it.

const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const SCRIPTS = {
  'check_classifier.mjs': /const LAUNCH_TABLE_TEXT = `([^`]*)`;/,
  'user_prohibitions_after_compaction.py': /LAUNCH_TABLE_TEXT = """([^"]*)"""/,
  'advisor_event_coverage.py': /LAUNCH_TABLE_TEXT = """([^"]*)"""/,
  'executor_outcome_metrics.py': /LAUNCH_TABLE_TEXT = """([^"]*)"""/,
};

function tableText(script: keyof typeof SCRIPTS): string {
  const found = SCRIPTS[script].exec(readFileSync(join(TOOLS, script), 'utf8'));
  expect(found, `${script} has the table text`).not.toBeNull();
  return found![1];
}

// The structure every tool builds from the text: for each wrapper, the sorted options of each kind and the two switches.
function parse(text: string) {
  const table: Record<string, Record<string, unknown>> = {};
  for (const line of text.split('\n')) {
    const [name, kind, ...options] = line.split(' ');
    const spec = (table[name] ??= { flag: [], value: [], optional: [], stop: [], assign: false, duration: false, number: false });
    if (kind === 'assign' || kind === 'duration' || kind === 'number') spec[kind] = true;
    else (spec[kind] as string[]).push(...options);
  }
  for (const spec of Object.values(table)) for (const kind of ['flag', 'value', 'optional', 'stop']) (spec[kind] as string[]).sort();
  return table;
}

describe('launch wrapper table: one text in four scripts', () => {
  it('the text is the same in the four scripts, byte for byte', () => {
    const reference = tableText('check_classifier.mjs');
    for (const script of Object.keys(SCRIPTS) as Array<keyof typeof SCRIPTS>) expect(tableText(script), script).toBe(reference);
  });

  it('every line is a wrapper, a known kind and options that start with a dash', () => {
    for (const line of tableText('check_classifier.mjs').split('\n')) {
      const [name, kind, ...options] = line.split(' ');
      expect(['sudo', 'nohup', 'command', 'exec', 'nice', 'time', 'timeout', 'env'], line).toContain(name);
      expect(['flag', 'value', 'optional', 'stop', 'assign', 'duration', 'number'], line).toContain(kind);
      if (['assign', 'duration', 'number'].includes(kind)) expect(options, line).toEqual([]);
      else for (const option of options) expect(option, line).toMatch(/^-/);
    }
  });

  it.skipIf(!hasPython3).each([
    'user_prohibitions_after_compaction.py',
    'advisor_event_coverage.py',
    'executor_outcome_metrics.py',
  ])('%s builds the same options of every wrapper as the text says', (script) => {
    const code = [
      'import importlib.util, json, sys',
      'sys.dont_write_bytecode = True',
      'spec = importlib.util.spec_from_file_location("tool", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print(json.dumps({name: {k: (sorted(v) if isinstance(v, set) else v) for k, v in s.items() if k != "long"} for name, s in module.LAUNCH_TABLE.items()}))',
    ].join('\n');
    const proc = spawnSync('python3', ['-I', '-B', '-c', code, join(TOOLS, script)], { encoding: 'utf8', timeout: 60000 });
    expect(proc.status, proc.stderr).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual(parse(tableText('check_classifier.mjs')));
  });
});
