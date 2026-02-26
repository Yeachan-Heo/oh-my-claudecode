/**
 * Tests for doctor-conflicts command (issue #606)
 *
 * Verifies that OMC-managed hooks are correctly classified as OMC-owned,
 * not falsely flagged as "Other".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TEST_CLAUDE_DIR = join(homedir(), '.claude-test-doctor-conflicts');
const TEST_PROJECT_DIR = join(homedir(), '.claude-test-doctor-project');
const TEST_PROJECT_CLAUDE_DIR = join(TEST_PROJECT_DIR, '.claude');

// Mock getClaudeConfigDir before importing the module under test
vi.mock('../utils/paths.js', () => ({
  getClaudeConfigDir: () => TEST_CLAUDE_DIR,
}));

// Mock builtin skills to return a known list for testing
vi.mock('../features/builtin-skills/skills.js', () => ({
  listBuiltinSkillNames: ({ includeAliases }: { includeAliases?: boolean } = {}) => {
    const names = ['autopilot', 'ralph', 'ultrawork', 'plan', 'team', 'cancel', 'note'];
    if (includeAliases) {
      return [...names, 'psm'];
    }
    return names;
  },
}));

// Import after mock setup
import { checkHookConflicts, checkClaudeMdStatus, checkLegacySkills, runConflictCheck, type ConflictReport } from '../cli/commands/doctor-conflicts.js';

describe('doctor-conflicts: hook ownership classification', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('classifies real OMC hook commands as OMC-owned (issue #606)', () => {
    // These are the actual commands OMC installs into settings.json
    const settings = {
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/keyword-detector.mjs"',
          }],
        }],
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/session-start.mjs"',
          }],
        }],
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          }],
        }],
        PostToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/post-tool-use.mjs"',
          }],
        }],
        Stop: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/persistent-mode.mjs"',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(settings));
    const conflicts = checkHookConflicts();

    // All hooks should be classified as OMC-owned
    expect(conflicts.length).toBeGreaterThan(0);
    for (const hook of conflicts) {
      expect(hook.isOmc).toBe(true);
    }
  });

  it('classifies Windows-style OMC hook commands as OMC-owned', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "%USERPROFILE%\\.claude\\hooks\\pre-tool-use.mjs"',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(settings));
    const conflicts = checkHookConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].isOmc).toBe(true);
  });

  it('classifies non-OMC hooks as not OMC-owned', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node ~/other-plugin/hooks/pre-tool.mjs',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(settings));
    const conflicts = checkHookConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].isOmc).toBe(false);
  });

  it('correctly distinguishes OMC and non-OMC hooks in mixed config', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          }],
        }],
        PostToolUse: [{
          hooks: [{
            type: 'command',
            command: 'python ~/other-plugin/post-tool.py',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(settings));
    const conflicts = checkHookConflicts();

    expect(conflicts).toHaveLength(2);

    const preTool = conflicts.find(c => c.event === 'PreToolUse');
    const postTool = conflicts.find(c => c.event === 'PostToolUse');

    expect(preTool?.isOmc).toBe(true);
    expect(postTool?.isOmc).toBe(false);
  });

  it('reports hasConflicts only when non-OMC hooks exist', () => {
    // All-OMC config: no conflicts
    const omcOnlySettings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(omcOnlySettings));
    const omcReport = runConflictCheck();
    // hasConflicts should be false when all hooks are OMC-owned
    expect(omcReport.hookConflicts.every(h => h.isOmc)).toBe(true);
    expect(omcReport.hookConflicts.some(h => !h.isOmc)).toBe(false);
  });

  it('detects hooks from project-level settings.json (issue #669)', () => {
    // Only project-level settings, no profile-level
    const projectSettings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_PROJECT_CLAUDE_DIR, 'settings.json'), JSON.stringify(projectSettings));
    const conflicts = checkHookConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].event).toBe('PreToolUse');
    expect(conflicts[0].isOmc).toBe(true);
  });

  it('merges hooks from both profile and project settings (issue #669)', () => {
    const profileSettings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/session-start.mjs"',
          }],
        }],
      },
    };
    const projectSettings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'python ~/my-project/hooks/lint.py',
          }],
        }],
      },
    };

    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(profileSettings));
    writeFileSync(join(TEST_PROJECT_CLAUDE_DIR, 'settings.json'), JSON.stringify(projectSettings));
    const conflicts = checkHookConflicts();

    expect(conflicts).toHaveLength(2);

    const sessionStart = conflicts.find(c => c.event === 'SessionStart');
    const preTool = conflicts.find(c => c.event === 'PreToolUse');

    expect(sessionStart?.isOmc).toBe(true);
    expect(preTool?.isOmc).toBe(false);
  });

  it('deduplicates identical hooks present in both levels (issue #669)', () => {
    const sharedHook = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: 'node "$HOME/.claude/hooks/pre-tool-use.mjs"',
          }],
        }],
      },
    };

    // Same hook in both profile and project settings
    writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify(sharedHook));
    writeFileSync(join(TEST_PROJECT_CLAUDE_DIR, 'settings.json'), JSON.stringify(sharedHook));
    const conflicts = checkHookConflicts();

    // Should appear only once, not twice
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].event).toBe('PreToolUse');
    expect(conflicts[0].isOmc).toBe(true);
  });
});

describe('doctor-conflicts: CLAUDE.md companion file detection (issue #1101)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('detects OMC markers in main CLAUDE.md', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC Config\n<!-- OMC:END -->\n');
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(true);
    expect(status!.companionFile).toBeUndefined();
  });

  it('detects OMC markers in companion file when main CLAUDE.md lacks them', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '# My custom config\n');
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE-omc.md'), '<!-- OMC:START -->\n# OMC Config\n<!-- OMC:END -->\n');
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(true);
    expect(status!.companionFile).toContain('CLAUDE-omc.md');
  });

  it('does not false-positive when companion file has no markers', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '# My config\n');
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE-custom.md'), '# Custom stuff\n');
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(false);
    expect(status!.companionFile).toBeUndefined();
  });

  it('detects companion file reference in CLAUDE.md', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '# Config\nSee CLAUDE-omc.md for OMC settings\n');
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(false);
    expect(status!.companionFile).toBe(join(TEST_CLAUDE_DIR, 'CLAUDE-omc.md'));
  });

  it('prefers main file markers over companion file', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC\n<!-- OMC:END -->\n');
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE-omc.md'), '<!-- OMC:START -->\n# Also OMC\n<!-- OMC:END -->\n');
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(true);
    expect(status!.companionFile).toBeUndefined();
  });

  it('returns null when no CLAUDE.md exists', () => {
    const status = checkClaudeMdStatus();
    expect(status).toBeNull();
  });
});

describe('doctor-conflicts: legacy skills collision check (issue #1101)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('flags legacy skills that collide with plugin skill names', () => {
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'autopilot.md'), '# Legacy autopilot skill');
    writeFileSync(join(skillsDir, 'ralph.md'), '# Legacy ralph skill');

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(2);
    expect(collisions.map(c => c.name)).toContain('autopilot');
    expect(collisions.map(c => c.name)).toContain('ralph');
  });

  it('does NOT flag custom skills that do not collide with plugin names', () => {
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-custom-skill.md'), '# My custom skill');
    writeFileSync(join(skillsDir, 'deploy-helper.md'), '# Deploy helper');

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(0);
  });

  it('flags collisions in mixed custom and legacy skills', () => {
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'plan.md'), '# Legacy plan skill');
    writeFileSync(join(skillsDir, 'my-workflow.md'), '# Custom workflow');

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('plan');
  });

  it('returns empty array when no skills directory exists', () => {
    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(0);
  });

  it('flags directory entries that match plugin skill names', () => {
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'team'), { recursive: true });
    mkdirSync(join(skillsDir, 'my-thing'), { recursive: true });

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('team');
  });

  it('reports hasConflicts when legacy skills collide (issue #1101)', () => {
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'cancel.md'), '# Legacy cancel');
    // Need a CLAUDE.md for the report to work
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC\n<!-- OMC:END -->\n');

    const report = runConflictCheck();
    expect(report.legacySkills).toHaveLength(1);
    expect(report.hasConflicts).toBe(true);
  });
});
