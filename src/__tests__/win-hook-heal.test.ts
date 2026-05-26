/**
 * Tests for the run.cjs Windows hook-manifest self-heal (issue #3121).
 *
 * On a fresh native-Windows marketplace install neither setup-time rewriter
 * runs (no npm postinstall; the SessionStart:init hook that would trigger the
 * rewrite is itself shipped in the broken sh form), so Claude Code reads the
 * unpatched hooks.json directly and every hook fails with
 * `/usr/bin/sh: cannot execute binary file`. run.cjs — reached on Windows via
 * the SessionEnd hook, the only command shipped in `node ... run.cjs` form —
 * heals the manifest by rewriting the sh/find-node.sh bootstrap to the direct
 * `node ... run.cjs` form.
 *
 * The rewrite itself is platform-neutral (the win32 guard lives in run.cjs), so
 * these tests exercise it on any OS, matching windows-patch.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');

const require = createRequire(import.meta.url);
const { healWindowsHookManifest, rewriteCommand } = require(
  join(repoRoot, 'scripts', 'lib', 'win-hook-heal.cjs'),
) as {
  healWindowsHookManifest: (pluginRoot: string) => boolean;
  rewriteCommand: (command: unknown) => string | null;
};

/** Minimal hooks.json structure matching the plugin's format. */
function makeHooksJson(commands: string[]): object {
  return {
    description: 'test',
    hooks: {
      UserPromptSubmit: commands.map(command => ({
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: 5 }],
      })),
    },
  };
}

describe('healWindowsHookManifest', () => {
  let pluginRoot: string;
  let hooksDir: string;
  let hooksJsonPath: string;

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'omc-win-heal-'));
    hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    hooksJsonPath = join(hooksDir, 'hooks.json');
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('rewrites the current sh+find-node+run.cjs command to the run.cjs wrapper', () => {
    const original = makeHooksJson([
      'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/post-tool-verifier.mjs',
    ]);
    writeFileSync(hooksJsonPath, JSON.stringify(original, null, 2));

    expect(healWindowsHookManifest(pluginRoot)).toBe(true);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(patched.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/post-tool-verifier.mjs',
    );
  });

  it('rewrites the quoted /bin/sh cache form and preserves trailing arguments', () => {
    const original = makeHooksJson([
      '"/bin/sh" "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/subagent-tracker.mjs start',
    ]);
    writeFileSync(hooksJsonPath, JSON.stringify(original, null, 2));

    expect(healWindowsHookManifest(pluginRoot)).toBe(true);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(patched.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/subagent-tracker.mjs start',
    );
  });

  it('rewrites the legacy ${CLAUDE_PLUGIN_ROOT} find-node form', () => {
    const original = makeHooksJson([
      'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"',
    ]);
    writeFileSync(hooksJsonPath, JSON.stringify(original, null, 2));

    expect(healWindowsHookManifest(pluginRoot)).toBe(true);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(patched.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/keyword-detector.mjs',
    );
  });

  it('is idempotent — already-healed manifests are left untouched and not rewritten', () => {
    const already = makeHooksJson([
      'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/keyword-detector.mjs',
    ]);
    const json = JSON.stringify(already, null, 2);
    writeFileSync(hooksJsonPath, json);

    expect(healWindowsHookManifest(pluginRoot)).toBe(false);
    expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(json);
  });

  it('heals every sh/find-node command in the bundled manifest while leaving SessionEnd node commands intact', () => {
    copyFileSync(join(repoRoot, 'hooks', 'hooks.json'), hooksJsonPath);

    expect(healWindowsHookManifest(pluginRoot)).toBe(true);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };
    const commands = Object.entries(patched.hooks).flatMap(([event, groups]) =>
      groups.flatMap(group =>
        group.hooks
          .map(hook => hook.command)
          .filter((command): command is string => typeof command === 'string')
          .map(command => ({ event, command })),
      ),
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const { event, command } of commands) {
      expect(command, event).toMatch(/^node "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs /);
      expect(command, event).not.toContain('find-node.sh');
      expect(command, event).not.toContain('/bin/sh');
      expect(command, event).not.toMatch(/^sh /);
    }
    // SessionEnd already shipped in node form — it must survive unchanged.
    expect(commands.some(({ event }) => event === 'SessionEnd')).toBe(true);

    // Second pass is a no-op once the manifest is clean.
    expect(healWindowsHookManifest(pluginRoot)).toBe(false);
  });

  it('returns false (no throw) when hooks.json does not exist', () => {
    expect(() => healWindowsHookManifest(pluginRoot)).not.toThrow();
    expect(healWindowsHookManifest(pluginRoot)).toBe(false);
  });

  it('returns false when pluginRoot is empty', () => {
    expect(healWindowsHookManifest('')).toBe(false);
  });
});

describe('rewriteCommand', () => {
  it('returns null for non-matching or non-string commands', () => {
    expect(rewriteCommand('node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/x.mjs')).toBeNull();
    expect(rewriteCommand('echo hi')).toBeNull();
    expect(rewriteCommand(undefined)).toBeNull();
    expect(rewriteCommand(42)).toBeNull();
  });
});
