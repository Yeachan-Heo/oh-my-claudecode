/**
 * Project Memory - Deep merge strategy for cross-session sync.
 *
 * Fixes issue #1168: cross-session sync previously used full overwrite
 * (shallow spread) which lost nested fields when merging project memory.
 *
 * This module provides field-level deep merge with array-specific strategies:
 * - Plain objects: recursively merged (new keys added, existing keys deep-merged)
 * - Arrays with identifiable items (objects with identity keys):
 *   deduplicated by identity, newer entries win on conflict
 * - Primitive arrays: union (deduplicated)
 * - Scalars: incoming value wins (last-write-wins at leaf level)
 */

import type { ProjectMemory, CustomNote, UserDirective, HotPath } from '../hooks/project-memory/types.js';

// ---------------------------------------------------------------------------
// Generic deep-merge utilities
// ---------------------------------------------------------------------------

/**
 * Check if a value is a plain object (not an array, null, Date, etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  );
}

/**
 * Deep merge two plain objects. `incoming` values take precedence at leaf level.
 * Arrays are handled by `mergeArrays` with type-aware deduplication.
 *
 * @param base - The existing (on-disk) object
 * @param incoming - The new (incoming) object whose values take precedence
 * @returns A new merged object (neither input is mutated)
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  incoming: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(incoming)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const incomingVal = (incoming as Record<string, unknown>)[key];

    // Incoming explicitly null/undefined -> take it (intentional clear)
    if (incomingVal === null || incomingVal === undefined) {
      result[key] = incomingVal;
      continue;
    }

    // Both are plain objects -> recurse
    if (isPlainObject(baseVal) && isPlainObject(incomingVal)) {
      result[key] = deepMerge(baseVal, incomingVal);
      continue;
    }

    // Both are arrays -> type-aware merge
    if (Array.isArray(baseVal) && Array.isArray(incomingVal)) {
      result[key] = mergeArrays(key, baseVal, incomingVal);
      continue;
    }

    // Scalar or type mismatch -> incoming wins (last-write-wins)
    result[key] = incomingVal;
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// Array merge strategies
// ---------------------------------------------------------------------------

/**
 * Merge two arrays with field-aware deduplication based on the field name.
 *
 * - `customNotes`: deduplicate by category+content, keep newer timestamp
 * - `userDirectives`: deduplicate by directive text, keep newer timestamp
 * - `hotPaths`: deduplicate by path, merge access counts
 * - `languages`, `frameworks`: deduplicate by name, incoming wins
 * - `workspaces`, `mainDirectories`, `keyFiles`, `markers`: string union
 * - Default: union by JSON equality
 */
function mergeArrays(fieldName: string, base: unknown[], incoming: unknown[]): unknown[] {
  switch (fieldName) {
    case 'customNotes':
      return mergeByKey(
        base as CustomNote[],
        incoming as CustomNote[],
        (note: CustomNote) => `${note.category}::${note.content}`,
        (a, b) => (b.timestamp >= a.timestamp ? b : a),
      );

    case 'userDirectives':
      return mergeByKey(
        base as UserDirective[],
        incoming as UserDirective[],
        (d: UserDirective) => d.directive,
        (a, b) => (b.timestamp >= a.timestamp ? b : a),
      );

    case 'hotPaths':
      return mergeByKey(
        base as HotPath[],
        incoming as HotPath[],
        (hp: HotPath) => hp.path,
        (a, b) => ({
          ...b,
          accessCount: Math.max(a.accessCount, b.accessCount),
          lastAccessed: Math.max(a.lastAccessed, b.lastAccessed),
        }),
      );

    case 'languages':
    case 'frameworks':
      return mergeByKey(
        base as Array<{ name: string }>,
        incoming as Array<{ name: string }>,
        (item: { name: string }) => item.name,
        (_a, b) => b,
      );

    case 'workspaces':
    case 'mainDirectories':
    case 'keyFiles':
    case 'markers':
      return mergeScalarArray(base as string[], incoming as string[]);

    default:
      return mergeScalarArray(base, incoming);
  }
}

/**
 * Merge two arrays of objects by a key function.
 * When both arrays contain an item with the same key, `resolve` picks the winner.
 * Order: base items first (updated in place), then new incoming items appended.
 */
function mergeByKey<T>(
  base: T[],
  incoming: T[],
  keyFn: (item: T) => string,
  resolve: (base: T, incoming: T) => T,
): T[] {
  const seen = new Map<string, T>();

  for (const item of base) {
    seen.set(keyFn(item), item);
  }

  for (const item of incoming) {
    const key = keyFn(item);
    const existing = seen.get(key);
    if (existing) {
      seen.set(key, resolve(existing, item));
    } else {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

/**
 * Merge two scalar arrays via union (deduplicate by JSON string equality).
 */
function mergeScalarArray(base: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const item of [...base, ...incoming]) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Project Memory merge
// ---------------------------------------------------------------------------

/**
 * Merge incoming partial project memory into the existing on-disk memory.
 *
 * Uses deep merge with field-specific array strategies to prevent data loss
 * during cross-session sync. Metadata fields (`version`, `lastScanned`,
 * `projectRoot`) always take the incoming value when provided.
 *
 * @param existing - The current on-disk project memory
 * @param incoming - Partial update from another session or tool call
 * @returns Merged ProjectMemory (new object, inputs not mutated)
 */
export function mergeProjectMemory(
  existing: ProjectMemory,
  incoming: Partial<ProjectMemory>,
): ProjectMemory {
  const merged = deepMerge(
    existing as unknown as Record<string, unknown>,
    incoming as unknown as Record<string, unknown>,
  ) as unknown as ProjectMemory;

  // Ensure metadata fields are sensible after merge
  merged.lastScanned = incoming.lastScanned ?? existing.lastScanned;

  return merged;
}
