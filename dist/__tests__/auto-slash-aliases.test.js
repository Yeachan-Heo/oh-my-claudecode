import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
describe('auto-slash command skill aliases', () => {
    const originalCwd = process.cwd();
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    let tempRoot;
    let tempConfigDir;
    let tempProjectDir;
    async function loadExecutor() {
        vi.resetModules();
        return import('../hooks/auto-slash-command/executor.js');
    }
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-auto-slash-aliases-'));
        tempConfigDir = join(tempRoot, 'claude-config');
        tempProjectDir = join(tempRoot, 'project');
        mkdirSync(join(tempConfigDir, 'skills', 'team'), { recursive: true });
        mkdirSync(join(tempConfigDir, 'skills', 'project-session-manager'), { recursive: true });
        mkdirSync(join(tempProjectDir, '.claude', 'commands'), { recursive: true });
        writeFileSync(join(tempConfigDir, 'skills', 'team', 'SKILL.md'), `---
name: team
description: Team orchestration
---

Team body`);
        writeFileSync(join(tempConfigDir, 'skills', 'project-session-manager', 'SKILL.md'), `---
name: project-session-manager
description: Project session management
aliases: [psm]
---

PSM body`);
        process.env.CLAUDE_CONFIG_DIR = tempConfigDir;
        process.chdir(tempProjectDir);
    });
    afterEach(() => {
        process.chdir(originalCwd);
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        vi.resetModules();
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('discovers alias commands from skill frontmatter', async () => {
        const { discoverAllCommands, findCommand, listAvailableCommands } = await loadExecutor();
        const commands = discoverAllCommands();
        const names = commands.map((command) => command.name);
        expect(names).toContain('team');
        expect(names).not.toContain('swarm'); // alias removed in #1131
        expect(names).toContain('project-session-manager');
        expect(names).toContain('psm');
        const psm = findCommand('psm');
        expect(psm?.scope).toBe('skill');
        expect(psm?.metadata.aliasOf).toBe('project-session-manager');
        expect(psm?.metadata.deprecatedAlias).toBe(true);
        expect(psm?.metadata.deprecationMessage).toContain('/project-session-manager');
        const listedNames = listAvailableCommands().map((command) => command.name);
        expect(listedNames).toContain('team');
        expect(listedNames).toContain('project-session-manager');
        expect(listedNames).not.toContain('psm');
    });
    it('keeps source-priority semantics with deduped names', async () => {
        writeFileSync(join(tempProjectDir, '.claude', 'commands', 'psm.md'), `---
description: Project-level psm override
---

Project psm body`);
        const { discoverAllCommands, findCommand } = await loadExecutor();
        const commands = discoverAllCommands();
        const psmCommands = commands.filter((command) => command.name.toLowerCase() === 'psm');
        expect(psmCommands).toHaveLength(1);
        expect(psmCommands[0].scope).toBe('project');
        expect(findCommand('psm')?.scope).toBe('project');
    });
    it('injects deprecation warning when alias command is executed', async () => {
        const { executeSlashCommand } = await loadExecutor();
        const result = executeSlashCommand({
            command: 'psm',
            args: 'create session',
            raw: '/psm create session',
        });
        expect(result.success).toBe(true);
        expect(result.replacementText).toContain('Deprecated Alias');
        expect(result.replacementText).toContain('/project-session-manager');
    });
});
//# sourceMappingURL=auto-slash-aliases.test.js.map