import { beforeEach, afterEach, describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentDefinitions } from '../agents/definitions.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_ENV_KEYS = [
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'OMC_MODEL_HIGH',
    'OMC_MODEL_MEDIUM',
    'OMC_MODEL_LOW',
    'OMC_ROUTING_FORCE_INHERIT',
];
describe('Agent Registry Validation', () => {
    let savedEnv;
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
            }
            else {
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
        const exports = await import('../agents/index.js');
        const deprecatedAliases = ['researcher', 'tdd-guide'];
        for (const name of registryAgents) {
            if (deprecatedAliases.includes(name))
                continue;
            const exportName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + 'Agent';
            expect(exports[exportName], `Missing export for agent: ${name} (expected ${exportName})`).toBeDefined();
        }
    });
    test('resolves agent models from env-based tier defaults when forceInherit is disabled', async () => {
        process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
        process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
        process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-v1:0';
        process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
        const agents = getAgentDefinitions();
        expect(agents.architect?.model).toBe('us.anthropic.claude-opus-4-6-v1:0');
        expect(agents.executor?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
        expect(agents.explore?.model).toBe('us.anthropic.claude-haiku-4-5-v1:0');
        expect(agents.tracer?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    });
    test('inherits parent session model when forceInherit is enabled and no configured model exists', async () => {
        process.env.CLAUDE_MODEL = 'claude-3-7-session-parent';
        const { DEFAULT_CONFIG } = await import('../config/loader.js');
        const agents = getAgentDefinitions({
            config: {
                ...DEFAULT_CONFIG,
                agents: {},
                routing: {
                    ...DEFAULT_CONFIG.routing,
                    forceInherit: true,
                },
            },
        });
        expect(agents.executor?.model).toBe('claude-3-7-session-parent');
    });
    test('inherits medium tier env model when forceInherit is enabled without parent model env', async () => {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1:cloud';
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';
        const { DEFAULT_CONFIG } = await import('../config/loader.js');
        const agents = getAgentDefinitions({
            config: {
                ...DEFAULT_CONFIG,
                agents: {},
                routing: {
                    ...DEFAULT_CONFIG.routing,
                    forceInherit: true,
                },
            },
        });
        expect(agents.executor?.model).toBe('kimi-k2.6:cloud');
        expect(agents.architect?.model).toBe('kimi-k2.6:cloud');
    });
    test('tier env fallback avoids hardcoded Claude agent models without global forceInherit', () => {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1:cloud';
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';
        const agents = getAgentDefinitions();
        expect(agents.executor?.model).toBe('kimi-k2.6:cloud');
        expect(agents.architect?.model).toBe('glm-5.1:cloud');
        expect(agents.architect?.model).not.toBe('claude-opus-4-7');
    });
    test('partial tier env override does not collapse all agents to inherit', () => {
        process.env.OMC_MODEL_HIGH = 'glm-5.1:cloud';
        const agents = getAgentDefinitions();
        expect(agents.architect?.model).toBe('glm-5.1:cloud');
        expect(agents.executor?.model).toContain('claude-sonnet');
        expect(agents.executor?.model).not.toBe('glm-5.1:cloud');
    });
    test('explicit override model still wins when forceInherit is enabled', async () => {
        process.env.CLAUDE_MODEL = 'claude-3-7-session-parent';
        const { DEFAULT_CONFIG } = await import('../config/loader.js');
        const agents = getAgentDefinitions({
            config: {
                ...DEFAULT_CONFIG,
                agents: {},
                routing: {
                    ...DEFAULT_CONFIG.routing,
                    forceInherit: true,
                },
            },
            overrides: {
                executor: {
                    model: 'opus',
                },
            },
        });
        expect(agents.executor?.model).toBe('opus');
    });
    test('keeps agent fallback model when forceInherit is disabled and no configured model exists', async () => {
        process.env.CLAUDE_MODEL = 'claude-3-7-session-parent';
        const { DEFAULT_CONFIG } = await import('../config/loader.js');
        const agents = getAgentDefinitions({
            config: {
                ...DEFAULT_CONFIG,
                agents: {},
                routing: {
                    ...DEFAULT_CONFIG.routing,
                    forceInherit: false,
                },
            },
        });
        expect(agents.executor?.model).toBe('sonnet');
        expect(agents.executor?.model).not.toBe('claude-3-7-session-parent');
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
//# sourceMappingURL=agent-registry.test.js.map