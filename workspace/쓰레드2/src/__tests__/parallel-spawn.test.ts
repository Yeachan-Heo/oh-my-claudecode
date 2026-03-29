/**
 * @file parallel-spawn.test.ts — spawnAgentsParallel TDD
 * 동시 실행, 실패 격리, maxConcurrency 제한, Phase 2 fanout 검증
 */

import { describe, it, expect, vi } from 'vitest';
import { spawnAgentsParallel, type AgentTask } from '../orchestrator/parallel-spawn.js';

describe('spawnAgentsParallel', () => {
  it('should run multiple agent tasks concurrently', async () => {
    const callOrder: string[] = [];
    const mockSpawnFn = vi.fn().mockImplementation(async (task: AgentTask) => {
      callOrder.push(`start:${task.agentId}`);
      await new Promise(r => setTimeout(r, 10));
      callOrder.push(`end:${task.agentId}`);
      return { draft: `draft-${task.agentId}`, status: 'ok' as const };
    });

    const tasks: AgentTask[] = [
      { agentId: 'bini-beauty-editor', role: 'editor', input: { category: '뷰티', time: '09:00' } },
      { agentId: 'hana-health-editor', role: 'editor', input: { category: '건강', time: '12:00' } },
    ];

    const results = await spawnAgentsParallel(tasks, mockSpawnFn);
    expect(results).toHaveLength(2);
    expect(results.filter(r => r.status === 'ok')).toHaveLength(2);

    // Verify concurrent execution: both should start before either ends
    expect(callOrder[0]).toBe('start:bini-beauty-editor');
    expect(callOrder[1]).toBe('start:hana-health-editor');
  });

  it('should isolate failures — one agent fail does not block others', async () => {
    const mockSpawnFn = vi.fn()
      .mockResolvedValueOnce({ draft: 'ok', status: 'ok' as const })
      .mockRejectedValueOnce(new Error('agent crash'));

    const tasks: AgentTask[] = [
      { agentId: 'bini-beauty-editor', role: 'editor', input: { category: '뷰티', time: '09:00' } },
      { agentId: 'hana-health-editor', role: 'editor', input: { category: '건강', time: '12:00' } },
    ];

    const results = await spawnAgentsParallel(tasks, mockSpawnFn);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('failed');
  });

  it('should respect maxConcurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const mockSpawnFn = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return { draft: 'ok', status: 'ok' as const };
    });

    const tasks: AgentTask[] = Array.from({ length: 4 }, (_, i) => ({
      agentId: `agent-${i}`,
      role: 'editor',
      input: { category: 'test', time: '09:00' },
    }));

    await spawnAgentsParallel(tasks, mockSpawnFn, { maxConcurrency: 2 });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe('Phase 2 fanout pattern', () => {
  it('should merge results from orient + supplement agents', async () => {
    const mockSpawnFn = vi.fn()
      .mockResolvedValueOnce({ draft: JSON.stringify({ orient: 'analysis' }), status: 'ok' as const })
      .mockResolvedValueOnce({ draft: JSON.stringify({ collect: 'data' }), status: 'ok' as const });

    const tasks: AgentTask[] = [
      { agentId: 'seoyeon-analyst', role: 'orient', input: { weeklyStats: {} } },
      { agentId: 'junho-researcher', role: 'supplement', input: { keywords: [] } },
    ];

    const results = await spawnAgentsParallel(tasks, mockSpawnFn);
    expect(results.filter(r => r.status === 'ok')).toHaveLength(2);

    // Verify each agent result can be identified by agentId
    const orientResult = results.find(r => r.agentId === 'seoyeon-analyst');
    const supplementResult = results.find(r => r.agentId === 'junho-researcher');
    expect(orientResult?.status).toBe('ok');
    expect(orientResult?.draft).toContain('orient');
    expect(supplementResult?.status).toBe('ok');
    expect(supplementResult?.draft).toContain('collect');
  });

  it('should proceed when supplement agent fails — orient is sufficient', async () => {
    const mockSpawnFn = vi.fn()
      .mockResolvedValueOnce({ draft: JSON.stringify({ orient: 'analysis' }), status: 'ok' as const })
      .mockRejectedValueOnce(new Error('researcher unavailable'));

    const tasks: AgentTask[] = [
      { agentId: 'seoyeon-analyst', role: 'orient', input: { weeklyStats: {} } },
      { agentId: 'junho-researcher', role: 'supplement', input: { keywords: [] } },
    ];

    const results = await spawnAgentsParallel(tasks, mockSpawnFn);

    // Orient succeeded, supplement failed — pipeline should still work
    const orientResult = results.find(r => r.agentId === 'seoyeon-analyst');
    const supplementResult = results.find(r => r.agentId === 'junho-researcher');
    expect(orientResult?.status).toBe('ok');
    expect(supplementResult?.status).toBe('failed');
    expect(supplementResult?.error).toContain('researcher unavailable');
  });
});
