import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');
const PLUGIN_SETUP_PATH = join(PACKAGE_ROOT, 'scripts', 'plugin-setup.mjs');
const SOURCE_HOOKS_JSON = join(PACKAGE_ROOT, 'hooks', 'hooks.json');

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Regression test for #2348.
 *
 * Before this fix, plugin-setup.mjs unconditionally rewrote
 * <packageRoot>/hooks/hooks.json to bake in process.execPath. When the
 * GitHub Actions release workflow ran the test suite, the CI runner's
 * absolute node path (/opt/hostedtoolcache/node/20.20.2/x64/bin/node) got
 * written into the source file and shipped to every user via npm publish.
 *
 * This test verifies that running plugin-setup.mjs against a temporary
 * CLAUDE_CONFIG_DIR — and against the real cwd of the package source —
 * leaves <packageRoot>/hooks/hooks.json byte-identical.
 */
describe('plugin-setup.mjs must never mutate source hooks/hooks.json (#2348)', () => {
  it('leaves <repo>/hooks/hooks.json byte-identical after end-to-end run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'plugin-setup-immut-'));
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });

    // Seed a fake plugin cache containing a hooks.json with the broken absolute path
    const cacheRoot = join(tmp, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.11.1');
    mkdirSync(join(cacheRoot, 'hooks'), { recursive: true });
    const fakeHooksJson = join(cacheRoot, 'hooks', 'hooks.json');
    writeFileSync(
      fakeHooksJson,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command:
                    '"/opt/hostedtoolcache/node/20.20.2/x64/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/pre-tool-use.mjs',
                },
              ],
            },
          ],
        },
      }),
    );

    const before = sha(SOURCE_HOOKS_JSON);
    try {
      execFileSync(process.execPath, [PLUGIN_SETUP_PATH], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: tmp,
          HOME: fakeHome,
        },
        stdio: 'pipe',
      });

      const after = sha(SOURCE_HOOKS_JSON);
      expect(after).toBe(before);

      // The fake plugin cache copy SHOULD have been patched (sanity check)
      const patched = JSON.parse(readFileSync(fakeHooksJson, 'utf-8')) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = patched.hooks.PreToolUse[0].hooks[0].command;
      expect(command).not.toContain('/opt/hostedtoolcache/');
      expect(command.startsWith(`"${process.execPath}" `)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to write when the plugin cache version dir is a symlink into the package source', () => {
    // Architect-flagged bypass: when ~/.claude/plugins/cache/omc/oh-my-claudecode/<v>
    // is a symlink that resolves back into the dev repo, the source guard
    // must follow the symlink and refuse the write. Pure resolve()-based
    // containment is symlink-blind and would allow corruption.
    const tmp = mkdtempSync(join(tmpdir(), 'plugin-setup-symlink-'));
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });

    const cacheParent = join(tmp, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    mkdirSync(cacheParent, { recursive: true });
    // The version dir IS a symlink into the package source — this is the
    // exact bypass scenario.
    symlinkSync(PACKAGE_ROOT, join(cacheParent, '4.11.1'));

    const before = sha(SOURCE_HOOKS_JSON);
    try {
      execFileSync(process.execPath, [PLUGIN_SETUP_PATH], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: tmp,
          HOME: fakeHome,
        },
        stdio: 'pipe',
      });

      const after = sha(SOURCE_HOOKS_JSON);
      expect(after).toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
