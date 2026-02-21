/**
 * Tests for the custom rate limit provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { executeCustomProvider } from '../../hud/custom-rate-provider.js';
import type { RateLimitsProviderConfig } from '../../hud/types.js';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

vi.mock('../../utils/paths.js', () => ({
  getClaudeConfigDir: () => '/tmp/test-claude',
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Helper to set up spawn mock for a given stdout / exit code
function mockSpawn(stdout: string, exitCode: number = 0, delay: number = 0) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    }, delay);

    return child;
  });
}

// Helper to set up spawn mock that emits an error event
function mockSpawnError(err: Error) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    setTimeout(() => {
      child.emit('error', err);
    }, 0);

    return child;
  });
}

const VALID_OUTPUT = JSON.stringify({
  version: 1,
  generatedAt: new Date().toISOString(),
  buckets: [
    { id: 'daily', label: 'Daily', usage: { type: 'percent', value: 42 } },
    { id: 'monthly', label: 'Monthly', usage: { type: 'credit', used: 250, limit: 1000 } },
  ],
});

const BASE_CONFIG: RateLimitsProviderConfig = {
  type: 'custom',
  command: 'my-rate-cmd',
  timeoutMs: 500,
};

describe('executeCustomProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('returns buckets on valid output', async () => {
    mockSpawn(VALID_OUTPUT);
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.stale).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].id).toBe('daily');
    expect(result.buckets[1].id).toBe('monthly');
  });

  it('accepts array command', async () => {
    mockSpawn(VALID_OUTPUT);
    const result = await executeCustomProvider({
      ...BASE_CONFIG,
      command: ['my-rate-cmd', '--json'],
    });

    expect(result.stale).toBe(false);
    expect(result.buckets).toHaveLength(2);
  });

  it('filters buckets by periods when configured', async () => {
    mockSpawn(VALID_OUTPUT);
    const result = await executeCustomProvider({
      ...BASE_CONFIG,
      periods: ['monthly'],
    });

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].id).toBe('monthly');
  });

  it('returns empty list when periods filter matches nothing', async () => {
    mockSpawn(VALID_OUTPUT);
    const result = await executeCustomProvider({
      ...BASE_CONFIG,
      periods: ['nonexistent'],
    });

    expect(result.buckets).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('returns error when command outputs invalid JSON', async () => {
    mockSpawn('not json at all');
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.buckets).toHaveLength(0);
    expect(result.error).toBe('invalid output');
  });

  it('returns error when command exits with non-zero code', async () => {
    mockSpawn('', 1);
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.buckets).toHaveLength(0);
    expect(result.error).toBe('command failed');
  });

  it('returns error when command emits an error event', async () => {
    mockSpawnError(new Error('ENOENT: no such file or directory'));
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.buckets).toHaveLength(0);
    expect(result.error).toBe('command failed');
  });

  it('returns error when output has wrong version', async () => {
    mockSpawn(JSON.stringify({ version: 2, buckets: [] }));
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.error).toBe('invalid output');
  });

  it('returns error when output has no buckets array', async () => {
    mockSpawn(JSON.stringify({ version: 1 }));
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.error).toBe('invalid output');
  });

  it('filters out malformed buckets', async () => {
    const output = JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      buckets: [
        { id: 'good', label: 'Good', usage: { type: 'percent', value: 50 } },
        { id: 'bad', label: 'Bad', usage: { type: 'unknown-type' } },     // filtered
        { label: 'Missing id', usage: { type: 'percent', value: 10 } },   // filtered (no id)
      ],
    });
    mockSpawn(output);
    const result = await executeCustomProvider(BASE_CONFIG);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].id).toBe('good');
  });

  describe('caching', () => {
    it('returns fresh cache when within TTL', async () => {
      const cachedBuckets = [
        { id: 'cached', label: 'Cached', usage: { type: 'percent' as const, value: 77 } },
      ];
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: Date.now(), buckets: cachedBuckets }),
      );

      const result = await executeCustomProvider(BASE_CONFIG);

      expect(result.stale).toBe(false);
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].id).toBe('cached');
      // spawn should not have been called
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('runs command when cache is expired', async () => {
      const oldBuckets = [
        { id: 'old', label: 'Old', usage: { type: 'percent' as const, value: 10 } },
      ];
      // Cache expired (timestamp 60s ago)
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: Date.now() - 60_000, buckets: oldBuckets }),
      );

      mockSpawn(VALID_OUTPUT);
      const result = await executeCustomProvider(BASE_CONFIG);

      expect(result.stale).toBe(false);
      expect(result.buckets).toHaveLength(2); // fresh from command
    });

    it('returns stale cache on command failure', async () => {
      const staleBuckets = [
        { id: 'stale', label: 'Stale', usage: { type: 'percent' as const, value: 55 } },
      ];
      // Expired cache exists
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: Date.now() - 60_000, buckets: staleBuckets }),
      );

      mockSpawn('', 1); // command fails
      const result = await executeCustomProvider(BASE_CONFIG);

      expect(result.stale).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.buckets[0].id).toBe('stale');
    });

    it('returns error with empty buckets when no cache and command fails', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      mockSpawn('', 1);
      const result = await executeCustomProvider(BASE_CONFIG);

      expect(result.stale).toBe(false);
      expect(result.error).toBe('command failed');
      expect(result.buckets).toHaveLength(0);
    });
  });
});
