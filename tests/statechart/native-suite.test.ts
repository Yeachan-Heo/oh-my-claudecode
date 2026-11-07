import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The statechart skill ships its own node:test suite (see
// skills/statechart/scripts/package.json). It uses node:test subtests and
// context hooks that do not map onto vitest, so this wrapper runs each test
// file natively and fails with the TAP tail when one breaks. Nodes without
// type-stripping (the 20.x line `engines` still supports) load the .ts test
// files through the tsx loader instead, so the suite runs on every CI node.
// Files run as separate vitest tests so vitest's worker parallelism covers
// the heavy corpus-replay and fuzz files.
function nodeSupportsTypeStripping(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

function nodeArgs(file: string): string[] {
  const base = ['--disable-warning=ExperimentalWarning', '--test', file];
  return nodeSupportsTypeStripping() ? base : ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--test', file];
}

// pipeline.test.ts's module-graph case spawns a node -e snippet using
// `module.registerHooks`, an API Node 20 lacks — skip that file where the
// API is missing (the release job's Node 24 still runs it).
function nodeHasRegisterHooks(): boolean {
  const probe = spawnSync(
    process.execPath,
    ['-e', 'require("node:module").registerHooks'],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
}

const scriptsDir = join(import.meta.dirname, '..', '..', 'skills', 'statechart', 'scripts');
const registerHooks = nodeHasRegisterHooks();
const testFiles = readdirSync(join(scriptsDir, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => {
    // Platform policy mirrors upstream's CI layout: render.test.ts installs
    // the Pele renderer via `npm` per run, which spawnSync cannot exec on
    // win32 (npm.cmd) and which needs the network anyway; cli.test.ts never
    // runs on Windows upstream (their Windows job is a single smoke run) —
    // its symlink and CRLF-sensitive cases assume a POSIX host.
    if (process.platform === 'win32' && (f === 'render.test.ts' || f === 'cli.test.ts')) {
      return false;
    }
    return true;
  })
  .filter((f) => !(f === 'pipeline.test.ts' && !registerHooks))
  // cli.test drives the full CLI once per corpus case — 126 subprocess
  // chains of CLI + worker + shim. On a node without type stripping each
  // process pays the tsx transform from scratch (~40s per case, measured),
  // which no sane budget covers; the dedicated Node 24 CI job runs the file
  // there in ~2 minutes instead. Every other file is in-process and keeps
  // its Node 20 coverage.
  .filter((f) => !(f === 'cli.test.ts' && !nodeSupportsTypeStripping()))
  .sort()
  .map((f) => join('test', f));

// Per-file budgets: cli.test.ts drives the full CLI once per corpus case
// (hundreds of node startups — upstream gives it its own 20-minute runner),
// so it alone gets the largest budget; every other file settles well under
// a minute. cli.test runs only where type stripping is native (see the
// filter above); there, each case costs ~2s.
const FILE_TIMEOUT_MS: Record<string, number> = {
  [join('test', 'cli.test.ts')]: 1_140_000,
};

describe('statechart native suite', () => {
  for (const file of testFiles) {
    const budget = FILE_TIMEOUT_MS[file] ?? 480_000;
    it(
      `passes ${file}`,
      { timeout: budget },
      () => {
        const r = spawnSync(process.execPath, nodeArgs(file), {
          cwd: scriptsDir,
          encoding: 'utf8',
          maxBuffer: 1 << 28,
          timeout: budget - 10_000,
        });
        if (r.status !== 0) {
          const tail = (r.stdout ?? '').split('\n').slice(-80).join('\n');
          throw new Error(`statechart ${file} exited ${r.status}\n${tail}\n${r.stderr ?? ''}`);
        }
        expect(r.status).toBe(0);
      },
    );
  }
});
