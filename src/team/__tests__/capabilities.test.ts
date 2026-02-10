import { describe, it, expect } from 'vitest';
import {
  getDefaultCapabilities,
  scoreWorkerFitness,
  rankWorkersForTask,
} from '../capabilities.js';
import type { UnifiedTeamMember } from '../unified-team.js';
import type { WorkerCapability } from '../types.js';

function makeMember(
  name: string,
  backend: 'claude-native' | 'mcp-codex' | 'mcp-gemini',
  capabilities: WorkerCapability[],
  status: 'active' | 'idle' | 'dead' = 'active'
): UnifiedTeamMember {
  return {
    name,
    agentId: `agent-${name}`,
    backend,
    model: 'test-model',
    capabilities,
    joinedAt: Date.now(),
    status,
    currentTaskId: null,
  };
}

describe('capabilities', () => {
  describe('getDefaultCapabilities', () => {
    it('returns capabilities for claude-native', () => {
      const caps = getDefaultCapabilities('claude-native');
      expect(caps).toContain('code-edit');
      expect(caps).toContain('testing');
      expect(caps).toContain('general');
    });

    it('returns capabilities for mcp-codex', () => {
      const caps = getDefaultCapabilities('mcp-codex');
      expect(caps).toContain('code-review');
      expect(caps).toContain('security-review');
      expect(caps).toContain('architecture');
    });

    it('returns capabilities for mcp-gemini', () => {
      const caps = getDefaultCapabilities('mcp-gemini');
      expect(caps).toContain('ui-design');
      expect(caps).toContain('documentation');
      expect(caps).toContain('research');
    });

    it('returns a copy, not a reference', () => {
      const caps1 = getDefaultCapabilities('claude-native');
      const caps2 = getDefaultCapabilities('claude-native');
      caps1.push('research');
      expect(caps2).not.toContain('research');
    });
  });

  describe('scoreWorkerFitness', () => {
    it('returns 1.0 for exact match', () => {
      const worker = makeMember('w1', 'mcp-codex', ['code-review', 'security-review']);
      const score = scoreWorkerFitness(worker, ['code-review', 'security-review']);
      expect(score).toBe(1.0);
    });

    it('returns 0.5 for partial match', () => {
      const worker = makeMember('w1', 'mcp-codex', ['code-review']);
      const score = scoreWorkerFitness(worker, ['code-review', 'testing']);
      expect(score).toBe(0.5);
    });

    it('returns 0 for no match', () => {
      const worker = makeMember('w1', 'mcp-codex', ['code-review']);
      const score = scoreWorkerFitness(worker, ['ui-design', 'documentation']);
      expect(score).toBe(0);
    });

    it('gives partial credit for general capability', () => {
      const worker = makeMember('w1', 'claude-native', ['general']);
      const score = scoreWorkerFitness(worker, ['architecture']);
      expect(score).toBe(0.5); // 0.5 from general wildcard / 1 required
    });

    it('returns 1.0 when no capabilities required', () => {
      const worker = makeMember('w1', 'claude-native', ['code-edit']);
      const score = scoreWorkerFitness(worker, []);
      expect(score).toBe(1.0);
    });
  });

  describe('rankWorkersForTask', () => {
    it('ranks workers by fitness score descending', () => {
      const w1 = makeMember('codex', 'mcp-codex', ['code-review', 'security-review']);
      const w2 = makeMember('gemini', 'mcp-gemini', ['ui-design', 'documentation']);
      const w3 = makeMember('claude', 'claude-native', ['code-edit', 'testing', 'general']);

      const ranked = rankWorkersForTask([w1, w2, w3], ['code-review', 'security-review']);
      expect(ranked[0].name).toBe('codex'); // perfect match
      expect(ranked.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes workers with score 0', () => {
      const w1 = makeMember('codex', 'mcp-codex', ['code-review']);
      const w2 = makeMember('gemini', 'mcp-gemini', ['ui-design']);

      const ranked = rankWorkersForTask([w1, w2], ['code-review']);
      expect(ranked).toHaveLength(1);
      expect(ranked[0].name).toBe('codex');
    });

    it('handles empty workers list', () => {
      const ranked = rankWorkersForTask([], ['code-review']);
      expect(ranked).toEqual([]);
    });

    it('respects custom capabilities over defaults', () => {
      const w1 = makeMember('custom', 'claude-native', ['security-review', 'architecture']);
      const w2 = makeMember('default', 'mcp-codex', ['code-review']);

      const ranked = rankWorkersForTask([w1, w2], ['security-review', 'architecture']);
      expect(ranked[0].name).toBe('custom');
    });
  });
});
