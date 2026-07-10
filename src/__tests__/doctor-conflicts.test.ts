/**
 * Tests for doctor-conflicts command (issue #606)
 *
 * Verifies that OMC-managed hooks are correctly classified as OMC-owned,
 * not falsely flagged as "Other".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.hoisted runs before vi.mock hoisting — safe to reference in mock factories
const { TEST_DIRS } = vi.hoisted(() => {
  const TEST_DIRS = { claudeDir: '', projectDir: '', projectClaudeDir: '', builtinSkillsDir: '' };
  return { TEST_DIRS };
});

let TEST_CLAUDE_DIR = '';
let TEST_PROJECT_DIR = '';
let TEST_PROJECT_CLAUDE_DIR = '';

function resetTestDirs(): void {
  TEST_CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'omc-doctor-conflicts-claude-'));
  TEST_PROJECT_DIR = mkdtempSync(join(tmpdir(), 'omc-doctor-conflicts-project-'));
  TEST_PROJECT_CLAUDE_DIR = join(TEST_PROJECT_DIR, '.claude');
  TEST_DIRS.claudeDir = TEST_CLAUDE_DIR;
  TEST_DIRS.builtinSkillsDir = join(TEST_PROJECT_DIR, 'builtin-skills');
}

function writeCanonicalOmcReferenceSkill(content = '# Canonical omc-reference skill\n'): string {
  const skillPath = join(TEST_DIRS.builtinSkillsDir, 'omc-reference', 'SKILL.md');
  mkdirSync(join(TEST_DIRS.builtinSkillsDir, 'omc-reference'), { recursive: true });
  writeFileSync(skillPath, content);
  return content;
}

function writePluginRoot(root: string, content: string): void {
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'skills', 'omc-reference'), { recursive: true });
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC\n<!-- OMC:END -->\n');
  writeFileSync(join(root, 'skills', 'omc-reference', 'SKILL.md'), content);
}

// Mock getClaudeConfigDir before importing the module under test
vi.mock('../utils/config-dir.js', () => ({
  getClaudeConfigDir: () => TEST_DIRS.claudeDir,
}));

// Mock builtin skills to return a known list for testing
vi.mock('../features/builtin-skills/skills.js', () => ({
  getSkillsDir: () => TEST_DIRS.builtinSkillsDir,
  listBuiltinSkillNames: ({ includeAliases }: { includeAliases?: boolean } = {}) => {
    const names = ['autopilot', 'ralph', 'ultrawork', 'plan', 'team', 'cancel', 'note', 'omc-reference'];
    if (includeAliases) {
      return [...names, 'psm'];
    }
    return names;
  },
}));

// Import after mock setup
import {
  checkHookConflicts,
  checkClaudeMdStatus,
  checkConfigIssues,
  checkLegacySkills,
  checkWorkspaceMarker,
  checkWindowsUnsafePluginHooks,
  runConflictCheck,
} from '../cli/commands/doctor-conflicts.js';

describe('doctor-conflicts: hook ownership classification', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    resetTestDirs();
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
    process.env.CLAUDE_MCP_CONFIG_PATH = join(TEST_CLAUDE_DIR, '..', '.claude.json');
    process.env.OMC_HOME = join(TEST_PROJECT_DIR, '.omc-home');
    process.env.CODEX_HOME = join(TEST_PROJECT_DIR, '.codex');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    delete process.env.OMC_HOME;
    delete process.env.CODEX_HOME;
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
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

  it('warns on native Windows when a plugin cache hooks manifest still contains sh/find-node commands', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'omc-doctor-win-plugin-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
      writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              type: 'command',
              command: 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/persistent-mode.mjs',
            }],
          }],
          SessionEnd: [{
            hooks: [{
              type: 'command',
              command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs',
            }],
          }],
        },
      }));
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const unsafe = checkWindowsUnsafePluginHooks();

      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ pluginRoot, event: 'Stop' });
      expect(unsafe[0].command).toContain('find-node.sh');
      expect(runConflictCheck().hasConflicts).toBe(true);
    } finally {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('warns on native Windows for stale installed plugin manifest even when settings hooks are clean', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'omc-doctor-win-installed-plugin-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
      writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
        hooks: {
          PostToolUse: [{
            hooks: [{
              type: 'command',
              command: 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/post-tool-verifier.mjs',
            }],
          }],
        },
      }));
      writeFileSync(join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify({
        hooks: {
          PostToolUse: [{
            hooks: [{
              type: 'command',
              command: 'node "$HOME/.claude/hooks/post-tool-use.mjs"',
            }],
          }],
        },
      }));
      mkdirSync(join(TEST_CLAUDE_DIR, 'plugins'), { recursive: true });
      writeFileSync(join(TEST_CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
        plugins: {
          'oh-my-claudecode': [{ installPath: pluginRoot }],
        },
      }));
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const unsafe = checkWindowsUnsafePluginHooks();

      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ pluginRoot, event: 'PostToolUse' });
      expect(unsafe[0].command).toContain('find-node.sh');
      expect(runConflictCheck().windowsUnsafePluginHooks).toHaveLength(1);
      expect(runConflictCheck().hasConflicts).toBe(true);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('does not warn on native Windows when plugin hooks already use direct node run.cjs commands', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'omc-doctor-win-plugin-clean-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
      writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              type: 'command',
              command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/persistent-mode.mjs',
            }],
          }],
        },
      }));
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      expect(checkWindowsUnsafePluginHooks()).toEqual([]);
    } finally {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      rmSync(pluginRoot, { recursive: true, force: true });
    }
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

  it('reports Codex config.toml drift against the unified MCP registry', () => {
    const registryDir = join(TEST_CLAUDE_DIR, '..', '.omc');
    const codexDir = join(TEST_CLAUDE_DIR, '..', '.codex');
    mkdirSync(registryDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(registryDir, 'mcp-registry.json'), JSON.stringify({
      gitnexus: { command: 'gitnexus', args: ['mcp'] },
    }));
    writeFileSync(process.env.CLAUDE_MCP_CONFIG_PATH!, JSON.stringify({
      mcpServers: {
        gitnexus: { command: 'gitnexus', args: ['mcp'] },
      },
    }));
    writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-5"\n');

    process.env.OMC_HOME = registryDir;
    process.env.CODEX_HOME = codexDir;

    const report = runConflictCheck();

    expect(report.mcpRegistrySync.registryExists).toBe(true);
    expect(report.mcpRegistrySync.claudeMissing).toEqual([]);
    expect(report.mcpRegistrySync.codexMissing).toEqual(['gitnexus']);
    expect(report.hasConflicts).toBe(true);

    delete process.env.OMC_HOME;
    delete process.env.CODEX_HOME;
  });

  it('reports mismatched Codex config.toml entries against the unified MCP registry', () => {
    const registryDir = join(TEST_CLAUDE_DIR, '..', '.omc');
    const codexDir = join(TEST_CLAUDE_DIR, '..', '.codex');
    mkdirSync(registryDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(registryDir, 'mcp-registry.json'), JSON.stringify({
      gitnexus: { command: 'gitnexus', args: ['mcp'] },
    }));
    writeFileSync(process.env.CLAUDE_MCP_CONFIG_PATH!, JSON.stringify({
      mcpServers: {
        gitnexus: { command: 'gitnexus', args: ['mcp'] },
      },
    }));
    writeFileSync(join(codexDir, 'config.toml'), [
      '# BEGIN OMC MANAGED MCP REGISTRY',
      '',
      '[mcp_servers.gitnexus]',
      'command = "gitnexus"',
      'args = ["wrong"]',
      '',
      '# END OMC MANAGED MCP REGISTRY',
      '',
    ].join('\n'));

    process.env.OMC_HOME = registryDir;
    process.env.CODEX_HOME = codexDir;

    const report = runConflictCheck();

    expect(report.mcpRegistrySync.codexMissing).toEqual([]);
    expect(report.mcpRegistrySync.codexMismatched).toEqual(['gitnexus']);
    expect(report.hasConflicts).toBe(true);

    delete process.env.OMC_HOME;
    delete process.env.CODEX_HOME;
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
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    resetTestDirs();
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
    process.env.CLAUDE_MCP_CONFIG_PATH = join(TEST_CLAUDE_DIR, '..', '.claude.json');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    delete process.env.OMC_HOME;
    delete process.env.CODEX_HOME;
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
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

  // A block carrying legacy fingerprints. Used both inside and outside markers.
  const legacyBody = [
    '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
    'You are enhanced with multi-agent capabilities. **You are a CONDUCTOR, not a performer.**',
    '',
    '## PART 1: CORE PROTOCOL (CRITICAL)',
    '',
    "The difference? You don't NEED them anymore. Everything auto-activates."
  ].join('\n');

  it('(d) does not flag fingerprints that live only inside a valid marker block', () => {
    writeFileSync(
      join(TEST_CLAUDE_DIR, 'CLAUDE.md'),
      `<!-- OMC:START -->\n${legacyBody}\n<!-- OMC:END -->\n`
    );
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(true);
    expect(status!.hasLegacyUnmarkedOmcContent).toBe(false);
  });

  it('flags legacy content that lives outside the marker block', () => {
    writeFileSync(
      join(TEST_CLAUDE_DIR, 'CLAUDE.md'),
      `<!-- OMC:START -->\n# OMC Config\n<!-- OMC:END -->\n\n<!-- User customizations -->\n${legacyBody}\n`
    );
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasLegacyUnmarkedOmcContent).toBe(true);
  });

  it('(e) reports legacy content living in the companion file, not only the main file', () => {
    // Main file has no markers and no legacy content; companion holds the markers
    // and the residual legacy guide outside them.
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '# My clean config\nSee CLAUDE-omc.md\n');
    writeFileSync(
      join(TEST_CLAUDE_DIR, 'CLAUDE-omc.md'),
      `<!-- OMC:START -->\n# OMC Config\n<!-- OMC:END -->\n\n<!-- User customizations -->\n${legacyBody}\n`
    );
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(status!.hasMarkers).toBe(true);
    expect(status!.companionFile).toContain('CLAUDE-omc.md');
    expect(status!.hasLegacyUnmarkedOmcContent).toBe(true);
  });
});

describe('doctor-conflicts: legacy skills collision check (issue #1101)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    resetTestDirs();
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    delete process.env.CLAUDE_PLUGIN_ROOT;
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
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

  it('does NOT flag setup-installed omc-reference fallback when it matches the bundled skill (issue #2992)', () => {
    const canonicalContent = writeCanonicalOmcReferenceSkill();
    process.env.OMC_MCP_REGISTRY_PATH = join(TEST_PROJECT_DIR, 'no-mcp-registry.json');
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'omc-reference'), { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference', 'SKILL.md'), canonicalContent);

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(0);
  });

  it('does NOT flag setup-installed omc-reference fallback when setup resolved a newer active cache root (issue #2992)', () => {
    const oldContent = '# Old omc-reference skill\n';
    const newerContent = '# Newer setup-installed omc-reference skill\n';
    const cacheBase = join(TEST_PROJECT_DIR, 'plugin-cache', 'oh-my-claudecode');
    const oldPluginRoot = join(cacheBase, '4.8.2');
    const newerPluginRoot = join(cacheBase, '4.9.0');
    TEST_DIRS.builtinSkillsDir = join(oldPluginRoot, 'skills');
    writePluginRoot(oldPluginRoot, oldContent);
    writePluginRoot(newerPluginRoot, newerContent);
    mkdirSync(join(TEST_CLAUDE_DIR, 'plugins'), { recursive: true });
    writeFileSync(join(TEST_CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
      'oh-my-claudecode@omc': [{ installPath: oldPluginRoot, version: '4.8.2' }],
    }));
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'omc-reference'), { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference', 'SKILL.md'), newerContent);

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(0);
  });

  it('does NOT flag setup-installed omc-reference fallback when it matches CLAUDE_PLUGIN_ROOT (issue #2992)', () => {
    const currentContent = '# Current omc-reference skill\n';
    const sessionContent = '# Session root omc-reference skill\n';
    const sessionPluginRoot = join(TEST_PROJECT_DIR, 'session-plugin-root');
    writeCanonicalOmcReferenceSkill(currentContent);
    writePluginRoot(sessionPluginRoot, sessionContent);
    process.env.CLAUDE_PLUGIN_ROOT = sessionPluginRoot;
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'omc-reference'), { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference', 'SKILL.md'), sessionContent);

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(0);
  });

  it('flags user-modified omc-reference fallback content as a real collision (issue #2992)', () => {
    writeCanonicalOmcReferenceSkill('# Canonical omc-reference skill\n');
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'omc-reference'), { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference', 'SKILL.md'), '# Modified omc-reference skill\n');

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('omc-reference');
  });

  it('still flags non-contract omc-reference.md legacy files (issue #2992)', () => {
    writeCanonicalOmcReferenceSkill();
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference.md'), '# Legacy omc-reference markdown file\n');

    const collisions = checkLegacySkills();
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('omc-reference');
  });

  it('reports no conflicts for the setup-installed omc-reference fallback (issue #2992)', () => {
    const canonicalContent = writeCanonicalOmcReferenceSkill();
    const skillsDir = join(TEST_CLAUDE_DIR, 'skills');
    mkdirSync(join(skillsDir, 'omc-reference'), { recursive: true });
    writeFileSync(join(skillsDir, 'omc-reference', 'SKILL.md'), canonicalContent);
    writeFileSync(join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC\n<!-- OMC:END -->\n');

    const report = runConflictCheck();
    expect(report.legacySkills).toHaveLength(0);
    expect(report.hasConflicts).toBe(false);
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

describe('doctor-conflicts: config known fields (issue #1499)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    resetTestDirs();
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    mkdirSync(join(TEST_PROJECT_DIR, '.omc'), { recursive: true });
    mkdirSync(join(TEST_PROJECT_DIR, '.codex'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
    process.env.CLAUDE_MCP_CONFIG_PATH = join(TEST_CLAUDE_DIR, '..', '.claude.json');
    process.env.OMC_HOME = join(TEST_PROJECT_DIR, '.omc');
    process.env.CODEX_HOME = join(TEST_PROJECT_DIR, '.codex');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    delete process.env.OMC_HOME;
    delete process.env.CODEX_HOME;
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('does not flag legitimate config keys from current writers and readers', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, '.omc-config.json'), JSON.stringify({
      silentAutoUpdate: false,
      notificationProfiles: {
        work: {
          enabled: true,
          discord: {
            enabled: true,
            webhookUrl: 'https://discord.example.test/webhook',
          },
        },
      },
      hudEnabled: true,
      nodeBinary: '/opt/homebrew/bin/node',
      delegationEnforcementLevel: 'strict',
      autoInvoke: {
        enabled: true,
        confidenceThreshold: 85,
      },
      customIntegrations: {
        enabled: true,
        integrations: [],
      },
      team: {
        ops: {
          maxAgents: 20,
          defaultAgentType: 'claude',
        },
      },
    }, null, 2));

    expect(checkConfigIssues().unknownFields).toEqual([]);
    expect(runConflictCheck().hasConflicts).toBe(false);
  });

  it('still reports genuinely unknown config keys', () => {
    writeFileSync(join(TEST_CLAUDE_DIR, '.omc-config.json'), JSON.stringify({
      silentAutoUpdate: false,
      totallyMadeUpKey: true,
      anotherUnknown: { nested: true },
    }, null, 2));

    expect(checkConfigIssues().unknownFields).toEqual(['totallyMadeUpKey', 'anotherUnknown']);
    expect(runConflictCheck().hasConflicts).toBe(true);
  });
});

describe('doctor-conflicts: workspace marker check (Wave F.2)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let savedOmcStateDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    resetTestDirs();
    mkdirSync(TEST_PROJECT_CLAUDE_DIR, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_DIR;
    process.env.CLAUDE_MCP_CONFIG_PATH = join(TEST_CLAUDE_DIR, '..', '.claude.json');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_PROJECT_DIR);
    savedOmcStateDir = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    tempDir = mkdtempSync(join(tmpdir(), 'omc-ws-marker-test-'));
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    if (savedOmcStateDir === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = savedOmcStateDir;
    }
    for (const dir of [TEST_CLAUDE_DIR, TEST_PROJECT_DIR]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports markerRoot null when no .omc-workspace marker exists', () => {
    cwdSpy.mockReturnValue(tempDir);
    const status = checkWorkspaceMarker();
    expect(status.markerRoot).toBeNull();
    expect(status.stateDirEnvSet).toBe(false);
    expect(status.precedenceConflict).toBe(false);
  });

  it('reports markerRoot when .omc-workspace marker is present', () => {
    writeFileSync(join(tempDir, '.omc-workspace'), '{}');
    cwdSpy.mockReturnValue(tempDir);
    const status = checkWorkspaceMarker();
    expect(status.markerRoot).toBe(tempDir);
    expect(status.stateDirEnvSet).toBe(false);
    expect(status.precedenceConflict).toBe(false);
  });

  it('reports stateDirEnvSet when OMC_STATE_DIR is set', () => {
    process.env.OMC_STATE_DIR = '/some/centralized/state';
    cwdSpy.mockReturnValue(tempDir);
    const status = checkWorkspaceMarker();
    expect(status.stateDirEnvSet).toBe(true);
    expect(status.stateDirEnvValue).toBe('/some/centralized/state');
    expect(status.markerRoot).toBeNull();
    expect(status.precedenceConflict).toBe(false);
  });

  it('emits precedenceConflict when both OMC_STATE_DIR and .omc-workspace are active', () => {
    writeFileSync(join(tempDir, '.omc-workspace'), '{}');
    process.env.OMC_STATE_DIR = '/centralized/override';
    cwdSpy.mockReturnValue(tempDir);
    const status = checkWorkspaceMarker();
    expect(status.markerRoot).toBe(tempDir);
    expect(status.stateDirEnvSet).toBe(true);
    expect(status.precedenceConflict).toBe(true);
  });

  it('precedenceConflict does NOT count as a hard hasConflicts flag in runConflictCheck', () => {
    // precedenceConflict is a WARN, not a hard conflict — hasConflicts should stay false
    writeFileSync(join(tempDir, '.omc-workspace'), '{}');
    process.env.OMC_STATE_DIR = '/centralized/override';
    cwdSpy.mockReturnValue(tempDir);
    const report = runConflictCheck();
    // workspaceMarker.precedenceConflict is true
    expect(report.workspaceMarker.precedenceConflict).toBe(true);
    // but hasConflicts only reflects hook/skill/env/config issues, not the workspace precedence warn
    expect(report.hasConflicts).toBe(false);
  });

  it('runConflictCheck includes workspaceMarker in the report', () => {
    cwdSpy.mockReturnValue(tempDir);
    const report = runConflictCheck();
    expect(report.workspaceMarker).toBeDefined();
    expect(typeof report.workspaceMarker.markerRoot).toBe('object'); // null is valid
    expect(typeof report.workspaceMarker.stateDirEnvSet).toBe('boolean');
    expect(typeof report.workspaceMarker.precedenceConflict).toBe('boolean');
  });
});
