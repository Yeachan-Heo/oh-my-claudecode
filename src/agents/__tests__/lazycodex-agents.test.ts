import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { resolveLazyCodexClaudeRoleRoute, type LazyCodexClaudeRole } from '../../interop/lazycodex-model-routing.js';
import { getAgentDefinitions } from '../definitions.js';
import type { PluginConfig } from '../../shared/types.js';

type Boundary = 'read-only' | 'source-write' | 'plan-artifact-write' | 'qa-artifact-write';

type LazyCodexAgentContract = {
  readonly name: string;
  readonly routeRole: LazyCodexClaudeRole;
  readonly boundary: Boundary;
};

const LAZYCODEX_AGENT_CONTRACTS = [
  { name: 'explorer', routeRole: 'explorer', boundary: 'read-only' },
  { name: 'plan', routeRole: 'planner', boundary: 'plan-artifact-write' },
  { name: 'lazycodex-executor', routeRole: 'executor', boundary: 'source-write' },
  { name: 'lazycodex-code-reviewer', routeRole: 'reviewer', boundary: 'read-only' },
  { name: 'metis', routeRole: 'metis', boundary: 'read-only' },
  { name: 'momus', routeRole: 'momus', boundary: 'read-only' },
  { name: 'lazycodex-qa-executor', routeRole: 'verifier', boundary: 'qa-artifact-write' },
  { name: 'lazycodex-gate-reviewer', routeRole: 'high-risk', boundary: 'read-only' },
] as const satisfies readonly LazyCodexAgentContract[];

const TEST_CONFIG: PluginConfig = {
  routing: {
    forceInherit: false,
  },
};

function promptPath(agentName: string): string {
  return join(process.cwd(), 'agents', `${agentName}.md`);
}

function routeModelClass(role: LazyCodexClaudeRole): string {
  const result = resolveLazyCodexClaudeRoleRoute(role);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.route.modelFamily;
}

function expectBoundary(tools: readonly string[] | undefined, boundary: Boundary): void {
  expect(tools, 'LazyCodex-compatible agents must declare explicit tool boundaries').toBeDefined();
  const toolSet = new Set(tools);

  switch (boundary) {
    case 'read-only':
      expect(toolSet.has('Edit')).toBe(false);
      expect(toolSet.has('Write')).toBe(false);
      expect(toolSet.has('Read')).toBe(true);
      expect(toolSet.has('Grep')).toBe(true);
      break;
    case 'source-write':
      expect(toolSet.has('Edit')).toBe(true);
      expect(toolSet.has('Write')).toBe(true);
      expect(toolSet.has('Bash')).toBe(true);
      break;
    case 'plan-artifact-write':
      expect(toolSet.has('Write')).toBe(true);
      expect(toolSet.has('Edit')).toBe(false);
      expect(toolSet.has('Read')).toBe(true);
      break;
    case 'qa-artifact-write':
      expect(toolSet.has('Bash')).toBe(true);
      expect(toolSet.has('Edit')).toBe(false);
      expect(toolSet.has('Write')).toBe(false);
      break;
    default:
      boundary satisfies never;
  }
}

describe('LazyCodex-compatible agent registry', () => {
  it('registers every LazyCodex role with a matching prompt file and Claude model class', () => {
    const agents = getAgentDefinitions({ config: TEST_CONFIG });

    for (const contract of LAZYCODEX_AGENT_CONTRACTS) {
      const agent = agents[contract.name];
      expect(agent, `${contract.name} must be registered`).toBeDefined();
      expect(agent.model).toBe(routeModelClass(contract.routeRole));
      expect(agent.defaultModel).toBe(routeModelClass(contract.routeRole));
      expect(existsSync(promptPath(contract.name)), `${contract.name} prompt file must exist`).toBe(true);
    }
  });

  it('keeps LazyCodex role prompts self-contained without inheriting Codex fork context semantics', () => {
    const agents = getAgentDefinitions({ config: TEST_CONFIG });

    for (const contract of LAZYCODEX_AGENT_CONTRACTS) {
      const promptFile = readFileSync(promptPath(contract.name), 'utf8');
      const prompt = agents[contract.name]?.prompt ?? '';

      expect(promptFile).toContain('self-contained initial prompt');
      expect(promptFile).toContain('no inherited parent transcript');
      expect(promptFile).toContain('Claude equivalent of Codex fork_context:false');
      expect(prompt).toContain('self-contained initial prompt');
      expect(prompt).not.toContain('fork_context: false');
    }
  });

  it('enforces read/write tool boundaries for LazyCodex-compatible agents', () => {
    const agents = getAgentDefinitions({ config: TEST_CONFIG });

    for (const contract of LAZYCODEX_AGENT_CONTRACTS) {
      const agent = agents[contract.name];
      expect(agent, `${contract.name} must be registered`).toBeDefined();
      expectBoundary(agent?.tools, contract.boundary);
    }
  });

  it('rejects unknown LazyCodex registry lookups and adds no raw GPT model IDs', () => {
    const agents = getAgentDefinitions({ config: TEST_CONFIG });
    const lazycodexAgents = LAZYCODEX_AGENT_CONTRACTS.map((contract) => agents[contract.name]);

    expect(agents['unknown-lazycodex-role']).toBeUndefined();
    expect(JSON.stringify(lazycodexAgents)).not.toMatch(/gpt-[0-9]/i);

    for (const contract of LAZYCODEX_AGENT_CONTRACTS) {
      const promptFile = readFileSync(promptPath(contract.name), 'utf8');
      expect(promptFile).not.toMatch(/gpt-[0-9]/i);
    }
  });
});
