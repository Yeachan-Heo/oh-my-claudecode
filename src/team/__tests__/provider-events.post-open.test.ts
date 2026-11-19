// The provider-event reader and hook check the path again after the open: a
// leaf or worker directory swapped between the open and that check must not be
// read from or written to. These tests swap them right after the real open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const swap = vi.hoisted(() => ({ afterOpen: null as null | ((path: string) => void) }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    if (swap.afterOpen && path.endsWith('provider-events.jsonl')) swap.afterOpen(path);
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

import { readLatestProviderEvent } from '../provider-events.js';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'team-provider-event-hook.mjs');
const EVENT_LINE = `${JSON.stringify({ v: 1, event: 'Stop', at: 7, attempt: 'a1' })}\n`;

// Swaps applied right after the real open, in this process or in the hook's.
const SWAPS = {
  // Another regular file takes the leaf's name; the open handle still holds the old one.
  leaf: (path: string) => {
    renameSync(path, `${path}.moved`);
    writeFileSync(path, '');
  },
  // workers/<name> becomes a symlink to a directory outside the team.
  parent: (path: string, outside: string) => {
    const workerDir = dirname(path);
    renameSync(workerDir, `${workerDir}.moved`);
    symlinkSync(outside, workerDir);
  },
  // workers/<name> becomes a symlink to its own moved directory, so the path
  // still names the opened file: only the directory check can catch this.
  parentSameLeaf: (path: string) => {
    const workerDir = dirname(path);
    renameSync(workerDir, `${workerDir}.moved`);
    symlinkSync(`${workerDir}.moved`, workerDir);
  },
  // workers/<name> becomes another real directory holding a hard link to the
  // opened file: the leaf and is-a-directory checks pass, only the directory's
  // identity differs.
  parentHardLink: (path: string) => {
    const workerDir = dirname(path);
    renameSync(workerDir, `${workerDir}.moved`);
    mkdirSync(workerDir);
    linkSync(join(`${workerDir}.moved`, 'provider-events.jsonl'), path);
  },
};

describe.skipIf(process.platform === 'win32')('provider events after a swap between open and re-check', () => {
  let root = '';
  let outside = '';
  let workerDir = '';
  let path = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'provider-events-swap-'));
    outside = mkdtempSync(join(tmpdir(), 'provider-events-swap-outside-'));
    workerDir = join(root, 'workers', 'worker-1');
    path = join(workerDir, 'provider-events.jsonl');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(outside, 'provider-events.jsonl'), '');
  });
  afterEach(() => {
    swap.afterOpen = null;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reader returns none when the leaf is replaced after the open', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.afterOpen = opened => SWAPS.leaf(opened);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('reader returns none when the worker directory becomes a symlink after the open', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.afterOpen = opened => SWAPS.parent(opened, outside);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('reader returns none when the worker directory becomes a symlink to the same file after the open', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.afterOpen = opened => SWAPS.parentSameLeaf(opened);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('reader returns none when the worker directory becomes another real directory linking the same file after the open', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.afterOpen = opened => SWAPS.parentHardLink(opened);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('reader still reads the file when nothing is swapped', async () => {
    writeFileSync(path, EVENT_LINE);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'Stop', at: 7 });
  });

  // The hook runs as its own process, so a preload wraps fs/promises.open there.
  const runHook = (kind: keyof typeof SWAPS | 'none') => {
    const preload = join(root, 'swap-preload.mjs');
    writeFileSync(preload, [
      "import fsp from 'node:fs/promises';",
      "import { linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const real = fsp.open;',
      `const kind = ${JSON.stringify(kind)};`,
      `const outside = ${JSON.stringify(outside)};`,
      'fsp.open = async (...args) => {',
      '  const handle = await real(...args);',
      '  const path = String(args[0]);',
      "  if (path.endsWith('provider-events.jsonl')) {",
      "    if (kind === 'leaf') { renameSync(path, `${path}.moved`); writeFileSync(path, ''); }",
      "    if (kind === 'parent') { const dir = dirname(path); renameSync(dir, `${dir}.moved`); symlinkSync(outside, dir); }",
      "    if (kind === 'parentSameLeaf') { const dir = dirname(path); renameSync(dir, `${dir}.moved`); symlinkSync(`${dir}.moved`, dir); }",
      "    if (kind === 'parentHardLink') { const dir = dirname(path); renameSync(dir, `${dir}.moved`); mkdirSync(dir); linkSync(join(`${dir}.moved`, 'provider-events.jsonl'), path); }",
      '  }',
      '  return handle;',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HOOK, 'Stop'], {
      env: { PATH: process.env.PATH ?? '', OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
  };
  const expectSilentExit = (result: ReturnType<typeof spawnSync>) => {
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  };

  it('hook appends nothing when the leaf is replaced after the open', () => {
    expectSilentExit(runHook('leaf'));
    expect(readFileSync(`${path}.moved`, 'utf8')).toBe('');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('hook appends nothing when the worker directory becomes a symlink after the open', () => {
    expectSilentExit(runHook('parent'));
    expect(readFileSync(join(`${workerDir}.moved`, 'provider-events.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(join(outside, 'provider-events.jsonl'), 'utf8')).toBe('');
  });

  it('hook appends nothing when the worker directory becomes a symlink to the same file after the open', () => {
    expectSilentExit(runHook('parentSameLeaf'));
    expect(readFileSync(join(`${workerDir}.moved`, 'provider-events.jsonl'), 'utf8')).toBe('');
  });

  it('hook appends nothing when the worker directory becomes another real directory linking the same file after the open', () => {
    expectSilentExit(runHook('parentHardLink'));
    // One inode, two names: the file is still empty under both.
    expect(readFileSync(join(`${workerDir}.moved`, 'provider-events.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('hook appends one line through the same preload when nothing is swapped', () => {
    expectSilentExit(runHook('none'));
    expect(readFileSync(path, 'utf8')).toMatch(/^\{"v":1,"event":"Stop","at":\d+,"attempt":"a1"\}\n$/);
  });
});
