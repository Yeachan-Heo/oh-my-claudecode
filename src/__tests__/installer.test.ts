import { describe, it, expect } from 'vitest';
import {
  AGENT_DEFINITIONS,
  COMMAND_DEFINITIONS,
  CLAUDE_MD_CONTENT,
  VERSION,
  CLAUDE_CONFIG_DIR,
  AGENTS_DIR,
  COMMANDS_DIR,
  SKILLS_DIR,
  HOOKS_DIR,
} from '../installer/index.js';
import { join } from 'path';
import { homedir } from 'os';

describe('Installer Constants', () => {
  describe('AGENT_DEFINITIONS', () => {
    it('should contain expected core agents', () => {
      const expectedAgents = [
        'oracle.md',
        'librarian.md',
        'explore.md',
        'frontend-engineer.md',
        'document-writer.md',
        'multimodal-looker.md',
        'momus.md',
        'metis.md',
        'sisyphus-junior.md',
        'prometheus.md',
        'qa-tester.md',
      ];

      for (const agent of expectedAgents) {
        expect(AGENT_DEFINITIONS).toHaveProperty(agent);
        expect(typeof AGENT_DEFINITIONS[agent]).toBe('string');
        expect(AGENT_DEFINITIONS[agent].length).toBeGreaterThan(0);
      }
    });

    it('should contain tiered agent variants', () => {
      const tieredAgents = [
        'oracle-medium.md',
        'oracle-low.md',
        'sisyphus-junior-high.md',
        'sisyphus-junior-low.md',
        'librarian-low.md',
        'explore-medium.md',
        'frontend-engineer-low.md',
        'frontend-engineer-high.md',
      ];

      for (const agent of tieredAgents) {
        expect(AGENT_DEFINITIONS).toHaveProperty(agent);
        expect(typeof AGENT_DEFINITIONS[agent]).toBe('string');
      }
    });

    it('should have valid frontmatter for each agent', () => {
      for (const [_filename, content] of Object.entries(AGENT_DEFINITIONS)) {
        // Check for frontmatter delimiters
        expect(content).toMatch(/^---\n/);
        expect(content).toMatch(/\n---\n/);

        // Extract frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(frontmatterMatch).toBeTruthy();

        const frontmatter = frontmatterMatch![1];

        // Check required fields
        expect(frontmatter).toMatch(/^name:\s+\S+/m);
        expect(frontmatter).toMatch(/^description:\s+.+/m);
        expect(frontmatter).toMatch(/^tools:\s+.+/m);
        expect(frontmatter).toMatch(/^model:\s+(haiku|sonnet|opus)/m);
      }
    });

    it('should have unique agent names', () => {
      const names = new Set<string>();

      for (const content of Object.values(AGENT_DEFINITIONS)) {
        const nameMatch = content.match(/^name:\s+(\S+)/m);
        expect(nameMatch).toBeTruthy();

        const name = nameMatch![1];
        expect(names.has(name)).toBe(false);
        names.add(name);
      }
    });

    it('should have consistent model assignments', () => {
      const modelExpectations: Record<string, string> = {
        'oracle.md': 'opus',
        'oracle-medium.md': 'sonnet',
        'oracle-low.md': 'haiku',
        'librarian.md': 'sonnet',
        'librarian-low.md': 'haiku',
        'explore.md': 'haiku',
        'explore-medium.md': 'sonnet',
        'sisyphus-junior.md': 'sonnet',
        'sisyphus-junior-high.md': 'opus',
        'sisyphus-junior-low.md': 'haiku',
        'frontend-engineer.md': 'sonnet',
        'frontend-engineer-low.md': 'haiku',
        'frontend-engineer-high.md': 'opus',
        'document-writer.md': 'haiku',
        'multimodal-looker.md': 'sonnet',
        'momus.md': 'opus',
        'metis.md': 'opus',
        'prometheus.md': 'opus',
        'qa-tester.md': 'sonnet',
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
    it('should contain expected commands', () => {
      const expectedCommands = [
        'ultrawork/skill.md',
        'deepsearch/skill.md',
        'analyze/skill.md',
        'sisyphus/skill.md',
        'sisyphus-default.md',
        'sisyphus-default-global.md',
        'plan.md',
        'review/skill.md',
        'prometheus/skill.md',
        'ralph-loop/skill.md',
        'cancel-ralph.md',
      ];

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

        const frontmatter = frontmatterMatch![1];

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
      const commandsWithArgs = [
        'ultrawork/skill.md',
        'deepsearch/skill.md',
        'analyze/skill.md',
        'sisyphus/skill.md',
        'sisyphus-default.md',
        'sisyphus-default-global.md',
        'plan.md',
        'review/skill.md',
        'prometheus/skill.md',
        'ralph-loop/skill.md',
      ];

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
        'Sisyphus Multi-Agent System',
        'DEFAULT OPERATING MODE',
        'Available Subagents',
        'Slash Commands',
        'CONTINUATION ENFORCEMENT',
      ];

      for (const section of essentialSections) {
        expect(CLAUDE_MD_CONTENT).toContain(section);
      }
    });

    it('should reference all core agents', () => {
      const coreAgents = [
        'oracle',
        'librarian',
        'explore',
        'frontend-engineer',
        'document-writer',
        'multimodal-looker',
        'momus',
        'metis',
        'sisyphus-junior',
        'prometheus',
        'qa-tester',
      ];

      for (const agent of coreAgents) {
        // Agents are prefixed with oh-my-claude-sisyphus: in the content
        expect(CLAUDE_MD_CONTENT).toMatch(new RegExp(`oh-my-claude-sisyphus:${agent}`));
      }
    });

    it('should include tiered agent routing table', () => {
      expect(CLAUDE_MD_CONTENT).toContain('Smart Model Routing');
      expect(CLAUDE_MD_CONTENT).toContain('oracle-low');
      expect(CLAUDE_MD_CONTENT).toContain('oracle-medium');
      expect(CLAUDE_MD_CONTENT).toContain('sisyphus-junior-low');
      expect(CLAUDE_MD_CONTENT).toContain('sisyphus-junior-high');
    });

    it('should document all slash commands', () => {
      const commands = [
        '/ultrawork',
        '/deepsearch',
        '/analyze',
        '/plan',
        '/review',
        '/prometheus',
        '/ralph-loop',
        '/cancel-ralph',
        '/deepinit',
      ];

      for (const command of commands) {
        expect(CLAUDE_MD_CONTENT).toContain(command);
      }
    });

    it('should contain markdown tables', () => {
      // Check for table structure
      expect(CLAUDE_MD_CONTENT).toMatch(/\|[^\n]+\|/); // Contains pipes
      expect(CLAUDE_MD_CONTENT).toMatch(/\|[-\s]+\|/); // Contains separator row
    });
  });

  describe('VERSION', () => {
    it('should be properly formatted', () => {
      expect(typeof VERSION).toBe('string');
      // Semantic versioning pattern (with optional beta suffix)
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    });

    it('should match package.json version', () => {
      // This is a runtime check - VERSION should match the package.json
      expect(VERSION).toBe('2.4.1');
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
        expect(path).toMatch(/^[/~]/); // Starts with / or ~ (absolute)
      }
    });
  });

  describe('Content Consistency', () => {
    it('should not have duplicate agent/command definitions', () => {
      const allKeys = [
        ...Object.keys(AGENT_DEFINITIONS),
        ...Object.keys(COMMAND_DEFINITIONS),
      ];

      const uniqueKeys = new Set(allKeys);
      expect(allKeys.length).toBe(uniqueKeys.size);
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
      for (const [filename, content] of Object.entries(AGENT_DEFINITIONS)) {
        // Most agents should have role definitions (either <Role> tags or clear role descriptions)
        // Some agents like 'explore.md' and 'multimodal-looker.md' use different formatting
        if (!filename.includes('-low') && !filename.includes('-medium') && !filename.includes('-high')) {
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
      const readOnlyAgents = ['oracle.md', 'oracle-medium.md', 'oracle-low.md', 'momus.md', 'metis.md'];

      for (const agent of readOnlyAgents) {
        const content = AGENT_DEFINITIONS[agent];
        const toolsMatch = content.match(/^tools:\s+(.+)/m);
        expect(toolsMatch).toBeTruthy();

        const tools = toolsMatch![1];
        expect(tools).not.toMatch(/\bEdit\b/);
        expect(tools).not.toMatch(/\bWrite\b/);
      }
    });

    it('should have implementation agents include Edit/Write tools', () => {
      const implementationAgents = [
        'sisyphus-junior.md',
        'sisyphus-junior-high.md',
        'sisyphus-junior-low.md',
        'frontend-engineer.md',
        'document-writer.md',
      ];

      for (const agent of implementationAgents) {
        const content = AGENT_DEFINITIONS[agent];
        const toolsMatch = content.match(/^tools:\s+(.+)/m);
        expect(toolsMatch).toBeTruthy();

        const tools = toolsMatch![1];
        expect(tools).toMatch(/\b(Edit|Write)\b/);
      }
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
      const placeholders = ['FIXME', 'XXX', '[placeholder]', 'TBD'];

      for (const content of allContent) {
        for (const placeholder of placeholders) {
          expect(content).not.toContain(placeholder);
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
      for (const content of Object.values(AGENT_DEFINITIONS)) {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        expect(frontmatterMatch).toBeTruthy();

        const frontmatter = frontmatterMatch![1];

        // Each line should be key: value format
        const lines = frontmatter.split('\n').filter(line => line.trim());
        for (const line of lines) {
          expect(line).toMatch(/^[a-z]+:\s+.+/);
        }
      }
    });
  });
});
