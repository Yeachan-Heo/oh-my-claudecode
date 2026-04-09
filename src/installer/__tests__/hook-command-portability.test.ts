/**
 * Hook Command Portability Tests (Contracts 7-8)
 *
 * Guards against issues #2084 and #2348:
 *   - Hook commands must work across environments (no hardcoded home dirs)
 *   - Hook commands must not contain absolute node binary paths
 *   - Hook commands must reference files that actually exist in templates
 *
 * Tests the exported getHooksSettingsConfig() function which is the public API
 * for standalone hook configuration. Uses vi.resetModules() + dynamic import
 * because HOOKS_SETTINGS_CONFIG_NODE is a module-level constant evaluated at
 * import time based on CLAUDE_CONFIG_DIR.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

// ── Contract 7: getHooksSettingsConfig() generates portable hook commands ─────

describe('Contract 7: hook command portability (#2084, #2348)', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalPlatform = process.platform;

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
  });

  it('default config: commands use ${CLAUDE_CONFIG_DIR:-$HOME/.claude} pattern', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    const commands: string[] = [];
    for (const eventHooks of Object.values(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          commands.push(hook.command);
        }
      }
    }

    expect(commands.length).toBeGreaterThan(0);

    // On default config, all commands should use the portable env-var pattern
    for (const cmd of commands) {
      expect(cmd).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
    }
  });

  it('no command contains an absolute path to a node binary', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    // Regex: command starts with an absolute path to node binary
    // e.g., /opt/hostedtoolcache/node/20.20.2/x64/bin/node
    // e.g., /usr/local/bin/node
    const absoluteNodePattern = /^["']?\/[^\s"']*node["']?\s/;
    const violations: { event: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          if (absoluteNodePattern.test(hook.command)) {
            violations.push({ event: eventType, command: hook.command });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
      expect.fail(
        `Found absolute node binary paths in hook commands (issue #2348 regression):\n${details}\n\n` +
        `Hook commands must use bare 'node', not resolved absolute paths like /opt/hostedtoolcache/...`
      );
    }
  });

  it('no command contains a hardcoded home directory path', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    // Pattern: hardcoded /home/username or /Users/username paths
    const hardcodedHomePattern = /\/(?:home|Users)\/[a-zA-Z0-9_-]+\//;
    const violations: { event: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          if (hardcodedHomePattern.test(hook.command)) {
            violations.push({ event: eventType, command: hook.command });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
      expect.fail(
        `Found hardcoded home directory paths in hook commands:\n${details}\n\n` +
        `Hook commands must use $HOME or \${CLAUDE_CONFIG_DIR:-$HOME/.claude}, not resolved absolute home paths.`
      );
    }
  });

  it('custom config: commands use the custom absolute path', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude-test-config';
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    const commands: string[] = [];
    for (const eventHooks of Object.values(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          commands.push(hook.command);
        }
      }
    }

    expect(commands.length).toBeGreaterThan(0);

    // With custom config dir, commands should reference the custom path
    for (const cmd of commands) {
      expect(cmd).toContain('/tmp/custom-claude-test-config/hooks/');
    }
  });

  it('Windows default config: avoids CMD-only %USERPROFILE% and keeps portable bash-style expansion', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    const commands: string[] = [];
    for (const eventHooks of Object.values(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          commands.push(hook.command);
        }
      }
    }

    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(cmd).not.toContain('%USERPROFILE%');
    }
  });
});

// ── Contract 8: Hook config commands reference known OMC hook filenames ───────

describe('Contract 8: hook commands reference existing template files', () => {
  it('all hook commands reference files that exist in templates/hooks/', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();

    const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
    const config = getHooksSettingsConfig();

    const templatesDir = join(REPO_ROOT, 'templates', 'hooks');
    expect(existsSync(templatesDir)).toBe(true);

    const templateFiles = new Set(readdirSync(templatesDir));

    // Extract filenames from hook commands
    const filenamePattern = /([a-z0-9-]+\.mjs)(?:$|["'\s])/;
    const missingFiles: { event: string; filename: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          const match = hook.command.match(filenamePattern);
          if (match) {
            const filename = match[1];
            if (!templateFiles.has(filename)) {
              missingFiles.push({ event: eventType, filename, command: hook.command });
            }
          }
        }
      }
    }

    if (missingFiles.length > 0) {
      const details = missingFiles
        .map(v => `  ${v.event}: ${v.filename} (command: ${v.command})`)
        .join('\n');
      expect.fail(
        `Hook commands reference files not found in templates/hooks/:\n${details}\n\n` +
        `Ensure all referenced hook scripts exist in templates/hooks/.`
      );
    }
  });
});
