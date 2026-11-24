import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const osPaths = { home: '', tmp: '' };
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => osPaths.home), tmpdir: vi.fn(() => osPaths.tmp) };
});

const suiteParent = resolve(process.env.HOME || '/Users');
const suiteRoot = mkdtempSync(join(suiteParent, 'omc-probe-memo-'));
osPaths.home = join(suiteRoot, 'home');
osPaths.tmp = join(suiteRoot, 'tmp');
mkdirSync(osPaths.home, { recursive: true });
mkdirSync(osPaths.tmp, { recursive: true });

import { stateGetStatusTool, stateListActiveTool, stateWriteTool } from '../state-tools.js';
import { clearWorktreeCache, setGitShowToplevelProbeForTests } from '../../lib/worktree-paths.js';

function notARepository(): Error & { status: number; stderr: string } {
  const err = new Error('Command failed: git rev-parse --show-toplevel') as Error & { status: number; stderr: string };
  err.status = 128;
  err.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
  return err;
}

let workingDirectory: string;
let probeCalls = 0;
const previousCwd = process.cwd();
const previousStateDir = process.env.OMC_STATE_DIR;

beforeEach(() => {
  workingDirectory = join(suiteRoot, `work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workingDirectory, { recursive: true });
  process.chdir(workingDirectory);
  process.env.OMC_STATE_DIR = join(workingDirectory, 'central');
  clearWorktreeCache();
  probeCalls = 0;
  setGitShowToplevelProbeForTests(() => {
    probeCalls++;
    throw notARepository();
  });
});

afterEach(() => {
  setGitShowToplevelProbeForTests(undefined);
  process.chdir(previousCwd);
  if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousStateDir;
  clearWorktreeCache();
});

afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

async function seedSessions(from: number, to: number): Promise<void> {
  for (let i = from; i < to; i++) {
    const result = await stateWriteTool.handler({ mode: 'ralph', session_id: `memo-${i}`, active: i % 2 === 0, workingDirectory });
    expect(result.isError).toBeUndefined();
  }
}

async function probesFor(run: () => Promise<{ content: Array<{ text: string }> }>): Promise<{ calls: number; text: string }> {
  probeCalls = 0;
  const result = await run();
  return { calls: probeCalls, text: result.content[0].text };
}

describe('aggregate state reads in a non-git working directory', () => {
  // Invariant: one aggregate read probes git a fixed number of times, independent of the session count.
  it('state_list_active spawns the git probe a fixed number of times, not once per session', async () => {
    await seedSessions(0, 2);
    const small = await probesFor(() => stateListActiveTool.handler({ all: true, workingDirectory }));
    await seedSessions(2, 12);
    const large = await probesFor(() => stateListActiveTool.handler({ all: true, workingDirectory }));

    expect(large.text).toContain('memo-10');
    expect(large.text).not.toContain('memo-11');
    expect(large.calls).toBe(small.calls);
  });

  it('state_get_status spawns the git probe a fixed number of times, not once per session', async () => {
    await seedSessions(0, 2);
    const small = await probesFor(() => stateGetStatusTool.handler({ mode: 'ralph', workingDirectory }));
    const smallAll = await probesFor(() => stateGetStatusTool.handler({ workingDirectory }));
    await seedSessions(2, 12);
    const large = await probesFor(() => stateGetStatusTool.handler({ mode: 'ralph', workingDirectory }));
    const largeAll = await probesFor(() => stateGetStatusTool.handler({ workingDirectory }));

    expect(large.text).toContain('memo-10');
    expect(large.calls).toBe(small.calls);
    expect(largeAll.calls).toBe(smallAll.calls);
  });

  it('does not reuse probe results across calls', async () => {
    await seedSessions(0, 1);
    const first = await probesFor(() => stateListActiveTool.handler({ all: true, workingDirectory }));
    const second = await probesFor(() => stateListActiveTool.handler({ all: true, workingDirectory }));

    expect(first.calls).toBeGreaterThan(0);
    expect(second.calls).toBe(first.calls);
  });
});
