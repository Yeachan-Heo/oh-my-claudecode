import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { getAgentDefinitions } from '../agents/definitions.js';
import { loadAgentPrompt } from '../agents/utils.js';
import { loadConfig } from '../config/loader.js';
import { createOmcSession } from '../index.js';
import { clearWorktreeCache, getOmcRoot } from '../lib/worktree-paths.js';

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
  'XDG_CONFIG_HOME',
  'OMC_STATE_DIR',
] as const;

describe('Agent Registry Validation', () => {
  let savedEnv: Record<string, string | undefined>;
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'omc-agent-registry-'));
    process.chdir(tempDir);

    savedEnv = {};
    for (const key of MODEL_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of MODEL_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    clearWorktreeCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
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
    expect(agents.architect?.model).not.toBe('claude-opus-4-8');
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

  test('discovers project custom agents with Claude Code frontmatter and omc metadata', () => {
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'proto-reviewer.md'), `---
name: proto-reviewer
description: Reviews protobuf schema changes (Sonnet)
model: sonnet
disallowedTools: Write, Edit
omc:
  category: reviewer
  cost: CHEAP
  promptAlias: proto
  triggers:
    - domain: protobuf schemas
      trigger: ".proto files added or modified"
  useWhen:
    - "Schema review before merge"
  avoidWhen:
    - "General code review"
---

<Agent_Prompt>
Review protobuf compatibility.
</Agent_Prompt>
`);

    const agents = getAgentDefinitions();

    expect(agents['proto-reviewer']).toMatchObject({
      name: 'proto-reviewer',
      description: 'Reviews protobuf schema changes (Sonnet)',
      model: 'sonnet',
      defaultModel: 'sonnet',
      disallowedTools: ['Write', 'Edit'],
    });
    expect(agents['proto-reviewer']?.prompt).toContain('Review protobuf compatibility.');
    expect(agents['proto-reviewer']?.metadata).toMatchObject({
      category: 'reviewer',
      cost: 'CHEAP',
      promptAlias: 'proto',
      triggers: [{ domain: 'protobuf schemas', trigger: '.proto files added or modified' }],
      useWhen: ['Schema review before merge'],
      avoidWhen: ['General code review'],
    });
  });

  test('project custom agents override user custom agents with the same name', () => {
    const userAgentsDir = path.join(process.env.XDG_CONFIG_HOME!, 'claude-omc', 'agents');
    const projectAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.mkdirSync(projectAgentsDir, { recursive: true });

    fs.writeFileSync(path.join(userAgentsDir, 'domain-agent.md'), `---
name: domain-agent
description: User version
---

user prompt
`);
    fs.writeFileSync(path.join(projectAgentsDir, 'domain-agent.md'), `---
name: domain-agent
description: Project version
---

project prompt
`);

    const agents = getAgentDefinitions();

    expect(agents['domain-agent']?.description).toBe('Project version');
    expect(agents['domain-agent']?.prompt).toBe('project prompt');
  });

  test('rejects custom agents that collide with built-ins by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'executor.md'), `---
name: executor
description: Replacement executor
---

custom executor prompt
`);

    const agents = getAgentDefinitions();

    expect(agents.executor?.description).not.toBe('Replacement executor');
    expect(agents.executor?.prompt).not.toBe('custom executor prompt');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collides with a built-in agent'));
    warn.mockRestore();
  });

  test('team.roleRouting accepts discovered custom agent names', () => {
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'proto-reviewer.md'), `---
name: proto-reviewer
description: Reviews protobuf schema changes
---

Review protobuf compatibility.
`);
    fs.writeFileSync(path.join(claudeDir, 'omc.jsonc'), JSON.stringify({
      team: {
        roleRouting: {
          'code-reviewer': { agent: 'proto-reviewer' },
        },
      },
    }));

    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().team?.roleRouting?.['code-reviewer']?.agent).toBe('proto-reviewer');
  });

  test('team.roleRouting accepts built-in registry names in addition to config keys', () => {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'omc.jsonc'), JSON.stringify({
      team: {
        roleRouting: {
          critic: { agent: 'code-reviewer' },
        },
      },
    }));

    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().team?.roleRouting?.critic?.agent).toBe('code-reviewer');
  });

  test('scans extra customAgents.dirs relative to the project root', () => {
    const extraDir = path.join(tempDir, 'team-agents');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'release-checker.md'), `---
name: release-checker
description: Reviews release readiness
---

Check release notes and versioning.
`);

    const agents = getAgentDefinitions({
      config: {
        customAgents: {
          enabled: true,
          dirs: ['./team-agents'],
        },
      },
    });

    expect(agents['release-checker']?.description).toBe('Reviews release readiness');
  });

  test('scans project custom agents through the resolved OMC root', () => {
    const projectDir = path.join(tempDir, 'project');
    const stateDir = path.join(tempDir, 'central-state');
    fs.mkdirSync(projectDir, { recursive: true });
    process.env.OMC_STATE_DIR = stateDir;
    clearWorktreeCache();

    const customAgentsDir = path.join(getOmcRoot(projectDir), 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'state-root-agent.md'), `---
name: state-root-agent
description: Uses centralized state root
---

Read from the resolved OMC root.
`);

    const agents = getAgentDefinitions({ cwd: projectDir });

    expect(customAgentsDir).toContain(stateDir);
    expect(agents['state-root-agent']?.prompt).toBe('Read from the resolved OMC root.');
  });

  test('createOmcSession scans custom agents from the provided workingDirectory', () => {
    const projectDir = path.join(tempDir, 'project-session');
    const customAgentsDir = path.join(getOmcRoot(projectDir), 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'session-agent.md'), `---
name: session-agent
description: Loaded from session working directory
omc:
  category: specialist
  cost: CHEAP
  promptAlias: session
  triggers:
    - domain: session projects
      trigger: "session workingDirectory is provided"
---

Use the session project context.
`);

    const session = createOmcSession({ workingDirectory: projectDir });

    expect(session.queryOptions.options.agents['session-agent']?.description)
      .toBe('Loaded from session working directory');
    expect(session.queryOptions.options.systemPrompt).toContain('**session-agent**');
  });

  test('same-name project overrides are allowed after customAgents.maxAgents is reached', () => {
    const userAgentsDir = path.join(process.env.XDG_CONFIG_HOME!, 'claude-omc', 'agents');
    const projectAgentsDir = path.join(getOmcRoot(tempDir), 'agents');
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.mkdirSync(projectAgentsDir, { recursive: true });

    fs.writeFileSync(path.join(userAgentsDir, 'domain-agent.md'), `---
name: domain-agent
description: User version
---

user prompt
`);
    fs.writeFileSync(path.join(projectAgentsDir, 'domain-agent.md'), `---
name: domain-agent
description: Project version
---

project prompt
`);

    const agents = getAgentDefinitions({
      config: {
        customAgents: {
          enabled: true,
          maxAgents: 1,
        },
      },
    });

    expect(agents['domain-agent']?.description).toBe('Project version');
  });

  test('keeps comma-containing scalar frontmatter descriptions as strings', () => {
    const customAgentsDir = path.join(getOmcRoot(tempDir), 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'api-reviewer.md'), `---
name: api-reviewer
description: Reviews APIs, schemas, and contracts
---

Review API boundaries.
`);

    const agents = getAgentDefinitions();

    expect(agents['api-reviewer']?.description).toBe('Reviews APIs, schemas, and contracts');
  });

  test('allows custom agents to override built-ins only with omc.overrideBuiltin', () => {
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'executor.md'), `---
name: executor
description: Project executor override
omc:
  overrideBuiltin: true
---

project executor prompt
`);

    const agents = getAgentDefinitions();

    expect(agents.executor?.description).toBe('Project executor override');
    expect(agents.executor?.prompt).toBe('project executor prompt');
  });

  test('loadAgentPrompt can read custom agent prompts from project source dir', () => {
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'schema-critic.md'), `---
name: schema-critic
description: Reviews schema changes
---

Review schemas from the custom source directory.
`);

    expect(loadAgentPrompt('schema-critic')).toBe('Review schemas from the custom source directory.');
  });

  test('adds custom agents with metadata to generated orchestrator prompt sections', () => {
    const customAgentsDir = path.join(tempDir, '.omc', 'agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(customAgentsDir, 'schema-critic.md'), `---
name: schema-critic
description: Reviews schema changes
omc:
  category: reviewer
  cost: CHEAP
  promptAlias: schema
  triggers:
    - domain: database schemas
      trigger: "schema files changed"
  useWhen:
    - "Schema compatibility review"
  avoidWhen:
    - "General implementation"
---

Review schemas from the custom source directory.
`);

    const session = createOmcSession();
    const systemPrompt = session.queryOptions.options.systemPrompt;

    expect(systemPrompt).toContain('## Custom Subagents');
    expect(systemPrompt).toContain('**schema-critic**');
    expect(systemPrompt).toContain('| schema | CHEAP | database schemas: schema files changed |');
    expect(systemPrompt).toContain('**database schemas** → schema: schema files changed');
    expect(systemPrompt).toContain('### schema-critic Use/Avoid Guidance');
  });
});
