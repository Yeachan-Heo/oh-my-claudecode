/**
 * skill-omc-setup.e2e: single smoke test for the CLI chain the `omc-setup`
 * skill performs at runtime.
 *
 * We do NOT test the LLM's interpretation of the SKILL.md instructions —
 * that is not a reproducible target. What we DO test is that the deterministic
 * pipeline the skill delegates to actually works end-to-end:
 *
 *   1. `omc setup --check-state`          → emits a single JSON line on stdout.
 *   2. Skill writes an AnswersFile JSON.
 *   3. `omc setup --build-preset --answers <in> --out <out>`
 *                                         → writes a valid preset JSON on disk.
 *   4. `omc setup --preset <file>`        → exit 0 (dry run).
 *
 * Step 4 is invoked with `--quiet` and an isolated HOME/configDir so it does
 * not mutate the developer's real ~/.claude. We only assert that the CLI
 * returns exit 0 — the per-phase behavior is exhaustively covered by the
 * integration/parity tests. This test exists to catch wire-up regressions
 * where the three subcommands stop agreeing on their file contract.
 *
 * Skipped on Windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform === 'win32') {
  describe.skip('skill-omc-setup.e2e (Windows — bash unavailable)', () => {
    it('TODO', () => {});
  });
} else {
  const REPO_ROOT = resolve(__dirname, '../../..');
  const CLI_ENTRY = join(REPO_ROOT, 'bridge', 'cli.cjs');

  /**
   * Spawn the bundled CLI with an isolated HOME/env. Returns stdout/stderr
   * plus the exit code.
   */
  function runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): { stdout: string; stderr: string; exitCode: number } {
    const res = spawnSync('node', [CLI_ENTRY, 'setup', ...args], {
      env,
      encoding: 'utf8',
    });
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode: res.status ?? 1,
    };
  }

  function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
    return {
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TERM: 'dumb',
      LANG: 'C',
      LC_ALL: 'C',
      // Prevent the installer from touching real plugin state on the host.
      OMC_SKIP_HOOKS: '1',
    };
  }

  let tmpBase: string;
  let homeDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'omc-skill-e2e-'));
    homeDir = join(tmpBase, 'home');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('omc-setup skill CLI chain', () => {
    it('check-state → build-preset → preset: writes validated preset and runs it', () => {
      const env = isolatedEnv(homeDir);

      // ── Step 1: --check-state ────────────────────────────────────────
      const check = runCli(['--check-state'], env);
      expect(check.exitCode, `stderr: ${check.stderr}`).toBe(0);
      // The last non-empty line of stdout is the JSON payload.
      const lines = check.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      expect(lastLine, `full stdout: ${check.stdout}`).toBeDefined();
      const parsed = JSON.parse(lastLine!) as {
        alreadyConfigured: boolean;
        setupVersion?: string;
        resumeStep?: number;
      };
      expect(typeof parsed.alreadyConfigured).toBe('boolean');
      // Fresh isolated HOME → no prior config.
      expect(parsed.alreadyConfigured).toBe(false);

      // ── Step 2: write the answers file the skill would build ────────
      const answersPath = join(tmpBase, 'answers.json');
      const presetPath = join(tmpBase, 'preset.json');
      const answers = {
        target: 'local',
        installStyle: 'overwrite',
        executionMode: 'ultrawork',
        installCli: false,
        taskTool: 'builtin',
        mcp: { enabled: false },
        teams: { enabled: false },
        starRepo: false,
      };
      writeFileSync(answersPath, JSON.stringify(answers), 'utf8');

      // ── Step 3: --build-preset ───────────────────────────────────────
      const build = runCli(
        ['--build-preset', '--answers', answersPath, '--out', presetPath],
        env,
      );
      expect(build.exitCode, `stderr: ${build.stderr}`).toBe(0);
      expect(existsSync(presetPath)).toBe(true);

      const preset = JSON.parse(readFileSync(presetPath, 'utf8')) as {
        target?: string;
        installStyle?: string;
        phases?: string[];
      };
      expect(preset.target).toBe('local');
      expect(preset.installStyle).toBe('overwrite');
      // Preset must request at least one real phase so --preset actually
      // runs something meaningful.
      expect(Array.isArray(preset.phases)).toBe(true);
      expect(preset.phases!.length).toBeGreaterThan(0);

      // ── Step 4: --preset (execute) ───────────────────────────────────
      // `--quiet` suppresses header output, `--no-plugin` keeps us from
      // touching a real plugin tree. We only care that the CLI accepted
      // the preset and exited 0.
      const exec = runCli(
        ['--preset', presetPath, '--quiet', '--no-plugin'],
        env,
      );
      expect(
        exec.exitCode,
        `preset run failed — stdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
      ).toBe(0);
    });

    it('--build-preset rejects invalid answers with non-zero exit', () => {
      const env = isolatedEnv(homeDir);

      const answersPath = join(tmpBase, 'bad-answers.json');
      const presetPath = join(tmpBase, 'bad-preset.json');
      // teams.agentCount = 4 is invalid (must be 2, 3, or 5).
      writeFileSync(
        answersPath,
        JSON.stringify({
          teams: { enabled: true, agentCount: 4 },
        }),
        'utf8',
      );

      const build = runCli(
        ['--build-preset', '--answers', answersPath, '--out', presetPath],
        env,
      );
      expect(build.exitCode).not.toBe(0);
      expect(existsSync(presetPath)).toBe(false);
      expect(build.stderr.toLowerCase()).toMatch(/agentcount|invalid|teams/);
    });
  });
}
