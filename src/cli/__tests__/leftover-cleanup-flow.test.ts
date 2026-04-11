/**
 * Unit tests for runLeftoverCleanupFlow — the plugin-duplicate leftover
 * preview + prompt + execute helper in runSetupCommand.
 *
 * Tests the TTY / non-TTY branching, preview-then-execute ordering,
 * and the user-declined path. Uses real filesystem fixtures in tmpdirs.
 *
 * Module-const caveat: src/installer/index.ts reads CLAUDE_CONFIG_DIR at
 * load time into module-level constants (AGENTS_DIR, HOOKS_DIR, etc.).
 * Every test therefore calls vi.resetModules() and fresh-imports BEFORE
 * mutating CLAUDE_CONFIG_DIR — otherwise the stale module constant points
 * at the wrong directory.
 *
 * readline mock: askYesNo uses `await import('node:readline')` (ESM dynamic
 * import). vi.mock() at the top level is hoisted and intercepts the ESM
 * module registry, so it works; vi.spyOn(require(...)) does NOT work here.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

// Tell src/cli/index.ts not to auto-parse process.argv on import.
process.env.OMC_CLI_SKIP_PARSE = '1';

// ---------------------------------------------------------------------------
// readline mock — hoisted by Vitest so it intercepts the ESM dynamic import
// inside askYesNo. The scripted answer is set per-test via setNextAnswer().
// ---------------------------------------------------------------------------
let _nextAnswer = '';
function setNextAnswer(a: string): void {
  _nextAnswer = a;
}

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (a: string) => void) => cb(_nextAnswer),
    close: () => {},
  }),
}));

const SAVED_KEYS = ['CLAUDE_CONFIG_DIR', 'OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'] as const;
type SavedKey = (typeof SAVED_KEYS)[number];
type EnvSnapshot = Record<SavedKey, string | undefined>;

let tmpConfigDir: string;
let tmpPluginRoot: string;
let savedEnv: EnvSnapshot;

/** Collect all data written to a stream into a single string. */
function makeBufferStream(): { stream: Writable; buf(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, buf: () => chunks.join('') };
}

/** Seed a leftover hook file in tmpConfigDir/hooks/ that matches OMC_HOOK_FILENAMES. */
function seedLeftoverHook(): string {
  const hooksDir = join(tmpConfigDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const leftover = join(hooksDir, 'keyword-detector.mjs');
  writeFileSync(leftover, '// stale standalone hook\n', 'utf8');
  return leftover;
}

/**
 * Fresh-import runLeftoverCleanupFlow after resetting modules so the
 * installer's module-level CLAUDE_CONFIG_DIR constant picks up the current
 * process.env.CLAUDE_CONFIG_DIR value.
 */
async function freshImport(): Promise<{
  runLeftoverCleanupFlow: typeof import('../index.js')['runLeftoverCleanupFlow'];
}> {
  vi.resetModules();
  const mod = await import('../index.js');
  return { runLeftoverCleanupFlow: mod.runLeftoverCleanupFlow };
}

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'omc-leftover-cfg-'));
  tmpPluginRoot = mkdtempSync(join(tmpdir(), 'omc-leftover-plugin-'));

  // Fake plugin root with hooks/hooks.json so hasPluginProvidedHookFiles() → true.
  mkdirSync(join(tmpPluginRoot, 'hooks'), { recursive: true });
  writeFileSync(
    join(tmpPluginRoot, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: {} }),
    'utf8',
  );

  savedEnv = {} as EnvSnapshot;
  for (const key of SAVED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  process.env.CLAUDE_PLUGIN_ROOT = tmpPluginRoot;
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpPluginRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TTY + hasWork
// ---------------------------------------------------------------------------
describe('runLeftoverCleanupFlow — TTY + hasWork', () => {
  it('shows preview, prompts, prunes on confirm (y)', async () => {
    const leftover = seedLeftoverHook();
    setNextAnswer('y');

    const { stream, buf } = makeBufferStream();
    const { runLeftoverCleanupFlow } = await freshImport();
    const result = await runLeftoverCleanupFlow({ isTty: true, stdout: stream });

    const output = buf();

    // Preview rendered
    expect(output).toContain('plugin-duplicate leftovers');
    expect(output).toContain(leftover);
    // Confirmation message after execute
    expect(output).toContain('Cleaned up');

    // File actually removed
    expect(existsSync(leftover), 'leftover should be pruned after confirm').toBe(false);

    // Result reflects execute
    expect(result.prunedHooks).toContain(leftover);
    expect(result.totalPruneCount).toBeGreaterThanOrEqual(1);
  });

  it('shows preview, prompts, SKIPS prune on decline (n)', async () => {
    const leftover = seedLeftoverHook();
    setNextAnswer('n');

    const { stream, buf } = makeBufferStream();
    const { runLeftoverCleanupFlow } = await freshImport();
    await runLeftoverCleanupFlow({ isTty: true, stdout: stream });

    const output = buf();

    expect(output).toContain('plugin-duplicate leftovers');
    expect(output).toContain('Leftover cleanup skipped');
    // NOT in output: "Cleaned up"
    expect(output).not.toContain('Cleaned up');

    // File NOT removed
    expect(existsSync(leftover), 'leftover should survive decline').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-TTY + hasWork
// ---------------------------------------------------------------------------
describe('runLeftoverCleanupFlow — non-TTY + hasWork', () => {
  it('silent auto-prune, no prompt, summary logged', async () => {
    const leftover = seedLeftoverHook();

    const { stream, buf } = makeBufferStream();
    const { runLeftoverCleanupFlow } = await freshImport();
    const result = await runLeftoverCleanupFlow({ isTty: false, stdout: stream });

    const output = buf();

    // Summary logged
    expect(output).toContain('plugin-duplicate leftovers');
    expect(output).toContain('Cleaned up');
    // NO prompt text
    expect(output).not.toContain('Remove these');

    // File actually removed
    expect(existsSync(leftover)).toBe(false);
    expect(result.prunedHooks).toContain(leftover);
  });
});

// ---------------------------------------------------------------------------
// No work (hasWork === false)
// ---------------------------------------------------------------------------
describe('runLeftoverCleanupFlow — no work', () => {
  it('is a no-op when no leftovers exist (TTY)', async () => {
    // Plugin active but config dir is empty — nothing to clean.
    const { stream, buf } = makeBufferStream();
    const { runLeftoverCleanupFlow } = await freshImport();
    const result = await runLeftoverCleanupFlow({ isTty: true, stdout: stream });

    expect(buf(), 'no output when nothing to clean').toBe('');
    expect(result.hasWork).toBe(false);
    expect(result.totalPruneCount).toBe(0);
  });

  it('is a no-op when plugin is not active (non-TTY)', async () => {
    // Remove plugin root so hasPluginProvidedHookFiles() → false.
    delete process.env.CLAUDE_PLUGIN_ROOT;

    // Seed leftovers anyway — they should be left untouched.
    const leftover = seedLeftoverHook();

    const { stream, buf } = makeBufferStream();
    const { runLeftoverCleanupFlow } = await freshImport();
    const result = await runLeftoverCleanupFlow({ isTty: false, stdout: stream });

    // No plugin → preview returns hasWork=false → helper is no-op.
    expect(result.hasWork).toBe(false);
    // File survived because helper did nothing.
    expect(existsSync(leftover)).toBe(true);
    expect(buf()).toBe('');
  });
});
