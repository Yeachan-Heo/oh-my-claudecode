import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
describe('Claude Code compatibility for OMC-authored user skills', () => {
    let tempDir;
    let originalClaudeConfigDir;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-user-skill-compat-'));
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = tempDir;
        vi.resetModules();
    });
    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        rmSync(tempDir, { recursive: true, force: true });
        vi.resetModules();
    });
    it('reproduces that nested omc-learned skills are invisible to flat Claude Code lookup until compat sync runs', async () => {
        const nestedSkillPath = join(tempDir, 'skills', 'omc-learned', 'expert-review', 'SKILL.md');
        mkdirSync(join(nestedSkillPath, '..'), { recursive: true });
        writeFileSync(nestedSkillPath, '---\nname: expert-review\ntriggers: [expert-review]\n---\n\nUse expert review.\n');
        const flatSkillPath = join(tempDir, 'skills', 'expert-review', 'SKILL.md');
        expect(existsSync(flatSkillPath)).toBe(false);
        const { syncOmcLearnedUserSkillsForClaudeCode } = await import('../utils/user-skill-compat.js');
        expect(syncOmcLearnedUserSkillsForClaudeCode()).toEqual(['expert-review']);
        expect(existsSync(flatSkillPath)).toBe(true);
        expect(readFileSync(flatSkillPath, 'utf-8')).toContain('Use expert review.');
    });
    it('keeps new user skills in omc-learned/<name>.md and exposes a flat Claude Code SKILL.md shim', async () => {
        const { writeSkill } = await import('../hooks/learner/writer.js');
        const request = {
            problem: 'Need a reusable expert review workflow.',
            solution: 'Run a careful expert review pass and report only actionable findings.',
            triggers: ['expert-review'],
            targetScope: 'user',
        };
        const result = writeSkill(request, null, 'expert-review');
        expect(result.success).toBe(true);
        expect(result.path).toBe(join(tempDir, 'skills', 'omc-learned', 'expert-review.md'));
        expect(existsSync(result.path)).toBe(true);
        const flatSkillPath = join(tempDir, 'skills', 'expert-review', 'SKILL.md');
        expect(existsSync(flatSkillPath)).toBe(true);
        expect(readFileSync(flatSkillPath, 'utf-8')).toBe(readFileSync(result.path, 'utf-8'));
    });
    it('does not overwrite an existing user-authored flat skill directory with the same name', async () => {
        const nestedSkillPath = join(tempDir, 'skills', 'omc-learned', 'expert-review', 'SKILL.md');
        const flatSkillPath = join(tempDir, 'skills', 'expert-review', 'SKILL.md');
        mkdirSync(join(nestedSkillPath, '..'), { recursive: true });
        mkdirSync(join(flatSkillPath, '..'), { recursive: true });
        writeFileSync(nestedSkillPath, '---\nname: expert-review\ntriggers: [expert-review]\n---\n\nOMC skill.\n');
        writeFileSync(flatSkillPath, '---\nname: expert-review\ntriggers: [expert-review]\n---\n\nUser flat skill.\n');
        const { syncOmcLearnedUserSkillsForClaudeCode } = await import('../utils/user-skill-compat.js');
        expect(syncOmcLearnedUserSkillsForClaudeCode()).toEqual([]);
        expect(readFileSync(flatSkillPath, 'utf-8')).toContain('User flat skill.');
    });
    it('uses a symlink shim when supported so edits to the omc-learned source remain visible', async () => {
        const nestedSkillPath = join(tempDir, 'skills', 'omc-learned', 'expert-review', 'SKILL.md');
        mkdirSync(join(nestedSkillPath, '..'), { recursive: true });
        writeFileSync(nestedSkillPath, '---\nname: expert-review\ntriggers: [expert-review]\n---\n\nBefore edit.\n');
        const { ensureClaudeCodeUserSkillCompat } = await import('../utils/user-skill-compat.js');
        expect(ensureClaudeCodeUserSkillCompat('expert-review', nestedSkillPath)).toBe(true);
        const flatSkillPath = join(tempDir, 'skills', 'expert-review', 'SKILL.md');
        if (!lstatSync(flatSkillPath).isSymbolicLink()) {
            return;
        }
        writeFileSync(nestedSkillPath, '---\nname: expert-review\ntriggers: [expert-review]\n---\n\nAfter edit.\n');
        expect(readFileSync(flatSkillPath, 'utf-8')).toContain('After edit.');
    });
});
//# sourceMappingURL=user-skill-compat.test.js.map