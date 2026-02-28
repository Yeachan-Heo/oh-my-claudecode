import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock getOmcRoot to use our test directory
const mockGetOmcRoot = vi.fn<(worktreeRoot?: string) => string>();
vi.mock('../lib/worktree-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worktree-paths.js')>();
  return {
    ...actual,
    getOmcRoot: (...args: [string?]) => mockGetOmcRoot(...args),
    validateWorkingDirectory: (dir?: string) => dir || '/tmp',
  };
});

import {
  writeEntry,
  readEntry,
  listEntries,
  deleteEntry,
  cleanupExpired,
  listNamespaces,
  isSharedMemoryEnabled,
} from '../lib/shared-memory.js';

describe('Shared Memory', () => {
  let testDir: string;
  let omcDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `shared-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    omcDir = join(testDir, '.omc');
    mkdirSync(omcDir, { recursive: true });
    mockGetOmcRoot.mockReturnValue(omcDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // writeEntry + readEntry
  // =========================================================================

  describe('writeEntry / readEntry', () => {
    it('should write and read a string value', () => {
      const entry = writeEntry('test-ns', 'greeting', 'hello world');
      expect(entry.key).toBe('greeting');
      expect(entry.value).toBe('hello world');
      expect(entry.namespace).toBe('test-ns');
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();

      const read = readEntry('test-ns', 'greeting');
      expect(read).not.toBeNull();
      expect(read!.value).toBe('hello world');
    });

    it('should write and read an object value', () => {
      const data = { decisions: ['use JWT', 'skip OAuth'], confidence: 0.9 };
      writeEntry('pipeline-run-42', 'auth-context', data);

      const read = readEntry('pipeline-run-42', 'auth-context');
      expect(read!.value).toEqual(data);
    });

    it('should preserve createdAt on update', () => {
      const first = writeEntry('ns', 'key1', 'v1');
      const createdAt = first.createdAt;

      // Small delay to ensure different timestamp
      const second = writeEntry('ns', 'key1', 'v2');
      expect(second.createdAt).toBe(createdAt);
      expect(second.value).toBe('v2');
    });

    it('should return null for non-existent key', () => {
      const read = readEntry('ns', 'no-such-key');
      expect(read).toBeNull();
    });

    it('should return null for non-existent namespace', () => {
      const read = readEntry('no-such-ns', 'key');
      expect(read).toBeNull();
    });

    it('should create namespace directory automatically', () => {
      writeEntry('auto-ns', 'k', 'v');
      const nsDir = join(omcDir, 'state', 'shared-memory', 'auto-ns');
      expect(existsSync(nsDir)).toBe(true);
    });

    it('should store entry as JSON file', () => {
      writeEntry('ns', 'mykey', { x: 1 });
      const filePath = join(omcDir, 'state', 'shared-memory', 'ns', 'mykey.json');
      expect(existsSync(filePath)).toBe(true);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.key).toBe('mykey');
      expect(content.value).toEqual({ x: 1 });
    });
  });

  // =========================================================================
  // TTL support
  // =========================================================================

  describe('TTL support', () => {
    it('should set ttl and expiresAt when ttl provided', () => {
      const entry = writeEntry('ns', 'temp', 'data', 3600);
      expect(entry.ttl).toBe(3600);
      expect(entry.expiresAt).toBeTruthy();

      const expiresAt = new Date(entry.expiresAt!).getTime();
      const now = Date.now();
      // Should be approximately 1 hour from now (allow 5s tolerance)
      expect(expiresAt).toBeGreaterThan(now + 3595000);
      expect(expiresAt).toBeLessThan(now + 3605000);
    });

    it('should not set ttl when omitted', () => {
      const entry = writeEntry('ns', 'permanent', 'data');
      expect(entry.ttl).toBeUndefined();
      expect(entry.expiresAt).toBeUndefined();
    });

    it('should auto-delete expired entries on read', () => {
      // Write entry with already-expired timestamp
      const filePath = join(omcDir, 'state', 'shared-memory', 'ns');
      mkdirSync(filePath, { recursive: true });
      const expiredEntry = {
        key: 'expired-key',
        value: 'old',
        namespace: 'ns',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        ttl: 60,
        expiresAt: '2020-01-01T00:01:00.000Z',
      };
      writeFileSync(join(filePath, 'expired-key.json'), JSON.stringify(expiredEntry));

      const read = readEntry('ns', 'expired-key');
      expect(read).toBeNull();

      // File should be deleted
      expect(existsSync(join(filePath, 'expired-key.json'))).toBe(false);
    });

    it('should return non-expired entries normally', () => {
      const entry = writeEntry('ns', 'fresh', 'data', 7200);
      const read = readEntry('ns', 'fresh');
      expect(read).not.toBeNull();
      expect(read!.value).toBe('data');
    });
  });

  // =========================================================================
  // listEntries
  // =========================================================================

  describe('listEntries', () => {
    it('should list all keys in a namespace', () => {
      writeEntry('ns', 'alpha', 1);
      writeEntry('ns', 'beta', 2);
      writeEntry('ns', 'gamma', 3);

      const items = listEntries('ns');
      expect(items).toHaveLength(3);
      expect(items.map(i => i.key)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should return empty array for empty namespace', () => {
      const items = listEntries('empty-ns');
      expect(items).toEqual([]);
    });

    it('should filter out expired entries', () => {
      writeEntry('ns', 'live', 'ok');

      // Manually write an expired entry
      const nsDir = join(omcDir, 'state', 'shared-memory', 'ns');
      const expiredEntry = {
        key: 'dead',
        value: 'expired',
        namespace: 'ns',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        ttl: 1,
        expiresAt: '2020-01-01T00:00:01.000Z',
      };
      writeFileSync(join(nsDir, 'dead.json'), JSON.stringify(expiredEntry));

      const items = listEntries('ns');
      expect(items).toHaveLength(1);
      expect(items[0].key).toBe('live');
    });

    it('should include expiresAt in list items when present', () => {
      writeEntry('ns', 'temp', 'data', 3600);
      const items = listEntries('ns');
      expect(items[0].expiresAt).toBeTruthy();
    });
  });

  // =========================================================================
  // deleteEntry
  // =========================================================================

  describe('deleteEntry', () => {
    it('should delete an existing key', () => {
      writeEntry('ns', 'to-delete', 'bye');
      const deleted = deleteEntry('ns', 'to-delete');
      expect(deleted).toBe(true);

      const read = readEntry('ns', 'to-delete');
      expect(read).toBeNull();
    });

    it('should return false for non-existent key', () => {
      const deleted = deleteEntry('ns', 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  // =========================================================================
  // cleanupExpired
  // =========================================================================

  describe('cleanupExpired', () => {
    it('should remove expired entries from a namespace', () => {
      writeEntry('ns', 'live', 'ok');

      // Manually write expired entries
      const nsDir = join(omcDir, 'state', 'shared-memory', 'ns');
      for (const key of ['exp1', 'exp2']) {
        writeFileSync(join(nsDir, `${key}.json`), JSON.stringify({
          key,
          value: 'old',
          namespace: 'ns',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          ttl: 1,
          expiresAt: '2020-01-01T00:00:01.000Z',
        }));
      }

      const result = cleanupExpired('ns');
      expect(result.removed).toBe(2);
      expect(result.namespaces).toContain('ns');

      // Live entry should remain
      expect(readEntry('ns', 'live')).not.toBeNull();
    });

    it('should clean all namespaces when no namespace specified', () => {
      // Create entries in two namespaces
      writeEntry('ns1', 'live', 'ok');
      writeEntry('ns2', 'live', 'ok');

      // Add expired entries to both
      for (const ns of ['ns1', 'ns2']) {
        const nsDir = join(omcDir, 'state', 'shared-memory', ns);
        writeFileSync(join(nsDir, 'expired.json'), JSON.stringify({
          key: 'expired',
          value: 'old',
          namespace: ns,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          ttl: 1,
          expiresAt: '2020-01-01T00:00:01.000Z',
        }));
      }

      const result = cleanupExpired();
      expect(result.removed).toBe(2);
      expect(result.namespaces).toHaveLength(2);
    });

    it('should return 0 when no expired entries', () => {
      writeEntry('ns', 'live', 'ok');
      const result = cleanupExpired('ns');
      expect(result.removed).toBe(0);
    });
  });

  // =========================================================================
  // listNamespaces
  // =========================================================================

  describe('listNamespaces', () => {
    it('should list all namespaces', () => {
      writeEntry('alpha-ns', 'k', 'v');
      writeEntry('beta-ns', 'k', 'v');
      writeEntry('gamma-ns', 'k', 'v');

      const namespaces = listNamespaces();
      expect(namespaces).toEqual(['alpha-ns', 'beta-ns', 'gamma-ns']);
    });

    it('should return empty array when no namespaces', () => {
      const namespaces = listNamespaces();
      expect(namespaces).toEqual([]);
    });
  });

  // =========================================================================
  // Namespace isolation
  // =========================================================================

  describe('namespace isolation', () => {
    it('should isolate keys between namespaces', () => {
      writeEntry('ns1', 'key', 'value-1');
      writeEntry('ns2', 'key', 'value-2');

      expect(readEntry('ns1', 'key')!.value).toBe('value-1');
      expect(readEntry('ns2', 'key')!.value).toBe('value-2');
    });

    it('should not affect other namespaces on delete', () => {
      writeEntry('ns1', 'key', 'v1');
      writeEntry('ns2', 'key', 'v2');

      deleteEntry('ns1', 'key');

      expect(readEntry('ns1', 'key')).toBeNull();
      expect(readEntry('ns2', 'key')!.value).toBe('v2');
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================

  describe('validation', () => {
    it('should reject namespace with path traversal', () => {
      expect(() => writeEntry('../etc', 'key', 'v')).toThrow('Invalid namespace');
    });

    it('should reject key with path traversal', () => {
      expect(() => writeEntry('ns', '../passwd', 'v')).toThrow('Invalid key');
    });

    it('should reject empty namespace', () => {
      expect(() => writeEntry('', 'key', 'v')).toThrow('Invalid namespace');
    });

    it('should reject empty key', () => {
      expect(() => writeEntry('ns', '', 'v')).toThrow('Invalid key');
    });

    it('should reject namespace with special characters', () => {
      expect(() => writeEntry('ns/foo', 'key', 'v')).toThrow('Invalid namespace');
    });

    it('should accept namespace with dots, hyphens, underscores', () => {
      const entry = writeEntry('my-team.run_1', 'key', 'v');
      expect(entry.namespace).toBe('my-team.run_1');
    });
  });

  // =========================================================================
  // Config gate
  // =========================================================================

  describe('isSharedMemoryEnabled', () => {
    it('should return true by default (no config file)', () => {
      expect(isSharedMemoryEnabled()).toBe(true);
    });
  });

  // =========================================================================
  // Corrupted file handling
  // =========================================================================

  describe('corrupted files', () => {
    it('should return null for corrupted entry file on read', () => {
      const nsDir = join(omcDir, 'state', 'shared-memory', 'ns');
      mkdirSync(nsDir, { recursive: true });
      writeFileSync(join(nsDir, 'bad.json'), 'not json{{{');

      const read = readEntry('ns', 'bad');
      expect(read).toBeNull();
    });

    it('should skip corrupted files in list', () => {
      writeEntry('ns', 'good', 'ok');
      const nsDir = join(omcDir, 'state', 'shared-memory', 'ns');
      writeFileSync(join(nsDir, 'bad.json'), 'corrupt');

      const items = listEntries('ns');
      expect(items).toHaveLength(1);
      expect(items[0].key).toBe('good');
    });
  });
});
