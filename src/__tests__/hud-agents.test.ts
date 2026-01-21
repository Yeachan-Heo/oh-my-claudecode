/**
 * Sisyphus HUD - Agents Element Tests
 *
 * Tests for agent visualization with different formats.
 */

import { describe, it, expect } from 'vitest';
import {
  renderAgents,
  renderAgentsCoded,
  renderAgentsCodedWithDuration,
  renderAgentsDetailed,
  renderAgentsWithDescriptions,
  renderAgentsDescOnly,
  renderAgentsByFormat,
  renderAgentsMultiLine,
} from '../hud/elements/agents.js';
import type { ActiveAgent } from '../hud/types.js';

// ANSI color codes for verification
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

// Helper to create mock agents
function createAgent(
  type: string,
  model?: string,
  startTime?: Date
): ActiveAgent {
  return {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    model,
    status: 'running',
    startTime: startTime || new Date(),
  };
}

describe('Agents Element', () => {
  describe('renderAgents (count format)', () => {
    it('should return null for empty array', () => {
      expect(renderAgents([])).toBeNull();
    });

    it('should return null when no agents are running', () => {
      const agents: ActiveAgent[] = [
        { ...createAgent('architect'), status: 'completed' },
      ];
      expect(renderAgents(agents)).toBeNull();
    });

    it('should show count of running agents', () => {
      const agents: ActiveAgent[] = [
        createAgent('architect'),
        createAgent('explore'),
      ];
      const result = renderAgents(agents);
      expect(result).toBe(`agents:${CYAN}2${RESET}`);
    });
  });

  describe('renderAgentsCoded (codes format)', () => {
    it('should return null for empty array', () => {
      expect(renderAgentsCoded([])).toBeNull();
    });

    it('should show single-character codes for known agents', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect', 'opus'),
      ];
      const result = renderAgentsCoded(agents);
      // Architect with opus should be uppercase A in magenta
      expect(result).toContain('agents:');
      expect(result).toContain('A');
    });

    it('should use lowercase for sonnet/haiku tiers', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:explore', 'haiku'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain('e');
    });

    it('should handle multiple agents', () => {
      const now = Date.now();
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect', 'opus', new Date(now - 2000)),
        createAgent('oh-my-claudecode:explore', 'haiku', new Date(now - 1000)),
        createAgent('oh-my-claudecode:executor', 'sonnet', new Date(now)),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toBeDefined();
      // Should contain codes for all three (freshest first: x, e, A)
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:xeA');
    });

    it('should handle agents without model info', () => {
      const agents: ActiveAgent[] = [createAgent('oh-my-claudecode:architect')];
      const result = renderAgentsCoded(agents);
      expect(result).toContain('A');
    });

    it('should use first letter for unknown agent types', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:unknown-agent', 'sonnet'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:u');
    });
  });

  describe('renderAgentsCodedWithDuration (codes-duration format)', () => {
    it('should return null for empty array', () => {
      expect(renderAgentsCodedWithDuration([])).toBeNull();
    });

    it('should not show duration for very recent agents', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect', 'opus', new Date()),
      ];
      const result = renderAgentsCodedWithDuration(agents);
      // No duration suffix for <10s
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:A');
    });

    it('should show seconds for agents running 10-59s', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'oh-my-claudecode:architect',
          'opus',
          new Date(Date.now() - 30000)
        ), // 30 seconds ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:A\(30s\)/);
    });

    it('should show minutes for agents running 1-9 min', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'oh-my-claudecode:architect',
          'opus',
          new Date(Date.now() - 180000)
        ), // 3 minutes ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:A\(3m\)/);
    });

    it('should show alert for agents running 10+ min', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'oh-my-claudecode:architect',
          'opus',
          new Date(Date.now() - 600000)
        ), // 10 minutes ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:A!/);
    });
  });

  describe('renderAgentsDetailed (detailed format)', () => {
    it('should return null for empty array', () => {
      expect(renderAgentsDetailed([])).toBeNull();
    });

    it('should show full agent names', () => {
      const agents: ActiveAgent[] = [createAgent('oh-my-claudecode:architect')];
      const result = renderAgentsDetailed(agents);
      expect(result).toContain('architect');
    });

    it('should abbreviate common long names', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:executor', 'sonnet'),
      ];
      const result = renderAgentsDetailed(agents);
      expect(result).toContain('exec');
    });

    it('should include duration for long-running agents', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'oh-my-claudecode:architect',
          'opus',
          new Date(Date.now() - 120000)
        ), // 2 minutes
      ];
      const result = renderAgentsDetailed(agents);
      expect(result).toContain('(2m)');
    });
  });

  describe('renderAgentsByFormat (format router)', () => {
    const now = Date.now();
    const agents: ActiveAgent[] = [
      createAgent('oh-my-claudecode:architect', 'opus', new Date(now - 1000)),
      createAgent('oh-my-claudecode:explore', 'haiku', new Date(now)),
    ];

    it('should route to count format', () => {
      const result = renderAgentsByFormat(agents, 'count');
      expect(result).toBe(`agents:${CYAN}2${RESET}`);
    });

    it('should route to codes format', () => {
      const result = renderAgentsByFormat(agents, 'codes');
      expect(result).toContain('agents:');
      // Freshest first: explore (e), then architect (A)
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:eA');
    });

    it('should route to codes-duration format', () => {
      const result = renderAgentsByFormat(agents, 'codes-duration');
      expect(result).toContain('agents:');
    });

    it('should route to detailed format', () => {
      const result = renderAgentsByFormat(agents, 'detailed');
      expect(result).toContain('architect');
    });

    it('should route to descriptions format', () => {
      const agentsWithDesc: ActiveAgent[] = [
        {
          ...createAgent('oh-my-claudecode:architect', 'opus'),
          description: 'Analyzing code',
        },
      ];
      const result = renderAgentsByFormat(agentsWithDesc, 'descriptions');
      expect(result).toContain('A');
      expect(result).toContain('Analyzing code');
    });

    it('should route to tasks format', () => {
      const agentsWithDesc: ActiveAgent[] = [
        {
          ...createAgent('oh-my-claudecode:architect', 'opus'),
          description: 'Analyzing code',
        },
      ];
      const result = renderAgentsByFormat(agentsWithDesc, 'tasks');
      expect(result).toContain('[');
      expect(result).toContain('Analyzing code');
      expect(result).not.toContain('A:'); // tasks format doesn't show codes
    });

    it('should default to codes for unknown format', () => {
      const result = renderAgentsByFormat(agents, 'unknown' as any);
      // Should fall back to codes format (freshest first: e, A)
      expect(result).toContain('agents:');
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:eA');
    });
  });

  describe('Agent type codes', () => {
    const testCases = [
      { type: 'architect', model: 'opus', expected: 'A' },
      { type: 'architect-low', model: 'haiku', expected: 'a' },
      { type: 'architect-medium', model: 'sonnet', expected: 'a' },
      { type: 'explore', model: 'haiku', expected: 'e' },
      { type: 'explore-medium', model: 'sonnet', expected: 'e' },
      { type: 'executor', model: 'sonnet', expected: 'x' },
      { type: 'executor-low', model: 'haiku', expected: 'x' },
      { type: 'executor-high', model: 'opus', expected: 'X' },
      { type: 'designer', model: 'sonnet', expected: 'd' },
      { type: 'designer-high', model: 'opus', expected: 'D' },
      { type: 'researcher', model: 'sonnet', expected: 'r' },
      { type: 'writer', model: 'haiku', expected: 'w' },
      { type: 'planner', model: 'opus', expected: 'P' },
      { type: 'critic', model: 'opus', expected: 'C' },
      { type: 'analyst', model: 'opus', expected: 'T' },
      { type: 'qa-tester', model: 'sonnet', expected: 'q' },
      { type: 'vision', model: 'sonnet', expected: 'v' },
    ];

    testCases.forEach(({ type, model, expected }) => {
      it(`should render ${type} (${model}) as '${expected}'`, () => {
        const agents: ActiveAgent[] = [
          createAgent(`oh-my-claudecode:${type}`, model),
        ];
        const result = renderAgentsCoded(agents);
        const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
        expect(stripped).toBe(`agents:${expected}`);
      });
    });
  });

  describe('Model tier color coding', () => {
    it('should use magenta for opus tier', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect', 'opus'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(MAGENTA);
    });

    it('should use yellow for sonnet tier', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:executor', 'sonnet'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(YELLOW);
    });

    it('should use green for haiku tier', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:explore', 'haiku'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(GREEN);
    });

    it('should use cyan for unknown model', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(CYAN);
    });
  });

  describe('renderAgentsMultiLine (multiline format)', () => {
    it('should return empty for no running agents', () => {
      const result = renderAgentsMultiLine([]);
      expect(result.headerPart).toBeNull();
      expect(result.detailLines).toHaveLength(0);
    });

    it('should return empty for completed agents only', () => {
      const agents: ActiveAgent[] = [
        { ...createAgent('oh-my-claudecode:architect'), status: 'completed' },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toBeNull();
      expect(result.detailLines).toHaveLength(0);
    });

    it('should render single agent with tree character (last)', () => {
      const agents: ActiveAgent[] = [
        {
          ...createAgent('oh-my-claudecode:architect', 'opus'),
          description: 'analyzing code',
        },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toContain('agents:');
      expect(result.headerPart).toContain('1');
      expect(result.detailLines).toHaveLength(1);
      // Single agent should use └─ (last indicator)
      expect(result.detailLines[0]).toContain('└─');
      expect(result.detailLines[0]).toContain('A');
      expect(result.detailLines[0]).toContain('analyzing code');
    });

    it('should render multiple agents with correct tree characters', () => {
      const agents: ActiveAgent[] = [
        {
          ...createAgent('oh-my-claudecode:architect', 'opus'),
          description: 'analyzing code',
        },
        {
          ...createAgent('oh-my-claudecode:explore', 'haiku'),
          description: 'searching files',
        },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toContain('2');
      expect(result.detailLines).toHaveLength(2);
      // First agent uses ├─
      expect(result.detailLines[0]).toContain('├─');
      expect(result.detailLines[0]).toContain('A');
      // Last agent uses └─
      expect(result.detailLines[1]).toContain('└─');
      expect(result.detailLines[1]).toContain('e');
    });

    it('should limit to maxLines and show overflow indicator', () => {
      const agents: ActiveAgent[] = [
        createAgent('oh-my-claudecode:architect', 'opus'),
        createAgent('oh-my-claudecode:explore', 'haiku'),
        createAgent('oh-my-claudecode:executor', 'sonnet'),
        createAgent('oh-my-claudecode:researcher', 'haiku'),
      ];
      const result = renderAgentsMultiLine(agents, 2);
      // 2 agents + 1 overflow indicator
      expect(result.detailLines).toHaveLength(3);
      expect(result.detailLines[2]).toContain('+2 more');
    });

    it('should include duration for long-running agents', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'oh-my-claudecode:architect',
          'opus',
          new Date(Date.now() - 120000) // 2 minutes ago
        ),
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.detailLines).toHaveLength(1);
      expect(result.detailLines[0]).toContain('2m');
    });

    it('should truncate long descriptions', () => {
      const agents: ActiveAgent[] = [
        {
          ...createAgent('oh-my-claudecode:architect', 'opus'),
          description:
            'This is a very long description that should be truncated to fit in the display',
        },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.detailLines).toHaveLength(1);
      expect(result.detailLines[0]).toContain('...');
      // Strip ANSI codes before checking length
      const stripped = result.detailLines[0].replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThan(80);
    });

    it('should handle agents without descriptions', () => {
      const agents: ActiveAgent[] = [createAgent('oh-my-claudecode:architect', 'opus')];
      const result = renderAgentsMultiLine(agents);
      expect(result.detailLines).toHaveLength(1);
      expect(result.detailLines[0]).toContain('...');
    });

    it('should route to multiline from renderAgentsByFormat', () => {
      const agents: ActiveAgent[] = [createAgent('oh-my-claudecode:architect', 'opus')];
      const result = renderAgentsByFormat(agents, 'multiline');
      // Should return the header part only (backward compatibility)
      expect(result).toContain('agents:');
      expect(result).toContain('1');
    });
  });
});
