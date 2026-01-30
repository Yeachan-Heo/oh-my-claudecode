import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentDefinitions } from '../agents/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Agent Registry Validation', () => {
  test('agent count matches documentation', () => {
    const agents = getAgentDefinitions();
    expect(Object.keys(agents).length).toBe(32);
  });

  test('all agents have .md prompt files', () => {
    const agents = Object.keys(getAgentDefinitions());
    const agentsDir = path.join(__dirname, '../../agents');
    for (const name of agents) {
      const mdPath = path.join(agentsDir, `${name}.md`);
      expect(fs.existsSync(mdPath), `Missing .md file for agent: ${name}`).toBe(true);
    }
  });

  test('all registry agents are exported from index.ts', async () => {
    const registryAgents = Object.keys(getAgentDefinitions());
    const exports = await import('../agents/index.js') as Record<string, unknown>;
    for (const name of registryAgents) {
      const exportName = name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase()) + 'Agent';
      expect(exports[exportName], `Missing export for agent: ${name} (expected ${exportName})`).toBeDefined();
    }
  });

  test('no hardcoded prompts in base agent .ts files', () => {
    const baseAgents = ['architect', 'executor', 'explore', 'designer', 'researcher',
                        'writer', 'vision', 'planner', 'critic', 'analyst', 'scientist', 'qa-tester'];
    const agentsDir = path.join(__dirname, '../agents');
    for (const name of baseAgents) {
      const content = fs.readFileSync(path.join(agentsDir, `${name}.ts`), 'utf-8');
      expect(content, `Hardcoded prompt found in ${name}.ts`).not.toMatch(/const\s+\w+_PROMPT\s*=\s*`/);
    }
  });
});
