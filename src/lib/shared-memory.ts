/**
 * Shared Memory State Layer
 *
 * Filesystem-based key-value store for cross-session memory sync
 * between agents in /team and /pipeline workflows.
 *
 * Storage: .omc/state/shared-memory/{namespace}/{key}.json
 *
 * Each entry is a JSON file containing:
 * - key: string identifier
 * - value: arbitrary JSON-serializable data
 * - namespace: grouping identifier (session group, pipeline run, etc.)
 * - createdAt: ISO timestamp
 * - updatedAt: ISO timestamp
 * - ttl: optional time-to-live in seconds
 * - expiresAt: optional ISO timestamp (computed from ttl)
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1119
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getOmcRoot } from './worktree-paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharedMemoryEntry {
  key: string;
  value: unknown;
  namespace: string;
  createdAt: string;
  updatedAt: string;
  /** TTL in seconds. Omitted or 0 means no expiry. */
  ttl?: number;
  /** Absolute expiry timestamp (ISO). Computed from ttl on write. */
  expiresAt?: string;
}

export interface SharedMemoryListItem {
  key: string;
  updatedAt: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = '.omc-config.json';

/**
 * Check if shared memory is enabled via config.
 *
 * Reads `agents.sharedMemory.enabled` from ~/.claude/.omc-config.json.
 * Defaults to true when the config key is absent (opt-out rather than opt-in
 * once the feature ships, but tools check this gate).
 */
export function isSharedMemoryEnabled(): boolean {
  try {
    const configPath = join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude',
      CONFIG_FILE_NAME,
    );
    if (!existsSync(configPath)) return true; // default enabled
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const enabled = raw?.agents?.sharedMemory?.enabled;
    if (typeof enabled === 'boolean') return enabled;
    return true; // default enabled when key absent
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SHARED_MEMORY_DIR = 'state/shared-memory';

/** Validate namespace: alphanumeric, hyphens, underscores, dots. Max 128 chars. */
function validateNamespace(namespace: string): void {
  if (!namespace || namespace.length > 128) {
    throw new Error(`Invalid namespace: must be 1-128 characters (got ${namespace.length})`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace)) {
    throw new Error(`Invalid namespace: must be alphanumeric with hyphens/underscores/dots (got "${namespace}")`);
  }
  if (namespace.includes('..')) {
    throw new Error('Invalid namespace: path traversal not allowed');
  }
}

/** Validate key: alphanumeric, hyphens, underscores, dots. Max 128 chars. */
function validateKey(key: string): void {
  if (!key || key.length > 128) {
    throw new Error(`Invalid key: must be 1-128 characters (got ${key.length})`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) {
    throw new Error(`Invalid key: must be alphanumeric with hyphens/underscores/dots (got "${key}")`);
  }
  if (key.includes('..')) {
    throw new Error('Invalid key: path traversal not allowed');
  }
}

/** Get the directory path for a namespace. */
function getNamespaceDir(namespace: string, worktreeRoot?: string): string {
  validateNamespace(namespace);
  const omcRoot = getOmcRoot(worktreeRoot);
  return join(omcRoot, SHARED_MEMORY_DIR, namespace);
}

/** Get the file path for a specific key within a namespace. */
function getEntryPath(namespace: string, key: string, worktreeRoot?: string): string {
  validateKey(key);
  return join(getNamespaceDir(namespace, worktreeRoot), `${key}.json`);
}

/** Ensure the namespace directory exists. */
function ensureNamespaceDir(namespace: string, worktreeRoot?: string): string {
  const dir = getNamespaceDir(namespace, worktreeRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Check expiry
// ---------------------------------------------------------------------------

function isExpired(entry: SharedMemoryEntry): boolean {
  if (!entry.expiresAt) return false;
  return new Date(entry.expiresAt).getTime() <= Date.now();
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Write a key-value pair to shared memory.
 *
 * Creates or updates the entry. If ttl is provided, computes expiresAt.
 */
export function writeEntry(
  namespace: string,
  key: string,
  value: unknown,
  ttl?: number,
  worktreeRoot?: string,
): SharedMemoryEntry {
  ensureNamespaceDir(namespace, worktreeRoot);
  const filePath = getEntryPath(namespace, key, worktreeRoot);
  const now = new Date().toISOString();

  let existingCreatedAt = now;
  if (existsSync(filePath)) {
    try {
      const existing: SharedMemoryEntry = JSON.parse(readFileSync(filePath, 'utf-8'));
      existingCreatedAt = existing.createdAt || now;
    } catch {
      // Corrupted file, treat as new
    }
  }

  const entry: SharedMemoryEntry = {
    key,
    value,
    namespace,
    createdAt: existingCreatedAt,
    updatedAt: now,
  };

  if (ttl && ttl > 0) {
    entry.ttl = ttl;
    entry.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  }

  writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  return entry;
}

/**
 * Read a key from shared memory.
 *
 * Returns null if the key doesn't exist or has expired.
 * Expired entries are automatically deleted on read.
 */
export function readEntry(
  namespace: string,
  key: string,
  worktreeRoot?: string,
): SharedMemoryEntry | null {
  validateNamespace(namespace);
  validateKey(key);

  const filePath = getEntryPath(namespace, key, worktreeRoot);
  if (!existsSync(filePath)) return null;

  try {
    const entry: SharedMemoryEntry = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Auto-cleanup expired entries
    if (isExpired(entry)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * List all keys in a namespace.
 *
 * Expired entries are filtered out (but not deleted during list).
 */
export function listEntries(
  namespace: string,
  worktreeRoot?: string,
): SharedMemoryListItem[] {
  validateNamespace(namespace);

  const dir = getNamespaceDir(namespace, worktreeRoot);
  if (!existsSync(dir)) return [];

  const items: SharedMemoryListItem[] = [];

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const entry: SharedMemoryEntry = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!isExpired(entry)) {
          items.push({
            key: entry.key,
            updatedAt: entry.updatedAt,
            expiresAt: entry.expiresAt,
          });
        }
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Directory read error
  }

  return items.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Delete a specific key from shared memory.
 *
 * Returns true if the key existed and was deleted.
 */
export function deleteEntry(
  namespace: string,
  key: string,
  worktreeRoot?: string,
): boolean {
  validateNamespace(namespace);
  validateKey(key);

  const filePath = getEntryPath(namespace, key, worktreeRoot);
  if (!existsSync(filePath)) return false;

  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up expired entries in a namespace (or all namespaces).
 *
 * Returns the count of entries removed.
 */
export function cleanupExpired(
  namespace?: string,
  worktreeRoot?: string,
): { removed: number; namespaces: string[] } {
  const omcRoot = getOmcRoot(worktreeRoot);
  const sharedMemDir = join(omcRoot, SHARED_MEMORY_DIR);

  if (!existsSync(sharedMemDir)) return { removed: 0, namespaces: [] };

  const namespacesToClean: string[] = [];

  if (namespace) {
    validateNamespace(namespace);
    namespacesToClean.push(namespace);
  } else {
    // All namespaces
    try {
      const entries = readdirSync(sharedMemDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          namespacesToClean.push(entry.name);
        }
      }
    } catch {
      return { removed: 0, namespaces: [] };
    }
  }

  let removed = 0;
  const cleanedNamespaces: string[] = [];

  for (const ns of namespacesToClean) {
    const nsDir = join(sharedMemDir, ns);
    if (!existsSync(nsDir)) continue;

    let nsRemoved = 0;
    try {
      const files = readdirSync(nsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const filePath = join(nsDir, file);
          const entry: SharedMemoryEntry = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (isExpired(entry)) {
            unlinkSync(filePath);
            nsRemoved++;
          }
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Skip inaccessible namespace
    }

    if (nsRemoved > 0) {
      cleanedNamespaces.push(ns);
      removed += nsRemoved;
    }
  }

  return { removed, namespaces: cleanedNamespaces };
}

/**
 * List all namespaces that have shared memory entries.
 */
export function listNamespaces(worktreeRoot?: string): string[] {
  const omcRoot = getOmcRoot(worktreeRoot);
  const sharedMemDir = join(omcRoot, SHARED_MEMORY_DIR);

  if (!existsSync(sharedMemDir)) return [];

  try {
    const entries = readdirSync(sharedMemDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}
