import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentDefinitions } from '../agents/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Agent Registry Validation', () => {
  test('agent count matches documentation', () => {
    const agentsDir = path.join(__dirname, '../../agents');
    const promptFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md') && file !== 'AGENTS.md');
    expect(promptFiles.length).toBe(21);
  });

  test('all agents have .md prompt files', () => {
    const agents = Object.keys(getAgentDefinitions());
    const agentsDir = path.join(__dirname, '../../agents');
    const promptFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md') && file !== 'AGENTS.md');
    for (const file of promptFiles) {
      const name = file.replace(/\.md$/, '');
      expect(agents, `Missing registry entry for agent: ${name}`).toContain(name);
    }
  });

  test('all registry agents are exported from index.ts', async () => {
    const registryAgents = Object.keys(getAgentDefinitions());
    const exports = await import('../agents/index.js') as Record<string, unknown>;
    const deprecatedAliases = ['researcher', 'tdd-guide'];
    for (const name of registryAgents) {
      if (deprecatedAliases.includes(name)) continue;
      const exportName = name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase()) + 'Agent';
      expect(exports[exportName], `Missing export for agent: ${name} (expected ${exportName})`).toBeDefined();
    }
  });

  test('no hardcoded prompts in base agent .ts files', () => {
    const baseAgents = ['architect', 'executor', 'explore', 'designer', 'document-specialist',
                        'writer', 'planner', 'critic', 'analyst', 'scientist', 'qa-tester'];
    const agentsDir = path.join(__dirname, '../agents');
    for (const name of baseAgents) {
      const content = fs.readFileSync(path.join(agentsDir, `${name}.ts`), 'utf-8');
      expect(content, `Hardcoded prompt found in ${name}.ts`).not.toMatch(/const\s+\w+_PROMPT\s*=\s*`/);
    }
  });
});
