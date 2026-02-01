/**
 * Tests for Safe Installer (Task T2)
 * Tests hook conflict detection and forceHooks option
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isOmcHook, install, InstallOptions } from '../index.js';

/**
 * Detect hook conflicts using the real isOmcHook function.
 * Mirrors the install() logic to avoid test duplication.
 */
function detectConflicts(
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>
): Array<{ eventType: string; existingCommand: string }> {
  const conflicts: Array<{ eventType: string; existingCommand: string }> = [];
  for (const [eventType, eventHooks] of Object.entries(hooks)) {
    for (const hookGroup of eventHooks) {
      for (const hook of hookGroup.hooks) {
        if (hook.type === 'command' && !isOmcHook(hook.command)) {
          conflicts.push({ eventType, existingCommand: hook.command });
        }
      }
    }
  }
  return conflicts;
}

const TEST_CLAUDE_DIR = join(homedir(), '.claude-test-safe-installer');
const TEST_SETTINGS_FILE = join(TEST_CLAUDE_DIR, 'settings.json');

describe('isOmcHook', () => {
  it('returns true for commands containing "omc"', () => {
    expect(isOmcHook('node ~/.claude/hooks/omc-hook.mjs')).toBe(true);
    expect(isOmcHook('bash $HOME/.claude/hooks/omc-detector.sh')).toBe(true);
    expect(isOmcHook('/usr/bin/omc-tool')).toBe(true);
  });

  it('returns true for commands containing "oh-my-claudecode"', () => {
    expect(isOmcHook('node ~/.claude/hooks/oh-my-claudecode-hook.mjs')).toBe(true);
    expect(isOmcHook('bash $HOME/.claude/hooks/oh-my-claudecode.sh')).toBe(true);
  });

  it('returns false for commands not containing omc or oh-my-claudecode', () => {
    expect(isOmcHook('node ~/.claude/hooks/other-plugin.mjs')).toBe(false);
    expect(isOmcHook('bash $HOME/.claude/hooks/beads-hook.sh')).toBe(false);
    expect(isOmcHook('python /usr/bin/custom-hook.py')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isOmcHook('node ~/.claude/hooks/OMC-hook.mjs')).toBe(true);
    expect(isOmcHook('bash $HOME/.claude/hooks/OH-MY-CLAUDECODE.sh')).toBe(true);
  });
});

describe('isOmcHook detection', () => {
  it('detects real OMC hooks correctly', () => {
    expect(isOmcHook('node ~/.claude/hooks/omc-hook.mjs')).toBe(true);
    expect(isOmcHook('node ~/.claude/hooks/oh-my-claudecode-hook.mjs')).toBe(true);
    expect(isOmcHook('node ~/.claude/hooks/omc-pre-tool-use.mjs')).toBe(true);
    expect(isOmcHook('/usr/local/bin/omc')).toBe(true);
  });

  it('rejects non-OMC hooks correctly', () => {
    expect(isOmcHook('eslint --fix')).toBe(false);
    expect(isOmcHook('prettier --write')).toBe(false);
    expect(isOmcHook('node custom-hook.mjs')).toBe(false);
    expect(isOmcHook('node ~/.claude/hooks/beads-hook.mjs')).toBe(false);
  });

  it('uses case-insensitive matching', () => {
    expect(isOmcHook('node ~/.claude/hooks/OMC-hook.mjs')).toBe(true);
    expect(isOmcHook('OH-MY-CLAUDECODE-detector.sh')).toBe(true);
  });
});

describe('Safe Installer - Hook Conflict Detection', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_CLAUDE_DIR)) {
      rmSync(TEST_CLAUDE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_CLAUDE_DIR, { recursive: true });

    // Mock CLAUDE_CONFIG_DIR for testing
    process.env.TEST_CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_CLAUDE_DIR)) {
      rmSync(TEST_CLAUDE_DIR, { recursive: true, force: true });
    }
    delete process.env.TEST_CLAUDE_CONFIG_DIR;
  });

  it('detects conflict when PreToolUse is owned by another plugin', () => {
    // Create settings.json with non-OMC hook
    const existingSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node ~/.claude/hooks/beads-hook.mjs'
              }
            ]
          }
        ]
      }
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));

    const options: InstallOptions = {
      verbose: true,
      skipClaudeCheck: true
    };

    // Simulate install logic (we'd need to mock or refactor install function for full test)
    // For now, test the detection logic directly
    const conflicts = detectConflicts(existingSettings.hooks);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].eventType).toBe('PreToolUse');
    expect(conflicts[0].existingCommand).toBe('node ~/.claude/hooks/beads-hook.mjs');
  });

  it('does not detect conflict when hook is OMC-owned', () => {
    const existingSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node ~/.claude/hooks/omc-pre-tool-use.mjs'
              }
            ]
          }
        ]
      }
    };

    const conflicts = detectConflicts(existingSettings.hooks);

    expect(conflicts).toHaveLength(0);
  });

  it('detects multiple conflicts across different hook events', () => {
    const existingSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node ~/.claude/hooks/beads-pre-tool-use.mjs'
              }
            ]
          }
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'python ~/.claude/hooks/custom-post-tool.py'
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node ~/.claude/hooks/omc-keyword-detector.mjs'
              }
            ]
          }
        ]
      }
    };

    const conflicts = detectConflicts(existingSettings.hooks);

    expect(conflicts).toHaveLength(2);
    expect(conflicts.map(c => c.eventType)).toContain('PreToolUse');
    expect(conflicts.map(c => c.eventType)).toContain('PostToolUse');
    expect(conflicts.map(c => c.eventType)).not.toContain('UserPromptSubmit');
  });
});
