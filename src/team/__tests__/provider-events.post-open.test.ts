// The provider-event reader and hook check the path again after the open: a
// leaf or worker directory swapped between the open and that check must not be
// read from or written to. These tests swap them right after the real open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const swap = vi.hoisted(() => ({
  afterOpen: null as null | ((path: string) => void),
  // Event files that opened, how many of them closed, and whether close should fail.
  opened: [] as string[],
  closed: 0,
  failClose: false,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    if (path.endsWith('provider-events.jsonl')) {
      swap.opened.push(path);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        swap.closed += 1;
        if (swap.failClose) throw new Error('close failed');
      };
      if (swap.afterOpen) swap.afterOpen(path);
    }
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
  // The team root becomes a symlink to its own moved directory, so the path
  // still names the opened file: only the team root check can catch this.
  teamRoot: (path: string) => {
    const teamRoot = dirname(dirname(dirname(path)));
    renameSync(teamRoot, `${teamRoot}.moved`);
    symlinkSync(`${teamRoot}.moved`, teamRoot);
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
    swap.opened = [];
    swap.closed = 0;
    swap.failClose = false;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.moved`, { recursive: true, force: true });
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

  it('reader returns none when the team root becomes a symlink after the open', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.afterOpen = opened => SWAPS.teamRoot(opened);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
  });

  it('reader still reads the file when nothing is swapped', async () => {
    writeFileSync(path, EVENT_LINE);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'Stop', at: 7 });
  });

  it('reader opens nothing through a symlinked worker directory or leaf', async () => {
    writeFileSync(join(outside, 'provider-events.jsonl'), EVENT_LINE);
    symlinkSync(outside, join(root, 'workers', 'worker-2'));
    symlinkSync(join(outside, 'provider-events.jsonl'), path);
    expect(await readLatestProviderEvent(root, 'worker-2', 'a1')).toEqual({ event: 'none' });
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
    expect(swap.opened).toEqual([]);
  });

  it('reader returns none for a FIFO that holds a complete line', async () => {
    execFileSync('mkfifo', [path]);
    // A read-write descriptor keeps a writer on the FIFO without blocking; the
    // line waits in the pipe, and closing the writer after the open gives EOF.
    const writer = openSync(path, constants.O_RDWR);
    writeSync(writer, EVENT_LINE);
    swap.afterOpen = () => closeSync(writer);
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'none' });
    expect(swap.opened).toEqual([path]);
  });

  it('reader closes every file it opens, read or refused', async () => {
    writeFileSync(path, EVENT_LINE);
    await readLatestProviderEvent(root, 'worker-1', 'a1');
    swap.afterOpen = opened => SWAPS.leaf(opened);
    await readLatestProviderEvent(root, 'worker-1', 'a1');
    expect(swap.opened).toHaveLength(2);
    expect(swap.closed).toBe(2);
  });

  it('reader still returns the event when closing the file fails', async () => {
    writeFileSync(path, EVENT_LINE);
    swap.failClose = true;
    expect(await readLatestProviderEvent(root, 'worker-1', 'a1')).toEqual({ event: 'Stop', at: 7 });
    expect(swap.closed).toBe(1);
  });

  // The hook runs as its own process, so a preload wraps fs/promises.open there.
  const runHook = (kind: keyof typeof SWAPS | 'none') => {
    const preload = join(root, 'swap-preload.mjs');
    writeFileSync(preload, [
      "import fsp from 'node:fs/promises';",
      "import { existsSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';",
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
      "    if (kind === 'teamRoot') { const dir = dirname(dirname(dirname(path))); renameSync(dir, `${dir}.moved`); symlinkSync(`${dir}.moved`, dir); }",
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

  it('hook appends nothing when the team root becomes a symlink after the open', () => {
    expectSilentExit(runHook('teamRoot'));
    expect(readFileSync(join(`${root}.moved`, 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8')).toBe('');
  });

  it('hook writes nothing on Windows, where O_NOFOLLOW cannot refuse a symlinked leaf', () => {
    const preload = join(root, 'win32-preload.mjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HOOK, 'Stop'], {
      env: { PATH: process.env.PATH ?? '', OMC_TEAM_STATE_ROOT: root, OMC_TEAM_WORKER: 'demo/worker-1', OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expectSilentExit(result);
    expect(existsSync(path)).toBe(false);
  });

  it('hook appends one line through the same preload when nothing is swapped', () => {
    expectSilentExit(runHook('none'));
    expect(readFileSync(path, 'utf8')).toMatch(/^\{"v":1,"event":"Stop","at":\d+,"attempt":"a1"\}\n$/);
  });
});
