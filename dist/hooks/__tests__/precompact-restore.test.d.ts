/**
 * Tests for issue #3730: PreCompact checkpoint is write-only.
 *
 * Verifies:
 * 1. PreCompact writes a checkpoint with durable plan anchors (PRD / boulder)
 * 2. A restore path surfaces the newest matching checkpoint after compaction
 *    (SessionStart source=compact semantics)
 * 3. Restore is isolated per project directory, bounded by size and age,
 *    fail-open on malformed/missing checkpoints, and never replays the same
 *    checkpoint to the same session twice.
 */
export {};
//# sourceMappingURL=precompact-restore.test.d.ts.map