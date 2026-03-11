import { beforeEach, afterEach, describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentDefinitions } from '../agents/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_ENV_KEYS = [
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
] as const;

describe('Agent Registry Validation', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of MODEL_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODEL_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });
  test('agent count matches documentation', () => {
    const agentsDir = path.join(__dirname, '../../agents');
    const promptFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md') && file !== 'AGENTS.md');
    expect(promptFiles.length).toBe(19);
  });

  test('agent count is always 19 (no conditional agents)', () => {
    const agents = getAgentDefinitions();
    expect(Object.keys(agents).length).toBe(19);
    expect(Object.keys(agents)).toContain('tracer');
    // Consolidated agents should not be in registry
    expect(Object.keys(agents)).not.toContain('harsh-critic');
    expect(Object.keys(agents)).not.toContain('quality-reviewer');
    expect(Object.keys(agents)).not.toContain('deep-executor');
    expect(Object.keys(agents)).not.toContain('build-fixer');
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

  test('resolves agent models from env-based tier defaults', () => {
    process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-v1:0';

    const agents = getAgentDefinitions();

    expect(agents.architect?.model).toBe('us.anthropic.claude-opus-4-6-v1:0');
    expect(agents.executor?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(agents.explore?.model).toBe('us.anthropic.claude-haiku-4-5-v1:0');
    expect(agents.tracer?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
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
