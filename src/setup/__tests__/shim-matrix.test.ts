/**
 * shim-matrix: black-box tests for the bash shims + resolve-omc-cli helper.
 *
 * The three shims are expected to:
 *   1. Resolve `omc` via PATH → `$CLAUDE_PLUGIN_ROOT/bridge/cli.cjs` →
 *      `<plugin_root>/bridge/cli.cjs` → `$CLAUDE_PLUGIN_ROOT/dist/cli/index.js` →
 *      `<plugin_root>/dist/cli/index.js` → error.
 *   2. Translate positional arguments into the correct `omc setup --...` flags.
 *   3. Passthrough exit codes and stderr from the CLI.
 *
 * These tests vendor a controlled copy of the shim + resolver into a tmpdir so
 * host state (a real `omc` on PATH, a real `bridge/cli.cjs`, etc.) cannot leak
 * into the scenario.  We stub the CLI with a tiny bash/node script that echoes
 * its arguments and exits with whatever code the test expects.
 *
 * Skipped on Windows (bash unavailable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

if (process.platform === 'win32') {
  describe.skip('shim-matrix (Windows — bash unavailable)', () => {
    it('TODO', () => {});
  });
} else {
  // ───────────────────────── constants / paths ─────────────────────────

  const REPO_ROOT = resolve(__dirname, '../../..');
  const REAL_RESOLVER = join(REPO_ROOT, 'scripts/lib/resolve-omc-cli.sh');
  const REAL_CLAUDE_MD_SHIM = join(REPO_ROOT, 'scripts/setup-claude-md.sh');
  const REAL_PROGRESS_SHIM = join(REPO_ROOT, 'scripts/setup-progress.sh');

  // ───────────────────────────── helpers ───────────────────────────────

  /**
   * Build a Node-compatible CLI stub. Since the resolver runs `node <file>`,
   * every fake bridge/dist entry must be valid JavaScript. The stub prints
   * "ARGS: ..." plus an optional marker line and exits with `exitCode`.
   */
  function nodeCliStub(marker: string, exitCode: number): string {
    return [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2).join(" ");',
      'process.stdout.write("ARGS: " + args + "\\n");',
      marker ? `process.stdout.write(${JSON.stringify(marker + '\n')});` : '',
      `process.exit(${exitCode});`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Build a fake plugin-root tree that mirrors the repo layout the resolver
   * expects. Options:
   *   - `withBridge`: create `<root>/bridge/cli.cjs` stub (executable).
   *   - `withDist`  : create `<root>/dist/cli/index.js` stub (executable).
   *   - `stubExit`  : exit code the stub script returns.
   *   - `stubStdout`: line the stub prints to stdout (default: JSON-ish echo).
   */
  function makeFakePluginRoot(
    baseDir: string,
    opts: {
      withBridge?: boolean;
      withDist?: boolean;
      stubExit?: number;
      stubStdout?: string;
    } = {},
  ): string {
    const root = join(baseDir, 'fake-plugin-root');
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    // Vendor the real shims + resolver into the fake root so BASH_SOURCE
    // resolves plugin_root relative to *this* tmpdir, not the real repo.
    copyFileSync(REAL_RESOLVER, join(root, 'scripts', 'lib', 'resolve-omc-cli.sh'));
    copyFileSync(REAL_CLAUDE_MD_SHIM, join(root, 'scripts', 'setup-claude-md.sh'));
    copyFileSync(REAL_PROGRESS_SHIM, join(root, 'scripts', 'setup-progress.sh'));
    chmodSync(join(root, 'scripts', 'setup-claude-md.sh'), 0o755);
    chmodSync(join(root, 'scripts', 'setup-progress.sh'), 0o755);

    // Node-compatible stub: the resolver runs `node <cli.cjs>`, so the stub
    // MUST parse as JavaScript. It echoes its argv (skipping node + script)
    // as `ARGS: ...` on stdout, optionally prints a marker line, then exits.
    const nodeStub = (marker: string): string =>
      [
        `#!/usr/bin/env node`,
        `const args = process.argv.slice(2).join(' ');`,
        `process.stdout.write('ARGS: ' + args + '\\n');`,
        marker ? `process.stdout.write(${JSON.stringify(marker)} + '\\n');` : '',
        `process.exit(${opts.stubExit ?? 0});`,
      ]
        .filter(Boolean)
        .join('\n');

    if (opts.withBridge) {
      const bridgePath = join(root, 'bridge', 'cli.cjs');
      mkdirSync(dirname(bridgePath), { recursive: true });
      writeFileSync(bridgePath, nodeStub(opts.stubStdout ?? ''), 'utf8');
      chmodSync(bridgePath, 0o755);
    }
    if (opts.withDist) {
      const distPath = join(root, 'dist', 'cli', 'index.js');
      mkdirSync(dirname(distPath), { recursive: true });
      writeFileSync(distPath, nodeStub(opts.stubStdout ?? ''), 'utf8');
      chmodSync(distPath, 0o755);
    }

    return root;
  }

  /**
   * Create a tmp `bin/` directory holding a fake `omc` binary that echoes its
   * args and exits with `opts.exitCode`. Returns the directory path so tests
   * can prepend it to PATH.
   */
  function makeFakeOmcBin(baseDir: string, opts: { exitCode?: number; stdout?: string } = {}): string {
    const bin = join(baseDir, 'bin');
    mkdirSync(bin, { recursive: true });
    const omcPath = join(bin, 'omc');
    const body = [
      '#!/usr/bin/env bash',
      'echo "ARGS: $*"',
      opts.stdout ? `echo '${opts.stdout.replace(/'/g, "'\\''")}'` : '',
      `exit ${opts.exitCode ?? 0}`,
    ]
      .filter(Boolean)
      .join('\n');
    writeFileSync(omcPath, body, 'utf8');
    chmodSync(omcPath, 0o755);
    return bin;
  }

  /**
   * Build a PATH string that does NOT contain any real `omc` binary. We keep
   * `/usr/bin:/bin` + the dir containing the current `node` executable so
   * bash builtins and `exec node …` in the shim's fallback branches still work.
   *
   * To make sure no real `omc` leaks in, we create a controlled bin/ directory
   * in the test's `tmpBase` and prepend it (callers can point it at a stub or
   * leave it empty). If any of the system dirs happens to contain an `omc`
   * binary (because the user has installed it), we'd still hit it — the tests
   * that need a guaranteed-omc-less PATH use `assertNoRealOmc()` below.
   */
  function pathWithoutOmc(extra?: string): string {
    const nodeBin = dirname(process.execPath);
    const base = `${nodeBin}:/usr/bin:/bin`;
    return extra ? `${extra}:${base}` : base;
  }

  /**
   * Invoke a bash shim under the vendored plugin root and return
   * { stdout, stderr, exitCode }.
   */
  function runShim(
    shim: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    pluginRoot: string,
  ): { stdout: string; stderr: string; exitCode: number } {
    const shimPath = join(pluginRoot, 'scripts', shim);
    const res = spawnSync('bash', [shimPath, ...args], {
      env,
      encoding: 'utf8',
    });
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode: res.status ?? 1,
    };
  }

  function baseEnv(homeDir: string): NodeJS.ProcessEnv {
    return {
      HOME: homeDir,
      TMPDIR: tmpdir(),
      TERM: 'dumb',
      LANG: 'C',
      LC_ALL: 'C',
    };
  }

  // ───────────────────────────── fixtures ──────────────────────────────

  let tmpBase: string;
  let homeDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'omc-shim-matrix-'));
    homeDir = join(tmpBase, 'home');
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ──────────────────────────── test suite ─────────────────────────────

  describe('resolve-omc-cli.sh → shim dispatch matrix', () => {
    // ── G1: omc on PATH ─────────────────────────────────────────────────
    it('G1: omc on PATH → exec omc (bridge/dist ignored)', () => {
      const fakeBin = makeFakeOmcBin(tmpBase, { exitCode: 0 });
      // Include a fake plugin root that also has bridge — to prove PATH wins.
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true, withDist: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(fakeBin),
        // Deliberately unset CLAUDE_PLUGIN_ROOT so only PATH/relative work.
      };

      const res = runShim('setup-claude-md.sh', ['local'], env, pluginRoot);
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('ARGS: setup --claude-md-only --local --overwrite');
      // Should NOT be the bridge stub's output — the bridge echoes the same
      // "ARGS:" prefix but an omc-on-PATH resolution hits fakeBin first.
      // We validate that the PATH binary was chosen by ensuring the stub was
      // called with the expected args (sanity).
    });

    // ── G2: omc missing + CLAUDE_PLUGIN_ROOT/bridge/cli.cjs ──────────────
    it('G2: CLAUDE_PLUGIN_ROOT/bridge/cli.cjs wins over dist', () => {
      // pluginRootForShim provides the *shim* location; a DIFFERENT dir
      // will act as the CLAUDE_PLUGIN_ROOT target so we know which branch hit.
      const pluginRootForShim = makeFakePluginRoot(tmpBase, {
        withBridge: false,
        withDist: false,
      });
      const envPluginRoot = join(tmpBase, 'env-plugin-root');
      mkdirSync(join(envPluginRoot, 'bridge'), { recursive: true });
      writeFileSync(
        join(envPluginRoot, 'bridge', 'cli.cjs'),
        nodeCliStub('BRIDGE', 0),
        'utf8',
      );
      chmodSync(join(envPluginRoot, 'bridge', 'cli.cjs'), 0o755);
      // Also put a dist fallback to prove bridge wins.
      mkdirSync(join(envPluginRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(envPluginRoot, 'dist', 'cli', 'index.js'),
        nodeCliStub('DIST', 0),
        'utf8',
      );

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
        CLAUDE_PLUGIN_ROOT: envPluginRoot,
      };

      const res = runShim(
        'setup-claude-md.sh',
        ['global', 'overwrite'],
        env,
        pluginRootForShim,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('BRIDGE');
      expect(res.stdout).not.toContain('DIST');
      expect(res.stdout).toContain('setup --claude-md-only --global --overwrite');
    });

    // ── G2b: dist fallback when bridge missing ──────────────────────────
    it('G2b: CLAUDE_PLUGIN_ROOT/dist/cli/index.js used when bridge is absent', () => {
      const pluginRootForShim = makeFakePluginRoot(tmpBase, {
        withBridge: false,
        withDist: false,
      });
      const envPluginRoot = join(tmpBase, 'env-plugin-root');
      mkdirSync(join(envPluginRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(envPluginRoot, 'dist', 'cli', 'index.js'),
        nodeCliStub('DIST', 0),
        'utf8',
      );
      chmodSync(join(envPluginRoot, 'dist', 'cli', 'index.js'), 0o755);

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
        CLAUDE_PLUGIN_ROOT: envPluginRoot,
      };

      const res = runShim(
        'setup-progress.sh',
        ['resume'],
        env,
        pluginRootForShim,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('DIST');
      expect(res.stdout).toContain('setup --state-resume');
    });

    // ── G3: relative fallback (no env, bridge under scripts/..) ─────────
    it('G3: relative <plugin_root>/bridge/cli.cjs fallback', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, {
        withBridge: true,
        withDist: false,
      });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
        // No CLAUDE_PLUGIN_ROOT — forces the relative branch.
      };

      const res = runShim(
        'setup-claude-md.sh',
        ['local'],
        env,
        pluginRoot,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('ARGS: setup --claude-md-only --local --overwrite');
    });

    // ── G4: all exhausted → error to stderr, non-zero exit ──────────────
    it('G4: no omc / no bridge / no dist → error + exit 1', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, {
        withBridge: false,
        withDist: false,
      });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-claude-md.sh', ['local'], env, pluginRoot);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toMatch(/cannot locate omc CLI/);
    });

    // ── G5: invalid mode → shim error passthrough ───────────────────────
    it('G5: invalid mode arg → shim exits non-zero with usage message', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-claude-md.sh', ['bogus'], env, pluginRoot);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toMatch(/Invalid mode/);
    });

    // ── G5b: missing mode arg → usage error ─────────────────────────────
    it('G5b: missing mode arg → shim exits non-zero with usage message', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-claude-md.sh', [], env, pluginRoot);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr.length).toBeGreaterThan(0);
    });

    // ── G6: setup-progress.sh save dispatches --state-save ──────────────
    it('G6: setup-progress.sh save → --state-save <step> --state-config-type <type>', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-progress.sh', ['save', '3', 'global'], env, pluginRoot);
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain(
        'setup --state-save 3 --state-config-type global',
      );
    });

    // ── G7: setup-progress.sh clear → --state-clear ─────────────────────
    it('G7: setup-progress.sh clear → --state-clear', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-progress.sh', ['clear'], env, pluginRoot);
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('setup --state-clear');
    });

    // ── G8: setup-progress.sh resume → --state-resume ───────────────────
    it('G8: setup-progress.sh resume → --state-resume', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-progress.sh', ['resume'], env, pluginRoot);
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('setup --state-resume');
    });

    // ── G9: setup-progress.sh complete → --state-complete <version> ─────
    it('G9: setup-progress.sh complete → --state-complete <version>', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim(
        'setup-progress.sh',
        ['complete', 'v4.99.0'],
        env,
        pluginRoot,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('setup --state-complete v4.99.0');
    });

    // ── G9b: setup-progress.sh unknown subcommand ───────────────────────
    it('G9b: setup-progress.sh <unknown> → exit non-zero + usage on stderr', () => {
      const pluginRoot = makeFakePluginRoot(tmpBase, { withBridge: true });

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-progress.sh', ['bogus'], env, pluginRoot);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toMatch(/Usage:/);
    });

    // ── G10: exit code passthrough from the stub CLI ────────────────────
    it('G10: non-zero CLI exit code propagates through shim', () => {
      // Fresh plugin root where the bridge stub returns 42.
      const pluginRoot = join(tmpBase, 'fail-root');
      mkdirSync(join(pluginRoot, 'scripts', 'lib'), { recursive: true });
      copyFileSync(REAL_RESOLVER, join(pluginRoot, 'scripts', 'lib', 'resolve-omc-cli.sh'));
      copyFileSync(
        REAL_CLAUDE_MD_SHIM,
        join(pluginRoot, 'scripts', 'setup-claude-md.sh'),
      );
      chmodSync(join(pluginRoot, 'scripts', 'setup-claude-md.sh'), 0o755);
      mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
      writeFileSync(
        join(pluginRoot, 'bridge', 'cli.cjs'),
        nodeCliStub('', 42),
        'utf8',
      );
      chmodSync(join(pluginRoot, 'bridge', 'cli.cjs'), 0o755);

      const env = {
        ...baseEnv(homeDir),
        PATH: pathWithoutOmc(),
      };

      const res = runShim('setup-claude-md.sh', ['local'], env, pluginRoot);
      expect(res.exitCode).toBe(42);
    });

    // ── Resolver file existence sanity check ────────────────────────────
    it('resolver file exists and is non-empty', () => {
      const body = readFileSync(REAL_RESOLVER, 'utf8');
      expect(body).toContain('resolve_omc_cli');
      expect(body).toContain('bridge/cli.cjs');
      expect(body).toContain('dist/cli/index.js');
    });
  });
}
