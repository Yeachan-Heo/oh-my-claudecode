/**
 * Tests for issue #453: Compaction error when subagent tasks flood in simultaneously.
 *
 * Verifies:
 * 1. Concurrent processPreCompact calls are serialized via mutex
 * 2. Rapid-fire postToolUse calls are debounced
 * 3. Queued callers receive the correct result
 */
export {};
//# sourceMappingURL=compaction-concurrency.test.d.ts.map