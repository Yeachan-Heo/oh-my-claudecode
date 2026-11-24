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
import type { ProjectMemory } from '../hooks/project-memory/types.js';
/**
 * Deep merge two plain objects. `incoming` values take precedence at leaf level.
 * Arrays are handled by `mergeArrays` with type-aware deduplication.
 *
 * @param base - The existing (on-disk) object
 * @param incoming - The new (incoming) object whose values take precedence
 * @returns A new merged object (neither input is mutated)
 */
export declare function deepMerge<T extends Record<string, unknown>>(base: T, incoming: Partial<T>): T;
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
export declare function mergeProjectMemory(existing: ProjectMemory, incoming: Partial<ProjectMemory>): ProjectMemory;
//# sourceMappingURL=project-memory-merge.d.ts.map