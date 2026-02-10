import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTokenTracker } from '../../analytics/token-tracker.js';

describe('TokenTracker.getTopAgents', () => {
  beforeEach(() => {
    // Reset the singleton before each test
    resetTokenTracker('test-session');
  });

  it('returns empty array when no usage recorded', async () => {
    const tracker = resetTokenTracker('test-session');
    const result = await tracker.getTopAgents(5);
    expect(result).toEqual([]);
  });

  it('returns agents sorted by cost descending', async () => {
    const tracker = resetTokenTracker('test-session');

    // Record usage for multiple agents
    await tracker.recordTokenUsage({
      agentName: 'executor',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    await tracker.recordTokenUsage({
      agentName: 'architect',
      modelName: 'claude-opus-4.6', // More expensive model
      inputTokens: 2000,
      outputTokens: 1000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    // architect should be first (more expensive model)
    expect(result[0].agent).toBe('architect');
    expect(result[1].agent).toBe('executor');
    expect(result[0].cost).toBeGreaterThan(result[1].cost);
  });

  it('respects the limit parameter', async () => {
    const tracker = resetTokenTracker('test-session');

    // Record usage for 5 agents
    for (let i = 0; i < 5; i++) {
      await tracker.recordTokenUsage({
        agentName: `agent-${i}`,
        modelName: 'claude-sonnet-4.5',
        inputTokens: (5 - i) * 1000, // Different amounts
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0
      });
    }

    const result = await tracker.getTopAgents(2);
    expect(result).toHaveLength(2);
  });

  it('aggregates multiple usages for same agent', async () => {
    const tracker = resetTokenTracker('test-session');

    // Record multiple usages for same agent
    await tracker.recordTokenUsage({
      agentName: 'executor',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    await tracker.recordTokenUsage({
      agentName: 'executor',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    expect(result).toHaveLength(1);
    expect(result[0].agent).toBe('executor');
    expect(result[0].tokens).toBe(3000); // 2 * (1000 + 500)
  });

  it('uses "(main session)" for entries without agentName', async () => {
    const tracker = resetTokenTracker('test-session');

    await tracker.recordTokenUsage({
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    expect(result[0].agent).toBe('(main session)');
  });

  it('handles mixed agents with and without names', async () => {
    const tracker = resetTokenTracker('test-session');

    // Main session usage
    await tracker.recordTokenUsage({
      modelName: 'claude-sonnet-4.5',
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    // Named agent usage
    await tracker.recordTokenUsage({
      agentName: 'executor',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.agent).sort()).toEqual(['(main session)', 'executor'].sort());
  });

  it('calculates cost correctly across different models', async () => {
    const tracker = resetTokenTracker('test-session');

    // Haiku (cheaper)
    await tracker.recordTokenUsage({
      agentName: 'cheap-agent',
      modelName: 'claude-3-5-haiku-20241022',
      inputTokens: 10000,
      outputTokens: 5000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    // Opus (expensive)
    await tracker.recordTokenUsage({
      agentName: 'expensive-agent',
      modelName: 'claude-opus-4.6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    // Even with 10x more tokens, haiku might still be cheaper than opus
    // We just verify that cost is calculated (not zero) and ordering is by cost
    expect(result[0].cost).toBeGreaterThan(0);
    expect(result[1].cost).toBeGreaterThan(0);
    expect(result[0].cost).toBeGreaterThan(result[1].cost);
  });

  it('includes cache tokens in cost calculation', async () => {
    const tracker = resetTokenTracker('test-session');

    // Usage with cache
    await tracker.recordTokenUsage({
      agentName: 'cached-agent',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 500,
      cacheReadTokens: 200
    });

    // Usage without cache
    await tracker.recordTokenUsage({
      agentName: 'uncached-agent',
      modelName: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });

    const result = await tracker.getTopAgents(5);

    // Cached agent should have higher cost due to cache creation
    const cachedAgent = result.find(r => r.agent === 'cached-agent');
    const uncachedAgent = result.find(r => r.agent === 'uncached-agent');

    expect(cachedAgent).toBeDefined();
    expect(uncachedAgent).toBeDefined();
    expect(cachedAgent!.cost).toBeGreaterThan(uncachedAgent!.cost);
  });

  it('returns agents in stable order when costs are equal', async () => {
    const tracker = resetTokenTracker('test-session');

    // Record identical usage for multiple agents
    for (let i = 0; i < 3; i++) {
      await tracker.recordTokenUsage({
        agentName: `agent-${i}`,
        modelName: 'claude-sonnet-4.5',
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0
      });
    }

    const result1 = await tracker.getTopAgents(5);
    const result2 = await tracker.getTopAgents(5);

    // Results should be consistent
    expect(result1).toHaveLength(3);
    expect(result2).toHaveLength(3);
    expect(result1.map(r => r.agent)).toEqual(result2.map(r => r.agent));
  });
});
