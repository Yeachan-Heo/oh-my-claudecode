import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VERSION, CLAUDE_CONFIG_DIR, AGENTS_DIR, COMMANDS_DIR, SKILLS_DIR, HOOKS_DIR, isRunningAsPlugin, isProjectScopedPlugin, } from '../installer/index.js';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
/**
 * Get the package root directory for testing
 */
function getPackageDir() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // From src/__tests__/installer.test.ts, go up to package root
    return join(__dirname, '..', '..');
}
/**
 * Load agent definitions for testing
 */
function loadAgentDefinitions() {
    const agentsDir = join(getPackageDir(), 'agents');
    const definitions = {};
    if (!existsSync(agentsDir)) {
        throw new Error(`agents directory not found: ${agentsDir}`);
    }
    for (const file of readdirSync(agentsDir)) {
        if (file.endsWith('.md')) {
            definitions[file] = readFileSync(join(agentsDir, file), 'utf-8');
        }
    }
    return definitions;
}
/**
 * Load command definitions for testing
 */
function loadCommandDefinitions() {
    const commandsDir = join(getPackageDir(), 'commands');
    const definitions = {};
    if (!existsSync(commandsDir)) {
        throw new Error(`commands directory not found: ${commandsDir}`);
    }
    for (const file of readdirSync(commandsDir)) {
        if (file.endsWith('.md')) {
            definitions[file] = readFileSync(join(commandsDir, file), 'utf-8');
        }
    }
    return definitions;
}
/**
 * Load CLAUDE.md content for testing
 */
function loadClaudeMdContent() {
    const claudeMdPath = join(getPackageDir(), 'docs', 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
        throw new Error(`CLAUDE.md not found: ${claudeMdPath}`);
    }
    return readFileSync(claudeMdPath, 'utf-8');
}
describe('Installer Constants', () => {
    // Load definitions once for all tests
    const AGENT_DEFINITIONS = loadAgentDefinitions();
    const COMMAND_DEFINITIONS = loadCommandDefinitions();
    const CLAUDE_MD_CONTENT = loadClaudeMdContent();
    describe('AGENT_DEFINITIONS', () => {
        it('should contain expected core agents', () => {
            const expectedAgents = [
                'architect.md',
                'explore.md',
                'designer.md',
                'writer.md',
                'vision.md',
                'critic.md',
                'analyst.md',
                'executor.md',
                'planner.md',
                'qa-tester.md',
                'debugger.md',
                'verifier.md',
            ];
            for (const agent of expectedAgents) {
                expect(AGENT_DEFINITIONS).toHaveProperty(agent);
                expect(typeof AGENT_DEFINITIONS[agent]).toBe('string');
                expect(AGENT_DEFINITIONS[agent].length).toBeGreaterThan(0);
            }
        });
        it('should have valid frontmatter for each agent', () => {
            for (const [filename, content] of Object.entries(AGENT_DEFINITIONS)) {
                // Skip non-agent files (AGENTS.md is documentation, not an agent)
                if (filename === 'AGENTS.md')
                    continue;
                // Check for frontmatter delimiters
                expect(content).toMatch(/^---\n/);
                expect(content).toMatch(/\n---\n/);
                // Extract frontmatter
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                expect(frontmatterMatch).toBeTruthy();
                const frontmatter = frontmatterMatch[1];
                // Check required fields (name, description are required; tools is optional)
                expect(frontmatter).toMatch(/^name:\s+\S+/m);
                expect(frontmatter).toMatch(/^description:\s+.+/m);
                // Note: tools field removed - agents use disallowedTools or have all tools by default
                // Model is optional in some agent definitions
            }
        });
        it('should have unique agent names', () => {
            const names = new Set();
            for (const content of Object.values(AGENT_DEFINITIONS)) {
                const nameMatch = content.match(/^name:\s+(\S+)/m);
                expect(nameMatch).toBeTruthy();
                const name = nameMatch[1];
                expect(names.has(name)).toBe(false);
                names.add(name);
            }
        });
        it('should have consistent model assignments', () => {
            const modelExpectations = {
                'architect.md': 'opus',
                'executor.md': 'sonnet',
                'designer.md': 'sonnet',
                'writer.md': 'haiku',
                'vision.md': 'sonnet',
                'critic.md': 'opus',
                'analyst.md': 'opus',
                'planner.md': 'opus',
                'qa-tester.md': 'sonnet',
                'debugger.md': 'sonnet',
                'verifier.md': 'sonnet',
                'style-reviewer.md': 'haiku',
                'quality-reviewer.md': 'opus',
                'api-reviewer.md': 'sonnet',
                'performance-reviewer.md': 'sonnet',
                'test-engineer.md': 'sonnet',
                'security-reviewer.md': 'opus',
                'build-fixer.md': 'sonnet',
                'git-master.md': 'sonnet',
                'deep-executor.md': 'opus',
            };
            for (const [filename, expectedModel] of Object.entries(modelExpectations)) {
                const content = AGENT_DEFINITIONS[filename];
                expect(content).toBeTruthy();
                expect(content).toMatch(new RegExp(`^model:\\s+${expectedModel}`, 'm'));
            }
        });
        it('should not contain duplicate file names', () => {
            const filenames = Object.keys(AGENT_DEFINITIONS);
            const uniqueFilenames = new Set(filenames);
            expect(filenames.length).toBe(uniqueFilenames.size);
        });
    });
    describe('COMMAND_DEFINITIONS', () => {
        it('should contain expected commands (0 commands - all migrated to skills)', () => {
            const expectedCommands = [];
            for (const command of expectedCommands) {
                expect(COMMAND_DEFINITIONS).toHaveProperty(command);
                expect(typeof COMMAND_DEFINITIONS[command]).toBe('string');
                expect(COMMAND_DEFINITIONS[command].length).toBeGreaterThan(0);
            }
        });
        it('should have valid frontmatter for each command', () => {
            for (const [_filename, content] of Object.entries(COMMAND_DEFINITIONS)) {
                // Check for frontmatter delimiters
                expect(content).toMatch(/^---\n/);
                expect(content).toMatch(/\n---\n/);
                // Extract frontmatter
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                expect(frontmatterMatch).toBeTruthy();
                const frontmatter = frontmatterMatch[1];
                // Check required field
                expect(frontmatter).toMatch(/^description:\s+.+/m);
            }
        });
        it('should not contain duplicate command names', () => {
            const commandNames = Object.keys(COMMAND_DEFINITIONS);
            const uniqueNames = new Set(commandNames);
            expect(commandNames.length).toBe(uniqueNames.size);
        });
        it('should contain $ARGUMENTS placeholder in commands that need it', () => {
            const commandsWithArgs = [];
            for (const command of commandsWithArgs) {
                const content = COMMAND_DEFINITIONS[command];
                expect(content).toContain('$ARGUMENTS');
            }
        });
    });
    describe('CLAUDE_MD_CONTENT', () => {
        it('should be valid markdown', () => {
            expect(typeof CLAUDE_MD_CONTENT).toBe('string');
            expect(CLAUDE_MD_CONTENT.length).toBeGreaterThan(100);
            expect(CLAUDE_MD_CONTENT).toMatch(/^#\s+/m); // Has headers
        });
        it('should contain essential sections', () => {
            const essentialSections = [
                'Multi-Agent Orchestration',
                'delegation_rules',
                'skills',
                'cancellation',
            ];
            for (const section of essentialSections) {
                expect(CLAUDE_MD_CONTENT).toContain(section);
            }
        });
        it('should reference all core agents', () => {
            // The new CLAUDE.md has agents in tables and examples
            // We'll check for a subset of key agents to ensure the section exists
            const keyAgents = [
                'architect',
                'executor',
                'explore',
                'designer',
                'writer',
                'planner',
            ];
            for (const agent of keyAgents) {
                // Agents appear in tables and delegation examples
                expect(CLAUDE_MD_CONTENT).toContain(agent);
            }
        });
        it('should include model routing', () => {
            // Verify model routing section exists with model names
            expect(CLAUDE_MD_CONTENT).toContain('model_routing');
            expect(CLAUDE_MD_CONTENT).toContain('haiku');
            expect(CLAUDE_MD_CONTENT).toContain('sonnet');
            expect(CLAUDE_MD_CONTENT).toContain('opus');
        });
        it('should document magic keywords and compatibility commands', () => {
            // Keywords are now in skill trigger columns
            // Check for key keywords in the skill tables
            const keywords = [
                'ralph',
                'ulw',
                'plan',
            ];
            for (const keyword of keywords) {
                expect(CLAUDE_MD_CONTENT).toContain(keyword);
            }
            // Verify skills section exists with trigger patterns
            expect(CLAUDE_MD_CONTENT).toContain('skills');
            expect(CLAUDE_MD_CONTENT).toContain('trigger');
        });
        it('should contain XML behavioral tags', () => {
            // Check for XML tag structure used in best-practices rewrite
            expect(CLAUDE_MD_CONTENT).toMatch(/<\w+>/); // Contains opening tags
            expect(CLAUDE_MD_CONTENT).toMatch(/<\/\w+>/); // Contains closing tags
        });
    });
    describe('VERSION', () => {
        it('should be properly formatted', () => {
            expect(typeof VERSION).toBe('string');
            // Semantic versioning pattern (with optional beta suffix)
            expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
        });
        it('should match package.json version', async () => {
            const { readFileSync } = await import('fs');
            const { join, dirname } = await import('path');
            const { fileURLToPath } = await import('url');
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
            expect(VERSION).toBe(pkg.version);
        });
    });
    describe('File Paths', () => {
        it('should define valid directory paths', () => {
            const expectedBase = join(homedir(), '.claude');
            expect(CLAUDE_CONFIG_DIR).toBe(expectedBase);
            expect(AGENTS_DIR).toBe(join(expectedBase, 'agents'));
            expect(COMMANDS_DIR).toBe(join(expectedBase, 'commands'));
            expect(SKILLS_DIR).toBe(join(expectedBase, 'skills'));
            expect(HOOKS_DIR).toBe(join(expectedBase, 'hooks'));
        });
        it('should use absolute paths', () => {
            const paths = [
                CLAUDE_CONFIG_DIR,
                AGENTS_DIR,
                COMMANDS_DIR,
                SKILLS_DIR,
                HOOKS_DIR,
            ];
            for (const path of paths) {
                // Absolute path: starts with / or ~ (Unix) or drive letter like C: (Windows)
                expect(path).toMatch(/^([/~]|[A-Za-z]:)/);
            }
        });
    });
    describe('Content Consistency', () => {
        it('should not have duplicate agent definitions', () => {
            const agentKeys = Object.keys(AGENT_DEFINITIONS);
            const uniqueAgentKeys = new Set(agentKeys);
            expect(agentKeys.length).toBe(uniqueAgentKeys.size);
        });
        it('should not have duplicate command definitions', () => {
            const commandKeys = Object.keys(COMMAND_DEFINITIONS);
            const uniqueCommandKeys = new Set(commandKeys);
            expect(commandKeys.length).toBe(uniqueCommandKeys.size);
        });
        it('should have agents referenced in CLAUDE.md exist in AGENT_DEFINITIONS', () => {
            const agentMatches = CLAUDE_MD_CONTENT.matchAll(/\`([a-z-]+)\`\s*\|\s*(Opus|Sonnet|Haiku)/g);
            for (const match of agentMatches) {
                const agentName = match[1];
                // Find corresponding agent file
                const agentFile = Object.keys(AGENT_DEFINITIONS).find(key => {
                    const content = AGENT_DEFINITIONS[key];
                    const nameMatch = content.match(/^name:\s+(\S+)/m);
                    return nameMatch && nameMatch[1] === agentName;
                });
                expect(agentFile).toBeTruthy();
            }
        });
        it('should have all agent definitions contain role descriptions', () => {
            // Agents that use different description formats (not "You are a..." style)
            const alternateFormatAgents = ['qa-tester.md'];
            for (const [filename, content] of Object.entries(AGENT_DEFINITIONS)) {
                // Skip non-agent files
                if (filename === 'AGENTS.md')
                    continue;
                // Skip tiered variants and agents with alternate formats
                if (!filename.includes('-low') && !filename.includes('-medium') && !filename.includes('-high') && !alternateFormatAgents.includes(filename)) {
                    // Check for either <Role> tags or role description in various forms
                    const hasRoleSection = content.includes('<Role>') ||
                        content.includes('You are a') ||
                        content.includes('You are an') ||
                        content.includes('You interpret') ||
                        content.includes('Named after');
                    expect(hasRoleSection).toBe(true);
                }
            }
        });
        it('should have read-only agents not include Edit/Write tools', () => {
            const readOnlyAgents = ['architect.md', 'critic.md', 'analyst.md'];
            for (const agent of readOnlyAgents) {
                const content = AGENT_DEFINITIONS[agent];
                // Read-only agents use disallowedTools: to block Edit/Write
                const disallowedMatch = content.match(/^disallowedTools:\s+(.+)/m);
                expect(disallowedMatch).toBeTruthy();
                const disallowed = disallowedMatch[1];
                expect(disallowed).toMatch(/\bEdit\b/);
                expect(disallowed).toMatch(/\bWrite\b/);
            }
        });
        it('should have implementation agents include Edit/Write tools', () => {
            const implementationAgents = [
                'executor.md',
                'designer.md',
                'writer.md',
            ];
            for (const agent of implementationAgents) {
                const content = AGENT_DEFINITIONS[agent];
                // Implementation agents should NOT have Edit/Write in disallowedTools
                // (If no disallowedTools field exists, all tools are available by default)
                const disallowedMatch = content.match(/^disallowedTools:\s+(.+)/m);
                if (disallowedMatch) {
                    const disallowed = disallowedMatch[1];
                    // If disallowedTools exists, Edit and Write should NOT be in it
                    expect(disallowed).not.toMatch(/\bEdit\b/);
                    expect(disallowed).not.toMatch(/\bWrite\b/);
                }
                // If no disallowedTools, all tools including Edit/Write are available - test passes
            }
        });
    });
    describe('Plugin Detection', () => {
        let originalEnv;
        beforeEach(() => {
            // Save original env var
            originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
        });
        afterEach(() => {
            // Restore original env var
            if (originalEnv !== undefined) {
                process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
            }
            else {
                delete process.env.CLAUDE_PLUGIN_ROOT;
            }
        });
        it('should return false when CLAUDE_PLUGIN_ROOT is not set', () => {
            delete process.env.CLAUDE_PLUGIN_ROOT;
            expect(isRunningAsPlugin()).toBe(false);
        });
        it('should return true when CLAUDE_PLUGIN_ROOT is set', () => {
            process.env.CLAUDE_PLUGIN_ROOT = '/home/user/.claude/plugins/marketplaces/oh-my-claudecode';
            expect(isRunningAsPlugin()).toBe(true);
        });
        it('should detect plugin context from environment variable', () => {
            process.env.CLAUDE_PLUGIN_ROOT = '/any/path';
            expect(isRunningAsPlugin()).toBe(true);
        });
    });
    describe('Project-Scoped Plugin Detection', () => {
        let originalEnv;
        beforeEach(() => {
            originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
        });
        afterEach(() => {
            if (originalEnv !== undefined) {
                process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
            }
            else {
                delete process.env.CLAUDE_PLUGIN_ROOT;
            }
        });
        it('should return false when CLAUDE_PLUGIN_ROOT is not set', () => {
            delete process.env.CLAUDE_PLUGIN_ROOT;
            expect(isProjectScopedPlugin()).toBe(false);
        });
        it('should return false for global plugin installation', () => {
            // Global plugins are under ~/.claude/plugins/
            process.env.CLAUDE_PLUGIN_ROOT = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '3.9.0');
            expect(isProjectScopedPlugin()).toBe(false);
        });
        it('should return true for project-scoped plugin installation', () => {
            // Project-scoped plugins are in the project's .claude/plugins/ directory
            process.env.CLAUDE_PLUGIN_ROOT = '/home/user/myproject/.claude/plugins/oh-my-claudecode';
            expect(isProjectScopedPlugin()).toBe(true);
        });
        it('should return true when plugin is outside global plugin directory', () => {
            // Any path that's not under ~/.claude/plugins/ is considered project-scoped
            process.env.CLAUDE_PLUGIN_ROOT = '/var/projects/app/.claude/plugins/omc';
            expect(isProjectScopedPlugin()).toBe(true);
        });
        it('should handle Windows-style paths', () => {
            // Windows paths with backslashes should be normalized
            process.env.CLAUDE_PLUGIN_ROOT = 'C:\\Users\\user\\project\\.claude\\plugins\\omc';
            expect(isProjectScopedPlugin()).toBe(true);
        });
        it('should handle trailing slashes in paths', () => {
            process.env.CLAUDE_PLUGIN_ROOT = join(homedir(), '.claude', 'plugins', 'cache', 'omc') + '/';
            expect(isProjectScopedPlugin()).toBe(false);
        });
    });
    describe('Content Quality', () => {
        it('should not contain unintended placeholder text', () => {
            const allContent = [
                ...Object.values(AGENT_DEFINITIONS),
                ...Object.values(COMMAND_DEFINITIONS),
                CLAUDE_MD_CONTENT,
            ];
            // Note: "TODO" appears intentionally in "Todo_Discipline", "TodoWrite" tool, and "TODO OBSESSION"
            // These are legitimate uses, not placeholder text to be filled in later
            const placeholders = ['FIXME', 'XXX', '[placeholder]'];
            // TBD checked with word boundary to avoid matching "JTBD" (Jobs To Be Done)
            const wordBoundaryPlaceholders = [/\bTBD\b/];
            for (const content of allContent) {
                for (const placeholder of placeholders) {
                    expect(content).not.toContain(placeholder);
                }
                for (const pattern of wordBoundaryPlaceholders) {
                    expect(pattern.test(content)).toBe(false);
                }
                // Check for standalone TODO that looks like a placeholder
                // (e.g., "TODO: implement this" but not "TODO LIST" or "TODO OBSESSION")
                const todoPlaceholderPattern = /TODO:\s+[a-z]/i;
                const hasTodoPlaceholder = todoPlaceholderPattern.test(content);
                expect(hasTodoPlaceholder).toBe(false);
            }
        });
        it('should not contain excessive blank lines', () => {
            const allContent = [
                ...Object.values(AGENT_DEFINITIONS),
                ...Object.values(COMMAND_DEFINITIONS),
            ];
            for (const content of allContent) {
                // No more than 3 consecutive blank lines
                expect(content).not.toMatch(/\n\n\n\n+/);
            }
        });
        it('should have proper markdown formatting in frontmatter', () => {
            for (const [filename, content] of Object.entries(AGENT_DEFINITIONS)) {
                // Skip non-agent files
                if (filename === 'AGENTS.md')
                    continue;
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                expect(frontmatterMatch).toBeTruthy();
                const frontmatter = frontmatterMatch[1];
                // Each line should be key: value format (allow camelCase keys like disallowedTools)
                const lines = frontmatter.split('\n').filter((line) => line.trim());
                for (const line of lines) {
                    expect(line).toMatch(/^[a-zA-Z]+:\s+.+/);
                }
            }
        });
    });
});
//# sourceMappingURL=installer.test.js.map