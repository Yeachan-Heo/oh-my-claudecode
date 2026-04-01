import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const originalHome = process.env.HOME;

let testClaudeDir: string;
let testHomeDir: string;

async function loadInstaller() {
  vi.resetModules();
  return import('../index.js');
}

describe('install() standalone hook reconciliation', () => {
  beforeEach(() => {
    testClaudeDir = mkdtempSync(join(tmpdir(), 'omc-standalone-hooks-'));
    testHomeDir = mkdtempSync(join(tmpdir(), 'omc-home-'));
    mkdirSync(testHomeDir, { recursive: true });
    writeFileSync(join(testHomeDir, 'CLAUDE.md'), '# test home claude');
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
    process.env.HOME = testHomeDir;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(testClaudeDir, { recursive: true, force: true });
    rmSync(testHomeDir, { recursive: true, force: true });
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    if (originalPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('restores OMC settings hooks for standalone installs during forced reconciliation', async () => {
    const settingsPath = join(testClaudeDir, 'settings.json');
    mkdirSync(testClaudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    const { install } = await loadInstaller();
    const result = install({
      force: true,
      skipClaudeCheck: true,
    });

    const writtenSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    expect(result.success).toBe(true);
    expect(result.hooksConfigured).toBe(true);
    expect(writtenSettings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(
      `node "${join(testClaudeDir, 'hooks', 'keyword-detector.mjs').replace(/\\/g, '/')}"`,
    );
    expect(writtenSettings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      `node "${join(testClaudeDir, 'hooks', 'session-start.mjs').replace(/\\/g, '/')}"`,
    );
    expect((writtenSettings as { statusLine?: { command?: string } }).statusLine?.command).toContain(
      `${join(testClaudeDir, 'hud', 'omc-hud.mjs').replace(/\\/g, '/')}`,
    );
    expect(readFileSync(join(testClaudeDir, 'hooks', 'keyword-detector.mjs'), 'utf-8')).toContain('Ralph keywords');
    expect(readFileSync(join(testClaudeDir, 'hooks', 'pre-tool-use.mjs'), 'utf-8')).toContain('PreToolUse');
    expect(readFileSync(join(testClaudeDir, 'hooks', 'code-simplifier.mjs'), 'utf-8')).toContain('Code Simplifier');
  });

  it('preserves non-OMC ~/.claude/hooks commands while adding standalone OMC hooks', async () => {
    const settingsPath = join(testClaudeDir, 'settings.json');
    mkdirSync(testClaudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
              },
            ],
          },
        ],
      },
    }, null, 2));

    const { install } = await loadInstaller();
    const result = install({
      force: true,
      skipClaudeCheck: true,
    });

    const writtenSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = writtenSettings.hooks.UserPromptSubmit.map(group => group.hooks[0]?.command);

    expect(result.success).toBe(true);
    expect(commands).toContain('node $HOME/.claude/hooks/other-plugin.mjs');
    expect(commands).toContain(
      `node "${join(testClaudeDir, 'hooks', 'keyword-detector.mjs').replace(/\\/g, '/')}"`,
    );
  });
});
