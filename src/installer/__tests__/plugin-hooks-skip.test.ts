/**
 * Tests for plugin-detection hook skip + duplicate-cleanup behavior.
 *
 * Behavior under test (tasks 1-6):
 *   1. When `--plugin-dir-mode` is set AND the plugin root has hooks/hooks.json,
 *      install() must NOT copy hook scripts to $CONFIG_DIR/hooks/.
 *   2. In the same case, install() must NOT write OMC hook entries to settings.json.
 *   3. When an installed_plugins.json marketplace manifest lists a plugin that
 *      ships hooks/hooks.json, the same skip applies.
 *   4. When plugin is active and leftover standalone hooks exist, they are pruned.
 *   5. When plugin is active and settings.json has OMC hook entries, they are stripped
 *      while preserving user-authored hooks.
 *
 * Tests run install() against throwaway tmpdirs. Module imports are reset between
 * tests so each call picks up the isolated CLAUDE_CONFIG_DIR.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAVED_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'] as const;
type EnvKey = (typeof SAVED_ENV_KEYS)[number];

let tmpConfigDir: string;
let tmpPluginRoot: string;
let savedEnv: Record<EnvKey, string | undefined>;

async function freshInstaller() {
  vi.resetModules();
  return await import('../index.js');
}

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'omc-plugin-hooks-config-'));
  // Place the plugin root under <configDir>/plugins/ so isProjectScopedPlugin()
  // returns false (global plugin). isProjectScopedPlugin() returns true when
  // CLAUDE_PLUGIN_ROOT is NOT under CLAUDE_CONFIG_DIR/plugins/, which would
  // cause the settings.json block to be skipped entirely.
  const pluginsDir = join(tmpConfigDir, 'plugins', 'oh-my-claudecode');
  mkdirSync(pluginsDir, { recursive: true });
  tmpPluginRoot = pluginsDir;

  // Create a fake plugin root with hooks/hooks.json
  mkdirSync(join(tmpPluginRoot, 'hooks'), { recursive: true });
  writeFileSync(
    join(tmpPluginRoot, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: {} }),
    'utf8',
  );

  savedEnv = {} as Record<EnvKey, string | undefined>;
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  // tmpPluginRoot is under tmpConfigDir, so this covers both.
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

const OMC_HOOK_FILES = [
  'keyword-detector.mjs',
  'session-start.mjs',
  'persistent-mode.mjs',
  'pre-tool-use.mjs',
  'post-tool-use.mjs',
  'post-tool-use-failure.mjs',
  'code-simplifier.mjs',
  'stop-continuation.mjs',
];

function getHooksInDir(hooksDir: string): string[] {
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir);
}

// ---------------------------------------------------------------------------
// Test 7a: plugin-dir-mode skips standalone hooks
// ---------------------------------------------------------------------------

describe('install() — plugin-dir-mode skips standalone hooks', () => {
  it('does NOT copy hook files to <configDir>/hooks/ when --plugin-dir-mode is set', async () => {
    process.env.OMC_PLUGIN_ROOT = tmpPluginRoot;
    process.env.CLAUDE_PLUGIN_ROOT = tmpPluginRoot;

    const { install } = await freshInstaller();
    const result = install({
      verbose: false,
      skipClaudeCheck: true,
      force: true,
      pluginDirMode: true,
    });

    expect(result.success).toBe(true);

    const hooksDir = join(tmpConfigDir, 'hooks');
    const files = getHooksInDir(hooksDir);
    const omcFiles = files.filter((f) => OMC_HOOK_FILES.includes(f));
    expect(omcFiles, 'no OMC hook files should be copied in plugin-dir-mode').toHaveLength(0);
  });

  it('does NOT write OMC hook entries to settings.json in plugin-dir-mode', async () => {
    process.env.OMC_PLUGIN_ROOT = tmpPluginRoot;
    process.env.CLAUDE_PLUGIN_ROOT = tmpPluginRoot;

    const { install } = await freshInstaller();
    install({
      verbose: false,
      skipClaudeCheck: true,
      force: true,
      pluginDirMode: true,
    });

    const settingsPath = join(tmpConfigDir, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };

      if (settings.hooks) {
        for (const groups of Object.values(settings.hooks)) {
          for (const group of groups) {
            for (const h of group.hooks) {
              expect(h.command).not.toMatch(
                /keyword-detector|persistent-mode|session-start|pre-tool-use/,
              );
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7b: marketplace plugin detected → same outcome
// ---------------------------------------------------------------------------

describe('install() — marketplace plugin skips standalone hooks', () => {
  it('does NOT copy hooks when installed_plugins.json lists an OMC plugin with hooks.json', async () => {
    // Create installed_plugins.json manifest
    mkdirSync(join(tmpConfigDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'oh-my-claudecode@4.11.4': [
            { installPath: tmpPluginRoot },
          ],
        },
      }),
      'utf8',
    );

    const { install } = await freshInstaller();
    install({
      verbose: false,
      skipClaudeCheck: true,
      force: true,
    });

    const hooksDir = join(tmpConfigDir, 'hooks');
    const files = getHooksInDir(hooksDir);
    const omcFiles = files.filter((f) => OMC_HOOK_FILES.includes(f));
    expect(omcFiles, 'no OMC hook files should be copied when marketplace plugin is active').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7c: duplicate cleanup — leftovers are pruned when plugin is active
// ---------------------------------------------------------------------------

describe('install() — plugin active prunes leftover standalone hooks', () => {
  it('removes pre-existing $CONFIG_DIR/hooks/*.mjs when plugin provides hooks', async () => {
    // Seed the config dir with leftover standalone hook files (as if the
    // user ran omc setup pre-plugin-install)
    const hooksDir = join(tmpConfigDir, 'hooks');
    const hooksLib = join(hooksDir, 'lib');
    mkdirSync(hooksLib, { recursive: true });

    const leftoverHooks = [
      'keyword-detector.mjs',
      'session-start.mjs',
      'persistent-mode.mjs',
      'pre-tool-use.mjs',
      'post-tool-use.mjs',
    ];
    for (const name of leftoverHooks) {
      writeFileSync(join(hooksDir, name), '// stale omc hook\n', 'utf8');
    }
    writeFileSync(join(hooksLib, 'config-dir.mjs'), '// stale\n', 'utf8');

    // Activate plugin mode — CLAUDE_PLUGIN_ROOT is used by getInstalledOmcPluginRoots
    // to detect whether a plugin ships hooks/hooks.json.
    process.env.CLAUDE_PLUGIN_ROOT = tmpPluginRoot;

    const { install } = await freshInstaller();
    install({
      verbose: false,
      skipClaudeCheck: true,
      force: true,
      pluginDirMode: true,
    });

    // Leftover hooks should be removed
    for (const name of leftoverHooks) {
      expect(existsSync(join(hooksDir, name)), `${name} should be pruned`).toBe(false);
    }

    // Leftover hooks/lib/ file should also be pruned
    expect(existsSync(join(hooksLib, 'config-dir.mjs'))).toBe(false);
  });

  it('removes OMC hook entries from settings.json when plugin is active', async () => {
    // Seed settings.json with OMC hook entries pointing at $CONFIG_DIR/hooks/
    const settingsPath = join(tmpConfigDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: `node ${tmpConfigDir}/hooks/keyword-detector.mjs` },
              ],
            },
          ],
          SessionStart: [
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: `node ${tmpConfigDir}/hooks/session-start.mjs` },
              ],
            },
          ],
          // A user-authored hook that must survive
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '/usr/local/bin/my-audit.sh' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    process.env.CLAUDE_PLUGIN_ROOT = tmpPluginRoot;

    const { install } = await freshInstaller();
    install({
      verbose: false,
      skipClaudeCheck: true,
      force: true,
      pluginDirMode: true,
    });

    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    const allCommands: string[] = [];
    for (const groups of Object.values(after.hooks ?? {})) {
      for (const group of groups) {
        for (const h of group.hooks) allCommands.push(h.command);
      }
    }

    // OMC hook entries gone
    expect(allCommands.some((c) => c.includes('keyword-detector'))).toBe(false);
    expect(allCommands.some((c) => c.includes('session-start'))).toBe(false);

    // User hook survives
    expect(allCommands.some((c) => c.includes('my-audit.sh'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7d: pruneStandaloneDuplicatesForPluginMode composite helper
// ---------------------------------------------------------------------------

describe('pruneStandaloneDuplicatesForPluginMode — already-configured path', () => {
  it('runs all three prunes + settings.json strip when called directly', async () => {
    // Fake plugin root with all three delivery surfaces
    mkdirSync(join(tmpPluginRoot, 'agents'), { recursive: true });
    writeFileSync(join(tmpPluginRoot, 'agents', 'executor.md'), '---\nname: executor\n---\n', 'utf8');
    mkdirSync(join(tmpPluginRoot, 'skills', 'ralph'), { recursive: true });
    writeFileSync(join(tmpPluginRoot, 'skills', 'ralph', 'SKILL.md'), '---\nname: ralph\n---\n', 'utf8');
    // hooks/hooks.json already created in the beforeEach

    // Seed installed_plugins.json pointing at the fake plugin
    mkdirSync(join(tmpConfigDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'oh-my-claudecode@4.11.4': [{ installPath: tmpPluginRoot }],
        },
      }),
      'utf8',
    );

    // Seed leftover standalone agents — content must have OMC frontmatter so
    // the ownership check inside prunePluginDuplicateAgents accepts it.
    mkdirSync(join(tmpConfigDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpConfigDir, 'agents', 'executor.md'), '---\nname: executor\n---\nstale content\n', 'utf8');

    // Seed leftover standalone skills
    mkdirSync(join(tmpConfigDir, 'skills', 'ralph'), { recursive: true });
    writeFileSync(
      join(tmpConfigDir, 'skills', 'ralph', 'SKILL.md'),
      '---\nname: ralph\n---\n',
      'utf8',
    );

    // Seed leftover standalone hook
    mkdirSync(join(tmpConfigDir, 'hooks'), { recursive: true });
    writeFileSync(join(tmpConfigDir, 'hooks', 'keyword-detector.mjs'), '// stale\n', 'utf8');

    // Seed settings.json with an OMC hook entry
    writeFileSync(
      join(tmpConfigDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            matcher: '*',
            hooks: [{ type: 'command', command: `node ${tmpConfigDir}/hooks/keyword-detector.mjs` }],
          }],
        },
      }),
      'utf8',
    );

    vi.resetModules();
    const { pruneStandaloneDuplicatesForPluginMode } = await import('../index.js');
    const result = pruneStandaloneDuplicatesForPluginMode(() => {});

    expect(result.prunedAgents.length, 'should prune at least 1 agent').toBeGreaterThanOrEqual(1);
    expect(result.prunedSkills.length, 'should prune at least 1 skill').toBeGreaterThanOrEqual(1);
    expect(result.prunedHooks.length, 'should prune at least 1 hook').toBeGreaterThanOrEqual(1);
    expect(result.settingsStripped, 'settings.json OMC hooks should be stripped').toBe(true);

    // Verify filesystem
    expect(existsSync(join(tmpConfigDir, 'agents', 'executor.md')), 'agent pruned').toBe(false);
    expect(existsSync(join(tmpConfigDir, 'skills', 'ralph', 'SKILL.md')), 'skill pruned').toBe(false);
    expect(existsSync(join(tmpConfigDir, 'hooks', 'keyword-detector.mjs')), 'hook pruned').toBe(false);

    const settingsAfter = JSON.parse(readFileSync(join(tmpConfigDir, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
    expect(settingsAfter.hooks === undefined || Object.keys(settingsAfter.hooks).length === 0).toBe(true);
  });

  it('is a no-op when no plugin is active', async () => {
    // No installed_plugins.json, no OMC_PLUGIN_ROOT, no plugin files
    vi.resetModules();
    const { pruneStandaloneDuplicatesForPluginMode } = await import('../index.js');
    const result = pruneStandaloneDuplicatesForPluginMode(() => {});

    expect(result.prunedAgents).toHaveLength(0);
    expect(result.prunedSkills).toHaveLength(0);
    expect(result.prunedHooks).toHaveLength(0);
    expect(result.settingsStripped).toBe(false);
  });
});
