/**
 * Tests for `--plugin-dir` capture in `omc` launch.
 *
 * Plan: binary-weaving-mountain — HUD wrapper resolves the active plugin root
 * from `process.env.OMC_PLUGIN_ROOT`, set by the `omc` CLI when the user
 * passes `--plugin-dir <path>`. The flag must NOT be consumed (it still
 * forwards to Claude Code's plugin loader untouched).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parsePluginDirArg, TMUX_ENV_FORWARD } from '../launch.js';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';

describe('parsePluginDirArg', () => {
  it('returns absolute path for "--plugin-dir <path>" form', () => {
    const out = parsePluginDirArg(['--plugin-dir', '/foo/bar', 'other']);
    expect(out).toBe(resolve('/foo/bar'));
  });

  it('returns absolute path for "--plugin-dir=<path>" form', () => {
    const out = parsePluginDirArg(['--plugin-dir=/foo/bar']);
    expect(out).toBe(resolve('/foo/bar'));
  });

  it('preserves Windows drive-letter absolute paths on non-Windows hosts', () => {
    const out = parsePluginDirArg(['--plugin-dir', 'C:\\Users\\me\\omc']);
    expect(out).toBe('C:\\Users\\me\\omc');
  });

  it('preserves Windows UNC absolute paths on non-Windows hosts', () => {
    const out = parsePluginDirArg(['--plugin-dir=\\\\server\\share\\omc']);
    expect(out).toBe('\\\\server\\share\\omc');
  });

  it('returns null when --plugin-dir is absent', () => {
    expect(parsePluginDirArg(['--madmax', '--notify', 'false'])).toBeNull();
  });

  it('resolves a relative path to absolute', () => {
    const out = parsePluginDirArg(['--plugin-dir', './rel/path']);
    expect(out).toBe(resolve('./rel/path'));
  });

  it('does not consume the flag (caller must still forward it)', () => {
    const args = ['--plugin-dir', '/foo/bar', '--madmax'];
    parsePluginDirArg(args);
    expect(args).toEqual(['--plugin-dir', '/foo/bar', '--madmax']);
  });
});

describe('OMC_PLUGIN_ROOT tmux env forwarding', () => {
  it('is included in TMUX_ENV_FORWARD so it survives tmux env scrubbing', () => {
    expect(TMUX_ENV_FORWARD).toContain('OMC_PLUGIN_ROOT');
  });
});

/**
 * End-to-end env-propagation tests for `launchCommand`.
 *
 * We mock `child_process.execFileSync` so that any spawn of `claude` captures
 * the parent `process.env` snapshot at call time, then throws to short-circuit
 * the rest of `runClaude`. We also mock `./tmux-utils.js` so the launch policy
 * is forced to `direct` (no tmux dependency) and `claude` is reported as
 * available. CLAUDE_CONFIG_DIR is pointed at a throwaway tmpdir so
 * `prepareOmcLaunchConfigDir` short-circuits cheaply.
 *
 * The thing under test: `launchCommand` mutates `process.env[OMC_PLUGIN_ROOT_ENV]`
 * exactly when `--plugin-dir`/`--plugin-dir=` is present, and otherwise leaves
 * the parent value alone — that env then flows into the child via
 * `execFileSync`'s default env-inherit semantics.
 */

const SHORTCIRCUIT = Symbol('child_process mock short-circuit');
let capturedEnv: NodeJS.ProcessEnv | null = null;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn((file: string, _args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (file === 'claude') {
        // execFileSync inherits parent env when options.env is undefined,
        // so the source of truth is process.env at call time.
        capturedEnv = { ...(options?.env ?? process.env) };
        const err: NodeJS.ErrnoException & { __omc?: symbol } = new Error('mocked claude exit');
        err.__omc = SHORTCIRCUIT;
        // Throwing aborts runClaude/launchCommand cleanly via the try/finally.
        throw err;
      }
      // Allow non-claude execFileSync calls (e.g. tmux probes) to be no-ops.
      return Buffer.alloc(0);
    }),
  };
});

vi.mock('../tmux-utils.js', async () => {
  const actual = await vi.importActual<typeof import('../tmux-utils.js')>('../tmux-utils.js');
  return {
    ...actual,
    isClaudeAvailable: () => true,
    resolveLaunchPolicy: () => 'direct' as const,
  };
});

describe('launchCommand → child env propagation (OMC_PLUGIN_ROOT)', () => {
  let tmpConfigDir: string;
  let savedEnv: { [k: string]: string | undefined };
  let savedCwd: string;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'omc-pdc-'));
    savedEnv = {
      [OMC_PLUGIN_ROOT_ENV]: process.env[OMC_PLUGIN_ROOT_ENV],
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDECODE: process.env.CLAUDECODE,
      OMC_NOTIFY: process.env.OMC_NOTIFY,
    };
    savedCwd = process.cwd();
    delete process.env[OMC_PLUGIN_ROOT_ENV];
    delete process.env.CLAUDECODE;
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
    capturedEnv = null;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try { process.chdir(savedCwd); } catch { /* ignore */ }
    try { rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function runLaunch(argv: string[]): Promise<void> {
    const { launchCommand } = await import('../launch.js');
    try {
      await launchCommand(argv);
    } catch {
      // Expected: our mocked execFileSync throws to short-circuit.
    }
  }

  it('1. --plugin-dir <path> → child env contains absolute OMC_PLUGIN_ROOT', async () => {
    await runLaunch(['--plugin-dir', '/tmp/foo']);
    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/foo'));
  });

  it('2. --plugin-dir=<path> → child env contains absolute OMC_PLUGIN_ROOT', async () => {
    await runLaunch(['--plugin-dir=/tmp/foo']);
    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/foo'));
  });

  it('3. no flag and no parent env → child env does not contain OMC_PLUGIN_ROOT', async () => {
    await runLaunch([]);
    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBeUndefined();
  });

  it('4. parent env set + --plugin-dir → argv wins over inherited env', async () => {
    process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/bar';
    await runLaunch(['--plugin-dir', '/tmp/foo']);
    expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/foo'));
  });

  it('5. parent env set + no flag → child inherits parent OMC_PLUGIN_ROOT', async () => {
    process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/bar';
    await runLaunch([]);
    expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBe('/tmp/bar');
  });

  it('6. relative --plugin-dir is resolved against the launch CWD', async () => {
    // realpath: macOS prefixes /tmp -> /private/var/..., and process.chdir
    // resolves the symlink, so the launch-time cwd uses the canonical path.
    const knownCwd = realpathSync(mkdtempSync(join(tmpdir(), 'omc-pdc-cwd-')));
    try {
      process.chdir(knownCwd);
      await runLaunch(['--plugin-dir', './foo']);
      expect(capturedEnv![OMC_PLUGIN_ROOT_ENV]).toBe(resolve(knownCwd, './foo'));
    } finally {
      try { process.chdir(savedCwd); } catch { /* ignore */ }
      try { rmSync(knownCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
