import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, win32 } from 'path';
import { fileURLToPath } from 'url';
import { isPathInsideOrEqual } from '../features/builtin-skills/skills.js';
import { compactPluginSkillPayload } from '../installer/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const PLUGIN_JSON = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const COMMANDS_DIR = join(REPO_ROOT, 'commands');
const COMPACT_PLUGIN_SKILL_BUDGET_BYTES = 64 * 1024;
const COMPACT_PLUGIN_SKILL_PER_FILE_BUDGET_BYTES = 2 * 1024;

function readPluginJson(): { skills?: unknown; commands?: unknown } {
  return JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8')) as { skills?: unknown; commands?: unknown };
}

function bundledSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function pluginSkillDirs(): string[] {
  const { skills } = readPluginJson();
  expect(Array.isArray(skills)).toBe(true);
  return (skills as string[])
    .map((skillPath) => skillPath.replace(/^\.\/skills\//, '').replace(/\/$/, ''))
    .sort();
}

function skillPayloadBytes(root: string): number {
  return readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
    .reduce((total, entry) => total + readFileSync(join(root, 'skills', entry.name, 'SKILL.md')).length, 0);
}

describe('plugin skill context budget gate (issues #2943, #2986)', () => {
  it('registers every bundled skill through plugin.json with concise native skill shims', () => {
    const defaultSkillDirs = pluginSkillDirs();
    const allSkillDirs = bundledSkillDirs();

    expect(allSkillDirs.length).toBeGreaterThan(30);
    expect(defaultSkillDirs).toEqual(allSkillDirs);
  });

  it('compacts installed plugin SKILL.md files while archiving full on-demand skill bodies', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-skill-budget-'));
    try {
      cpSync(SKILLS_DIR, join(tempRoot, 'skills'), { recursive: true });
      const originalBytes = skillPayloadBytes(tempRoot);

      const result = compactPluginSkillPayload(tempRoot);
      const compactBytes = skillPayloadBytes(tempRoot);
      const allSkillDirs = bundledSkillDirs();

      expect(result.errors).toEqual([]);
      expect(result.compacted).toBe(allSkillDirs.length);
      expect(originalBytes).toBeGreaterThan(400 * 1024);
      expect(compactBytes).toBeLessThan(COMPACT_PLUGIN_SKILL_BUDGET_BYTES);
      expect(result.totalBytes).toBe(compactBytes);

      for (const skillDir of allSkillDirs) {
        const shimPath = join(tempRoot, 'skills', skillDir, 'SKILL.md');
        const archivePath = join(tempRoot, 'skill-bodies', skillDir, 'SKILL.md');
        const shim = readFileSync(shimPath, 'utf-8');
        const archived = readFileSync(archivePath, 'utf-8');
        const source = readFileSync(join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf-8');

        expect(Buffer.byteLength(shim), `${skillDir} compact shim size`).toBeLessThan(COMPACT_PLUGIN_SKILL_PER_FILE_BUDGET_BYTES);
        expect(shim, `${skillDir} shim should point to archived body`).toContain(`../../skill-bodies/${skillDir}/SKILL.md`);
        expect(shim, `${skillDir} shim should expose runtime body override`).toContain('omc-full-body:');
        expect(archived, `${skillDir} full skill body should be preserved`).toBe(source);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses platform-safe containment for archived full-body skill paths', () => {
    const winRoot = 'C:\\Users\\me\\.claude\\plugins\\cache\\omc\\oh-my-claudecode\\4.13.7';
    const winArchivedBody = win32.join(winRoot, 'skill-bodies', 'plan', 'SKILL.md');
    const winEscapedBody = win32.join(winRoot, '..', 'other-plugin', 'SKILL.md');

    expect(isPathInsideOrEqual(winRoot, winArchivedBody)).toBe(true);
    expect(isPathInsideOrEqual(winRoot, winEscapedBody)).toBe(false);
  });

  it('keeps bundled skills discoverable and manually callable', () => {
    expect(readPluginJson().commands).toBe('./commands/');

    const registeredSkillDirs = pluginSkillDirs();
    for (const skillDir of bundledSkillDirs()) {
      const skillContent = readFileSync(join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf-8');
      const frontmatterName = skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? skillDir;
      expect(registeredSkillDirs).toContain(skillDir);

      const commandPath = join(COMMANDS_DIR, `${frontmatterName}.md`);
      if (existsSync(commandPath)) {
        const commandContent = readFileSync(commandPath, 'utf-8');
        const expectedSkillPath = skillDir === 'learner' ? 'skills/skillify/SKILL.md' : `skills/${skillDir}/SKILL.md`;
        expect(commandContent).toContain(expectedSkillPath);
        expect(commandContent).toContain('$ARGUMENTS');
      }
    }
  });

  it('preserves deprecated slash aliases as command wrappers', () => {
    expect(readFileSync(join(COMMANDS_DIR, 'learner.md'), 'utf-8')).toContain('skills/skillify/SKILL.md');
    expect(readFileSync(join(COMMANDS_DIR, 'psm.md'), 'utf-8')).toContain('skills/project-session-manager/SKILL.md');
  });
});
