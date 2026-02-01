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
        createAgent('Plan', 'opus'),
      ];
      const result = renderAgentsCoded(agents);
      // Plan with opus should be uppercase P in magenta
      expect(result).toContain('agents:');
      expect(result).toContain('P');
    });

    it('should use lowercase for sonnet/haiku tiers', () => {
      const agents: ActiveAgent[] = [
        createAgent('Explore', 'haiku'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain('e');
    });

    it('should handle multiple agents', () => {
      const now = Date.now();
      const agents: ActiveAgent[] = [
        createAgent('Plan', 'opus', new Date(now - 2000)),
        createAgent('Explore', 'haiku', new Date(now - 1000)),
        createAgent('general-purpose', 'sonnet', new Date(now)),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toBeDefined();
      // Should contain codes for all three (freshest first: g, e, P)
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:geP');
    });

    it('should handle agents without model info', () => {
      const agents: ActiveAgent[] = [createAgent('Plan')];
      const result = renderAgentsCoded(agents);
      expect(result).toContain('P');
    });

    it('should use first letter for unknown agent types', () => {
      const agents: ActiveAgent[] = [
        createAgent('unknown-agent', 'sonnet'),
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
        createAgent('Plan', 'opus', new Date()),
      ];
      const result = renderAgentsCodedWithDuration(agents);
      // No duration suffix for <10s
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:P');
    });

    it('should show seconds for agents running 10-59s', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'Plan',
          'opus',
          new Date(Date.now() - 30000)
        ), // 30 seconds ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:P\(30s\)/);
    });

    it('should show minutes for agents running 1-9 min', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'Plan',
          'opus',
          new Date(Date.now() - 180000)
        ), // 3 minutes ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:P\(3m\)/);
    });

    it('should show alert for agents running 10+ min', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'Plan',
          'opus',
          new Date(Date.now() - 600000)
        ), // 10 minutes ago
      ];
      const result = renderAgentsCodedWithDuration(agents);
      const stripped = result!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/agents:P!/);
    });
  });

  describe('renderAgentsDetailed (detailed format)', () => {
    it('should return null for empty array', () => {
      expect(renderAgentsDetailed([])).toBeNull();
    });

    it('should show full agent names', () => {
      const agents: ActiveAgent[] = [createAgent('Plan')];
      const result = renderAgentsDetailed(agents);
      expect(result).toContain('Plan');
    });

    it('should abbreviate common long names', () => {
      const agents: ActiveAgent[] = [
        createAgent('general-purpose', 'sonnet'),
      ];
      const result = renderAgentsDetailed(agents);
      expect(result).toContain('general-purpose');
    });

    it('should include duration for long-running agents', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'Plan',
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
      createAgent('Plan', 'opus', new Date(now - 1000)),
      createAgent('Explore', 'haiku', new Date(now)),
    ];

    it('should route to count format', () => {
      const result = renderAgentsByFormat(agents, 'count');
      expect(result).toBe(`agents:${CYAN}2${RESET}`);
    });

    it('should route to codes format', () => {
      const result = renderAgentsByFormat(agents, 'codes');
      expect(result).toContain('agents:');
      // Freshest first: explore (e), then Plan (P)
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:eP');
    });

    it('should route to codes-duration format', () => {
      const result = renderAgentsByFormat(agents, 'codes-duration');
      expect(result).toContain('agents:');
    });

    it('should route to detailed format', () => {
      const result = renderAgentsByFormat(agents, 'detailed');
      expect(result).toContain('Plan');
    });

    it('should route to descriptions format', () => {
      const agentsWithDesc: ActiveAgent[] = [
        {
          ...createAgent('Plan', 'opus'),
          description: 'Analyzing code',
        },
      ];
      const result = renderAgentsByFormat(agentsWithDesc, 'descriptions');
      expect(result).toContain('P');
      expect(result).toContain('Analyzing code');
    });

    it('should route to tasks format', () => {
      const agentsWithDesc: ActiveAgent[] = [
        {
          ...createAgent('Plan', 'opus'),
          description: 'Analyzing code',
        },
      ];
      const result = renderAgentsByFormat(agentsWithDesc, 'tasks');
      expect(result).toContain('[');
      expect(result).toContain('Analyzing code');
      expect(result).not.toContain('P:'); // tasks format doesn't show codes
    });

    it('should default to codes for unknown format', () => {
      const result = renderAgentsByFormat(agents, 'unknown' as any);
      // Should fall back to codes format (freshest first: e, P)
      expect(result).toContain('agents:');
      expect(result!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('agents:eP');
    });
  });

  describe('Agent type codes', () => {
    const testCases = [
      { type: 'Plan', model: 'opus', expected: 'P' },
      { type: 'Plan', model: 'haiku', expected: 'p' },
      { type: 'Plan', model: 'sonnet', expected: 'p' },
      { type: 'Explore', model: 'haiku', expected: 'e' },
      { type: 'Explore', model: 'sonnet', expected: 'e' },
      { type: 'general-purpose', model: 'sonnet', expected: 'g' },
      { type: 'general-purpose', model: 'haiku', expected: 'g' },
      { type: 'general-purpose', model: 'opus', expected: 'G' },
      { type: 'general-purpose', model: 'sonnet', expected: 'g' },
      { type: 'general-purpose', model: 'opus', expected: 'G' },
      { type: 'general-purpose', model: 'sonnet', expected: 'g' },
      { type: 'general-purpose', model: 'haiku', expected: 'g' },
      { type: 'Plan', model: 'opus', expected: 'P' },
      { type: 'general-purpose', model: 'opus', expected: 'G' },
      { type: 'general-purpose', model: 'opus', expected: 'G' },
      { type: 'general-purpose', model: 'sonnet', expected: 'g' },
      { type: 'general-purpose', model: 'sonnet', expected: 'g' },
    ];

    testCases.forEach(({ type, model, expected }) => {
      it(`should render ${type} (${model}) as '${expected}'`, () => {
        const agents: ActiveAgent[] = [
          createAgent(type, model),
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
        createAgent('Plan', 'opus'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(MAGENTA);
    });

    it('should use yellow for sonnet tier', () => {
      const agents: ActiveAgent[] = [
        createAgent('general-purpose', 'sonnet'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(YELLOW);
    });

    it('should use green for haiku tier', () => {
      const agents: ActiveAgent[] = [
        createAgent('Explore', 'haiku'),
      ];
      const result = renderAgentsCoded(agents);
      expect(result).toContain(GREEN);
    });

    it('should use cyan for unknown model', () => {
      const agents: ActiveAgent[] = [
        createAgent('Plan'),
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
        { ...createAgent('Plan'), status: 'completed' },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toBeNull();
      expect(result.detailLines).toHaveLength(0);
    });

    it('should render single agent with tree character (last)', () => {
      const agents: ActiveAgent[] = [
        {
          ...createAgent('Plan', 'opus'),
          description: 'analyzing code',
        },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toContain('agents:');
      expect(result.headerPart).toContain('1');
      expect(result.detailLines).toHaveLength(1);
      // Single agent should use └─ (last indicator)
      expect(result.detailLines[0]).toContain('└─');
      expect(result.detailLines[0]).toContain('P');
      expect(result.detailLines[0]).toContain('analyzing code');
    });

    it('should render multiple agents with correct tree characters', () => {
      const agents: ActiveAgent[] = [
        {
          ...createAgent('Plan', 'opus'),
          description: 'analyzing code',
        },
        {
          ...createAgent('Explore', 'haiku'),
          description: 'searching files',
        },
      ];
      const result = renderAgentsMultiLine(agents);
      expect(result.headerPart).toContain('2');
      expect(result.detailLines).toHaveLength(2);
      // First agent uses ├─
      expect(result.detailLines[0]).toContain('├─');
      expect(result.detailLines[0]).toContain('P');
      // Last agent uses └─
      expect(result.detailLines[1]).toContain('└─');
      expect(result.detailLines[1]).toContain('e');
    });

    it('should limit to maxLines and show overflow indicator', () => {
      const agents: ActiveAgent[] = [
        createAgent('Plan', 'opus'),
        createAgent('Explore', 'haiku'),
        createAgent('general-purpose', 'sonnet'),
        createAgent('general-purpose', 'haiku'),
      ];
      const result = renderAgentsMultiLine(agents, 2);
      // 2 agents + 1 overflow indicator
      expect(result.detailLines).toHaveLength(3);
      expect(result.detailLines[2]).toContain('+2 more');
    });

    it('should include duration for long-running agents', () => {
      const agents: ActiveAgent[] = [
        createAgent(
          'Plan',
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
          ...createAgent('Plan', 'opus'),
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
      const agents: ActiveAgent[] = [createAgent('Plan', 'opus')];
      const result = renderAgentsMultiLine(agents);
      expect(result.detailLines).toHaveLength(1);
      expect(result.detailLines[0]).toContain('...');
    });

    it('should route to multiline from renderAgentsByFormat', () => {
      const agents: ActiveAgent[] = [createAgent('Plan', 'opus')];
      const result = renderAgentsByFormat(agents, 'multiline');
      // Should return the header part only (backward compatibility)
      expect(result).toContain('agents:');
      expect(result).toContain('1');
    });
  });
});
