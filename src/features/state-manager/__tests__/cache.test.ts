import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Hoist test state dir so it's available inside vi.mock factories
const { TEST_STATE_DIR } = vi.hoisted(() => ({
  TEST_STATE_DIR: '/tmp/omc-cache-test-state',
}));

vi.mock('../../../lib/atomic-write.js', () => ({
  atomicWriteJsonSync: vi.fn((filePath: string, data: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }),
}));

vi.mock('../../../lib/worktree-paths.js', () => ({
  OmcPaths: {
    STATE: TEST_STATE_DIR,
  },
  getWorktreeRoot: () => '/',
}));

// Import after mocks are set up (vi.mock is hoisted)
import {
  readState,
  writeState,
  clearState,
  clearStateCache,
  cleanupStaleStates,
  isStateStale,
} from '../index.js';
import { StateLocation } from '../types.js';

describe('state-manager cache', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    clearStateCache();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    clearStateCache();
    try {
      fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function writeStateToDisk(name: string, data: unknown) {
    const filePath = path.join(TEST_STATE_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  describe('cache immutability', () => {
    it('should return independent clones - mutating returned data does NOT corrupt cache', () => {
      writeStateToDisk('test-mode', { active: true, value: 'original' });

      // First read populates the cache
      const result1 = readState('test-mode', StateLocation.LOCAL);
      expect(result1.exists).toBe(true);
      expect((result1.data as Record<string, unknown>).value).toBe('original');

      // Mutate the returned object
      (result1.data as Record<string, unknown>).value = 'corrupted';
      (result1.data as Record<string, unknown>).injected = true;

      // Second read should return the original data, not the mutated version
      const result2 = readState('test-mode', StateLocation.LOCAL);
      expect(result2.exists).toBe(true);
      expect((result2.data as Record<string, unknown>).value).toBe('original');
      expect((result2.data as Record<string, unknown>).injected).toBeUndefined();
    });

    it('should return independent clones even on cache hit path', () => {
      writeStateToDisk('test-mode2', { active: true, count: 42 });

      // First read - populates cache
      const result1 = readState('test-mode2', StateLocation.LOCAL);
      // Second read - should be cache hit
      const result2 = readState('test-mode2', StateLocation.LOCAL);

      // They should be equal but not the same reference
      expect(result1.data).toEqual(result2.data);
      expect(result1.data).not.toBe(result2.data);
    });
  });

  describe('read path purity (no write-on-read)', () => {
    it('should NOT write to disk or flip active=false for stale state on read', () => {
      const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
      writeStateToDisk('stale-mode', {
        active: true,
        _meta: { updatedAt: staleTime },
      });

      // Read the stale state
      const result = readState('stale-mode', StateLocation.LOCAL);
      expect(result.exists).toBe(true);

      // The returned data should still have active=true (read is pure)
      expect((result.data as Record<string, unknown>).active).toBe(true);

      // The file on disk should also still have active=true (no write-on-read)
      const diskContent = JSON.parse(
        fs.readFileSync(path.join(TEST_STATE_DIR, 'stale-mode.json'), 'utf-8'),
      );
      expect(diskContent.active).toBe(true);
    });
  });

  describe('cache invalidation', () => {
    it('should invalidate cache on writeState', () => {
      writeStateToDisk('inv-test', { active: true, version: 1 });

      // Populate cache
      const r1 = readState('inv-test', StateLocation.LOCAL);
      expect((r1.data as Record<string, unknown>).version).toBe(1);

      // Write new data via writeState (which should invalidate cache)
      writeState('inv-test', { active: true, version: 2 }, StateLocation.LOCAL);

      // Next read should see the new data
      const r2 = readState('inv-test', StateLocation.LOCAL);
      expect((r2.data as Record<string, unknown>).version).toBe(2);
    });

    it('should invalidate cache on clearState', () => {
      writeStateToDisk('clear-test', { active: true });

      // Populate cache
      readState('clear-test', StateLocation.LOCAL);

      // Clear state
      clearState('clear-test', StateLocation.LOCAL);

      // Next read should not find the state
      const r = readState('clear-test', StateLocation.LOCAL);
      expect(r.exists).toBe(false);
    });
  });
});

describe('cleanupStaleStates', () => {
  let tmpDir: string;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'omc-cleanup-test-'));
    const stateDir = path.join(tmpDir, '.omc', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    clearStateCache();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    clearStateCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function writeStateFile(name: string, data: unknown) {
    const stateDir = path.join(tmpDir, '.omc', 'state');
    const filePath = path.join(stateDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  function readStateFile(name: string) {
    const filePath = path.join(tmpDir, '.omc', 'state', `${name}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  it('should deactivate stale active entries', () => {
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeStateFile('stale-mode', {
      active: true,
      _meta: { updatedAt: staleTime },
    });

    const count = cleanupStaleStates(tmpDir);
    expect(count).toBe(1);

    const data = readStateFile('stale-mode');
    expect(data.active).toBe(false);
  });

  it('should NOT deactivate entries with recent heartbeat', () => {
    const staleUpdatedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const recentHeartbeat = new Date(Date.now() - 10 * 1000).toISOString(); // 10 seconds ago
    writeStateFile('heartbeat-mode', {
      active: true,
      _meta: {
        updatedAt: staleUpdatedAt,
        heartbeatAt: recentHeartbeat,
      },
    });

    const count = cleanupStaleStates(tmpDir);
    expect(count).toBe(0);

    const data = readStateFile('heartbeat-mode');
    expect(data.active).toBe(true);
  });

  it('should skip inactive entries', () => {
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeStateFile('inactive-mode', {
      active: false,
      _meta: { updatedAt: staleTime },
    });

    const count = cleanupStaleStates(tmpDir);
    expect(count).toBe(0);
  });
});

describe('isStateStale', () => {
  const NOW = Date.now();
  const MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

  it('should return true for old updatedAt with no heartbeat', () => {
    const oldTime = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(isStateStale({ updatedAt: oldTime }, NOW, MAX_AGE)).toBe(true);
  });

  it('should return false for recent updatedAt', () => {
    const recentTime = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();
    expect(isStateStale({ updatedAt: recentTime }, NOW, MAX_AGE)).toBe(false);
  });

  it('should return false for old updatedAt but recent heartbeat', () => {
    const oldTime = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    const recentHb = new Date(NOW - 30 * 1000).toISOString();
    expect(isStateStale({ updatedAt: oldTime, heartbeatAt: recentHb }, NOW, MAX_AGE)).toBe(false);
  });

  it('should return false for recent updatedAt and old heartbeat', () => {
    const recentTime = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();
    const oldHb = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(isStateStale({ updatedAt: recentTime, heartbeatAt: oldHb }, NOW, MAX_AGE)).toBe(false);
  });

  it('should return true when both timestamps are old', () => {
    const oldTime = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    const oldHb = new Date(NOW - 6 * 60 * 60 * 1000).toISOString();
    expect(isStateStale({ updatedAt: oldTime, heartbeatAt: oldHb }, NOW, MAX_AGE)).toBe(true);
  });

  it('should return false when no timestamps are present', () => {
    expect(isStateStale({}, NOW, MAX_AGE)).toBe(false);
  });
});
