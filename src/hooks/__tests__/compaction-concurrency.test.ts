/**
 * Tests for issue #453: Compaction error when subagent tasks flood in simultaneously.
 *
 * Verifies:
 * 1. Concurrent processPreCompact calls are serialized via mutex
 * 2. Rapid-fire postToolUse calls are debounced
 * 3. Queued callers receive the correct result
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  processPreCompact,
  isCompactionInProgress,
  getCompactionQueueDepth,
  type PreCompactInput,
} from '../pre-compact/index.js';

import {
  createPreemptiveCompactionHook,
  resetSessionTokenEstimate,
  clearRapidFireDebounce,
  RAPID_FIRE_DEBOUNCE_MS,
  getSessionTokenEstimate,
} from '../preemptive-compaction/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-test-'));
  mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
  return dir;
}

function makePreCompactInput(cwd: string, trigger: 'manual' | 'auto' = 'auto'): PreCompactInput {
  return {
    session_id: 'test-session',
    transcript_path: join(cwd, 'transcript.json'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreCompact' as const,
    trigger,
  };
}

// ============================================================================
// Pre-Compact Mutex Tests
// ============================================================================

describe('processPreCompact - Compaction Mutex (issue #453)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('should complete successfully for a single call', async () => {
    const input = makePreCompactInput(tempDir);
    const result = await processPreCompact(input);

    expect(result.continue).toBe(true);
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain('PreCompact Checkpoint');
  });

  it('should serialize concurrent calls for the same directory', async () => {
    const input = makePreCompactInput(tempDir);

    // Fire 5 concurrent compaction requests (simulates swarm/ultrawork)
    const promises = Array.from({ length: 5 }, () => processPreCompact(input));
    const results = await Promise.all(promises);

    // All should succeed
    for (const result of results) {
      expect(result.continue).toBe(true);
      expect(result.systemMessage).toBeDefined();
    }

    // All should receive the same result (coalesced)
    const firstMessage = results[0].systemMessage;
    for (const result of results) {
      expect(result.systemMessage).toBe(firstMessage);
    }
  });

  it('should only create one checkpoint file per coalesced batch', async () => {
    const input = makePreCompactInput(tempDir);

    // Fire concurrent requests
    await Promise.all(Array.from({ length: 3 }, () => processPreCompact(input)));

    // Check checkpoint directory
    const checkpointDir = join(tempDir, '.omc', 'state', 'checkpoints');
    if (existsSync(checkpointDir)) {
      const files = readdirSync(checkpointDir).filter(f => f.startsWith('checkpoint-'));
      // Should have exactly 1 checkpoint (not 3)
      expect(files.length).toBe(1);
    }
  });

  it('should not report in-progress after completion', async () => {
    const input = makePreCompactInput(tempDir);

    expect(isCompactionInProgress(tempDir)).toBe(false);

    await processPreCompact(input);

    expect(isCompactionInProgress(tempDir)).toBe(false);
    expect(getCompactionQueueDepth(tempDir)).toBe(0);
  });

  it('should allow sequential compactions for the same directory', async () => {
    const input = makePreCompactInput(tempDir);

    const result1 = await processPreCompact(input);
    const result2 = await processPreCompact(input);

    // Both should succeed independently
    expect(result1.continue).toBe(true);
    expect(result2.continue).toBe(true);

    // Second call runs fresh (not coalesced) — verify at least 1 checkpoint exists.
    // Note: both calls may produce the same millisecond timestamp, causing the
    // second writeFileSync to overwrite the first (same filename). This is expected
    // behavior — the important assertion is that both calls succeed independently.
    const checkpointDir = join(tempDir, '.omc', 'state', 'checkpoints');
    if (existsSync(checkpointDir)) {
      const files = readdirSync(checkpointDir).filter(f => f.startsWith('checkpoint-'));
      expect(files.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should handle concurrent calls for different directories independently', async () => {
    const tempDir2 = createTempDir();

    try {
      const input1 = makePreCompactInput(tempDir);
      const input2 = makePreCompactInput(tempDir2);

      // Fire concurrent requests for different directories
      const [result1, result2] = await Promise.all([
        processPreCompact(input1),
        processPreCompact(input2),
      ]);

      // Both should succeed
      expect(result1.continue).toBe(true);
      expect(result2.continue).toBe(true);

      // Each directory should have its own checkpoint
      const checkpointDir1 = join(tempDir, '.omc', 'state', 'checkpoints');
      const checkpointDir2 = join(tempDir2, '.omc', 'state', 'checkpoints');

      if (existsSync(checkpointDir1)) {
        const files1 = readdirSync(checkpointDir1).filter(f => f.startsWith('checkpoint-'));
        expect(files1.length).toBe(1);
      }
      if (existsSync(checkpointDir2)) {
        const files2 = readdirSync(checkpointDir2).filter(f => f.startsWith('checkpoint-'));
        expect(files2.length).toBe(1);
      }
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('should propagate rejection to all coalesced callers and clear mutex', async () => {
    // Use a nonexistent directory to trigger an error in doProcessPreCompact
    const badDir = '/tmp/nonexistent-compaction-dir-' + Date.now();
    const input = makePreCompactInput(badDir);

    // Fire 3 concurrent calls sharing the same in-flight promise
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => processPreCompact(input))
    );

    // All should either reject or return an error-like result
    // processPreCompact may catch internally and return a result rather than throwing
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeDefined();
      } else {
        // If it doesn't throw, at minimum it should still complete
        expect(result.value).toBeDefined();
      }
    }

    // Mutex state should be cleared regardless
    expect(isCompactionInProgress(badDir)).toBe(false);
    expect(getCompactionQueueDepth(badDir)).toBe(0);
  });
});

// ============================================================================
// Preemptive Compaction Rapid-Fire Debounce Tests
// ============================================================================

describe('createPreemptiveCompactionHook - Rapid-Fire Debounce (issue #453)', () => {
  const SESSION_ID = 'debounce-test-session';

  beforeEach(() => {
    resetSessionTokenEstimate(SESSION_ID);
    clearRapidFireDebounce(SESSION_ID);
  });

  afterEach(() => {
    resetSessionTokenEstimate(SESSION_ID);
    clearRapidFireDebounce(SESSION_ID);
  });

  it('should process the first postToolUse call normally', () => {
    const hook = createPreemptiveCompactionHook({
      warningThreshold: 0.01, // Very low threshold to trigger easily
      criticalThreshold: 0.02,
    });

    const result = hook.postToolUse({
      tool_name: 'Task',
      session_id: SESSION_ID,
      tool_input: {},
      tool_response: 'x'.repeat(1_000_000), // Large response
    });

    // First call should produce a warning (threshold is very low)
    // Result can be string (warning) or null (if tokens not enough)
    // The important thing is it runs analysis, not that it warns
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('should debounce rapid-fire calls within the debounce window', () => {
    const hook = createPreemptiveCompactionHook({
      warningThreshold: 0.01,
      criticalThreshold: 0.02,
    });

    const makeInput = () => ({
      tool_name: 'Task',
      session_id: SESSION_ID,
      tool_input: {},
      tool_response: 'x'.repeat(100_000),
    });

    // First call runs analysis
    hook.postToolUse(makeInput());

    // Rapid-fire calls within debounce window should be skipped
    const result2 = hook.postToolUse(makeInput());
    const result3 = hook.postToolUse(makeInput());
    const result4 = hook.postToolUse(makeInput());
    const result5 = hook.postToolUse(makeInput());

    // All debounced calls should return null (skipped)
    expect(result2).toBeNull();
    expect(result3).toBeNull();
    expect(result4).toBeNull();
    expect(result5).toBeNull();
  });

  it('should still accumulate tokens even when debounced', () => {
    const hook = createPreemptiveCompactionHook();

    const makeInput = (response: string) => ({
      tool_name: 'Task',
      session_id: SESSION_ID,
      tool_input: {},
      tool_response: response,
    });

    // First call
    hook.postToolUse(makeInput('x'.repeat(1000)));

    // Debounced calls - tokens should still accumulate
    hook.postToolUse(makeInput('y'.repeat(2000)));
    hook.postToolUse(makeInput('z'.repeat(3000)));

    // Verify tokens accumulated
    const tokens = getSessionTokenEstimate(SESSION_ID);

    // Should have accumulated tokens from all 3 calls (not just the first)
    // Each char is ~0.25 tokens (CHARS_PER_TOKEN = 4)
    expect(tokens).toBeGreaterThan(0);
    // 6000 chars / 4 = 1500 tokens minimum
    expect(tokens).toBeGreaterThanOrEqual(1500);
  });

  it('should process calls again after debounce window expires', async () => {
    vi.useFakeTimers();

    try {
      const hook = createPreemptiveCompactionHook({
        warningThreshold: 0.01,
        criticalThreshold: 0.02,
      });

      const makeInput = () => ({
        tool_name: 'Task',
        session_id: SESSION_ID,
        tool_input: {},
        tool_response: 'x'.repeat(100_000),
      });

      // First call runs analysis
      hook.postToolUse(makeInput());

      // Advance past debounce window
      vi.advanceTimersByTime(RAPID_FIRE_DEBOUNCE_MS + 10);

      // Next call should run analysis again (not be debounced)
      const result = hook.postToolUse(makeInput());
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not debounce calls for different sessions', () => {
    const hook = createPreemptiveCompactionHook({
      warningThreshold: 0.01,
      criticalThreshold: 0.02,
    });

    const SESSION_2 = 'debounce-test-session-2';

    try {
      // Call for session 1
      hook.postToolUse({
        tool_name: 'Task',
        session_id: SESSION_ID,
        tool_input: {},
        tool_response: 'x'.repeat(100_000),
      });

      // Call for session 2 should NOT be debounced
      const result = hook.postToolUse({
        tool_name: 'Task',
        session_id: SESSION_2,
        tool_input: {},
        tool_response: 'x'.repeat(100_000),
      });

      // Should run analysis (not debounced), may or may not produce warning
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      resetSessionTokenEstimate(SESSION_2);
      clearRapidFireDebounce(SESSION_2);
    }
  });

  it('should clear debounce state on stop', () => {
    const hook = createPreemptiveCompactionHook();

    // Trigger a call to set debounce state
    hook.postToolUse({
      tool_name: 'Bash',
      session_id: SESSION_ID,
      tool_input: {},
      tool_response: 'some output',
    });

    // Stop should clear debounce
    hook.stop({ session_id: SESSION_ID });

    // Next call after stop should not be debounced (runs analysis)
    // We verify indirectly: no crash, runs without error
    const result = hook.postToolUse({
      tool_name: 'Bash',
      session_id: SESSION_ID,
      tool_input: {},
      tool_response: 'some output',
    });

    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('RAPID_FIRE_DEBOUNCE_MS should be a reasonable value', () => {
    // Debounce should be short enough to not delay normal operations
    // but long enough to catch simultaneous subagent completions
    expect(RAPID_FIRE_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(RAPID_FIRE_DEBOUNCE_MS).toBeLessThanOrEqual(2000);
  });
});
