import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const runCjs = join(process.cwd(), 'scripts', 'run.cjs');

const sessionEndScripts = [
  ['session-end', join(process.cwd(), 'scripts', 'session-end.mjs')],
  ['wiki-session-end', join(process.cwd(), 'scripts', 'wiki-session-end.mjs')],
] as const;
const fallback = JSON.stringify({ continue: true, suppressOutput: true });

describe('SessionEnd hook stdin handling', () => {
  it.each(sessionEndScripts.flatMap(([name, script]) => [
    [name, 'empty stdin', script, ''],
    [name, 'whitespace stdin', script, '  \n\t  '],
  ] as const))('%s treats promptly closed %s as a clean no-op through run.cjs', (_name, _label, script, input) => {
    const result = spawnSync(process.execPath, [runCjs, script], {
      input,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(fallback);
  });
});
