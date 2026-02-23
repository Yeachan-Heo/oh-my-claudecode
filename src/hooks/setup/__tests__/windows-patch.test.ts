/**
 * Tests for patchHooksJsonForWindows (issue #899)
 *
 * Verifies that the Windows hook-patching logic correctly rewrites
 * sh+find-node.sh commands to direct `node` invocations so that
 * Claude Code UI bug #17088 (false "hook error" labels on MSYS2/Git Bash)
 * is avoided.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { patchHooksJsonForWindows } from '../index.js';

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

describe('patchHooksJsonForWindows', () => {
  let pluginRoot: string;
  let hooksDir: string;
  let hooksJsonPath: string;

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'omc-win-patch-'));
    hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    hooksJsonPath = join(hooksDir, 'hooks.json');
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('replaces sh+find-node.sh with direct node for a simple script', () => {
    const original = makeHooksJson([
      'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"',
    ]);
    writeFileSync(hooksJsonPath, JSON.stringify(original, null, 2));

    patchHooksJsonForWindows(pluginRoot);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const cmd = patched.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toBe('node "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"');
  });

  it('preserves trailing arguments (e.g. subagent-tracker start)', () => {
    const original = makeHooksJson([
      'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-tracker.mjs" start',
    ]);
    writeFileSync(hooksJsonPath, JSON.stringify(original, null, 2));

    patchHooksJsonForWindows(pluginRoot);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const cmd = patched.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toBe('node "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-tracker.mjs" start');
  });

  it('is idempotent — already-patched commands are not double-modified', () => {
    const already = makeHooksJson([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"',
    ]);
    const json = JSON.stringify(already, null, 2);
    writeFileSync(hooksJsonPath, json);

    patchHooksJsonForWindows(pluginRoot);

    // File should be unchanged (no write occurred)
    expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(json);
  });

  it('patches all hooks across multiple event types', () => {
    const data = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command:
                  'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"',
              },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command:
                  'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"',
              },
            ],
          },
        ],
      },
    };
    writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2));

    patchHooksJsonForWindows(pluginRoot);

    const patched = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    expect(patched.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"'
    );
    expect(patched.hooks.SessionStart[0].hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"'
    );
  });

  it('is a no-op when hooks.json does not exist', () => {
    // Should not throw
    expect(() => patchHooksJsonForWindows(pluginRoot)).not.toThrow();
  });

  it('is a no-op when pluginRoot does not exist', () => {
    expect(() =>
      patchHooksJsonForWindows(join(tmpdir(), 'nonexistent-plugin-root-xyz'))
    ).not.toThrow();
  });
});
