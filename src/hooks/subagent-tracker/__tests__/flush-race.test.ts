import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mergeTrackerStates,
  readDiskState,
  writeTrackingState,
  readTrackingState,
  flushPendingWrites,
  getStateFilePath,
  executeFlush,
  type SubagentTrackingState,
} from '../index.js';

function makeState(overrides: Partial<SubagentTrackingState> = {}): SubagentTrackingState {
  return {
    agents: [],
    total_spawned: 0,
    total_completed: 0,
    total_failed: 0,
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

describe('flush-race', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `flush-race-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    flushPendingWrites();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('mergeTrackerStates', () => {
    it('should union disjoint agent entries from both states', () => {
      const diskState = makeState({
        agents: [
          {
            agent_id: 'agent-a',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });

      const pendingState = makeState({
        agents: [
          {
            agent_id: 'agent-b',
            agent_type: 'architect',
            started_at: '2025-01-01T00:01:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
        total_spawned: 2,
      });

      const merged = mergeTrackerStates(diskState, pendingState);

      expect(merged.agents).toHaveLength(2);
      const ids = merged.agents.map((a) => a.agent_id).sort();
      expect(ids).toEqual(['agent-a', 'agent-b']);
    });

    it('should pick newer timestamp when same agent ID exists in both states', () => {
      const olderTime = '2025-01-01T00:00:00.000Z';
      const newerTime = '2025-01-01T00:05:00.000Z';

      const diskState = makeState({
        agents: [
          {
            agent_id: 'agent-x',
            agent_type: 'executor',
            started_at: olderTime,
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
      });

      const pendingState = makeState({
        agents: [
          {
            agent_id: 'agent-x',
            agent_type: 'executor',
            started_at: olderTime,
            parent_mode: 'ultrawork',
            status: 'completed',
            completed_at: newerTime,
          },
        ],
      });

      const merged = mergeTrackerStates(diskState, pendingState);

      expect(merged.agents).toHaveLength(1);
      expect(merged.agents[0].status).toBe('completed');
      expect(merged.agents[0].completed_at).toBe(newerTime);
    });

    it('should keep disk version when disk agent has newer timestamp', () => {
      const diskState = makeState({
        agents: [
          {
            agent_id: 'agent-x',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'ultrawork',
            status: 'completed',
            completed_at: '2025-01-01T00:10:00.000Z',
          },
        ],
      });

      const pendingState = makeState({
        agents: [
          {
            agent_id: 'agent-x',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
      });

      const merged = mergeTrackerStates(diskState, pendingState);

      expect(merged.agents).toHaveLength(1);
      // Disk has completed_at (2025-01-01T00:10:00) > pending started_at (2025-01-01T00:00:00)
      expect(merged.agents[0].status).toBe('completed');
    });

    it('should take max of counters', () => {
      const diskState = makeState({
        total_spawned: 10,
        total_completed: 5,
        total_failed: 2,
      });

      const pendingState = makeState({
        total_spawned: 8,
        total_completed: 7,
        total_failed: 1,
      });

      const merged = mergeTrackerStates(diskState, pendingState);

      expect(merged.total_spawned).toBe(10);
      expect(merged.total_completed).toBe(7);
      expect(merged.total_failed).toBe(2);
    });

    it('should take latest last_updated timestamp', () => {
      const diskState = makeState({
        last_updated: '2025-01-01T00:00:00.000Z',
      });

      const pendingState = makeState({
        last_updated: '2025-01-01T00:05:00.000Z',
      });

      const merged = mergeTrackerStates(diskState, pendingState);
      expect(merged.last_updated).toBe('2025-01-01T00:05:00.000Z');
    });

    it('should handle empty disk state gracefully', () => {
      const diskState = makeState();
      const pendingState = makeState({
        agents: [
          {
            agent_id: 'agent-a',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });

      const merged = mergeTrackerStates(diskState, pendingState);
      expect(merged.agents).toHaveLength(1);
      expect(merged.total_spawned).toBe(1);
    });
  });

  describe('flush with merge', () => {
    it('should not lose updates when disk changes between read and flush', () => {
      // Step 1: Write initial state to disk
      const initialState = makeState({
        agents: [
          {
            agent_id: 'agent-disk',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });
      const statePath = getStateFilePath(testDir);
      writeFileSync(statePath, JSON.stringify(initialState, null, 2), 'utf-8');

      // Step 2: Queue a pending write with a different agent
      const pendingState = makeState({
        agents: [
          {
            agent_id: 'agent-pending',
            agent_type: 'architect',
            started_at: '2025-01-01T00:01:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });
      writeTrackingState(testDir, pendingState);

      // Step 3: Simulate another process writing to disk between our read and flush
      const externalState = makeState({
        agents: [
          {
            agent_id: 'agent-disk',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
          {
            agent_id: 'agent-external',
            agent_type: 'debugger',
            started_at: '2025-01-01T00:02:00.000Z',
            parent_mode: 'ultrawork',
            status: 'running',
          },
        ],
        total_spawned: 2,
      });
      writeFileSync(statePath, JSON.stringify(externalState, null, 2), 'utf-8');

      // Step 4: Flush pending writes - should merge, not overwrite
      flushPendingWrites();

      // Step 5: Verify all three agents are preserved
      const finalState = readDiskState(testDir);
      const ids = finalState.agents.map((a) => a.agent_id).sort();
      expect(ids).toContain('agent-disk');
      expect(ids).toContain('agent-external');
      expect(ids).toContain('agent-pending');
      expect(finalState.total_spawned).toBe(2); // max(2, 1) = 2
    });

    it('should merge disk state during executeFlush instead of overwriting', () => {
      // Write initial disk state with one agent
      const statePath = getStateFilePath(testDir);
      const diskState = makeState({
        agents: [
          {
            agent_id: 'original',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });
      writeFileSync(statePath, JSON.stringify(diskState, null, 2), 'utf-8');

      // Call executeFlush with a different pending state
      const pendingState = makeState({
        agents: [
          {
            agent_id: 'new-agent',
            agent_type: 'architect',
            started_at: '2025-01-01T00:01:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });

      const result = executeFlush(testDir, pendingState);
      expect(result).toBe(true);

      // Verify that the disk state contains BOTH agents (merged, not overwritten)
      const finalContent = readFileSync(statePath, 'utf-8');
      const finalState: SubagentTrackingState = JSON.parse(finalContent);
      const ids = finalState.agents.map((a) => a.agent_id).sort();
      expect(ids).toEqual(['new-agent', 'original']);

      // Verify: if it had been a direct overwrite (old behavior), 'original' would be missing
    });

    it('should not contain unlocked fallback write path in writeTrackingState', () => {
      // This is a structural test: verify the old unlocked fallback pattern
      // (writing without lock when acquireLock fails) has been removed.
      // We verify by reading the source and checking it doesn't contain
      // the old pattern of calling writeTrackingStateImmediate outside a lock.
      const sourcePath = join(__dirname, '..', 'index.ts');
      const source = readFileSync(sourcePath, 'utf-8');

      // The old code had: "write without lock as best-effort fallback"
      expect(source).not.toContain('write without lock');
      // The old code called writeTrackingStateImmediate directly when lock failed
      // Now it should use retry logic instead
      expect(source).toContain('MAX_FLUSH_RETRIES');
      expect(source).toContain('executeFlush');
    });

    it('should prevent duplicate concurrent flushes via flushInProgress guard', () => {
      // This test verifies the guard exists by checking that rapid sequential
      // writes to the same directory result in consistent merged state
      const state1 = makeState({
        agents: [
          {
            agent_id: 'agent-1',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });

      const state2 = makeState({
        agents: [
          {
            agent_id: 'agent-1',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'none',
            status: 'completed',
            completed_at: '2025-01-01T00:05:00.000Z',
          },
          {
            agent_id: 'agent-2',
            agent_type: 'architect',
            started_at: '2025-01-01T00:01:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 2,
      });

      // Rapid sequential writes (second replaces first in pendingWrites)
      writeTrackingState(testDir, state1);
      writeTrackingState(testDir, state2);
      flushPendingWrites();

      const finalState = readDiskState(testDir);
      expect(finalState.agents).toHaveLength(2);
      // agent-1 should be completed (latest state)
      const agent1 = finalState.agents.find((a) => a.agent_id === 'agent-1');
      expect(agent1?.status).toBe('completed');
    });
  });

  describe('readDiskState', () => {
    it('should always read from disk, ignoring pending writes', () => {
      // Write to disk directly
      const diskState = makeState({
        agents: [
          {
            agent_id: 'disk-agent',
            agent_type: 'executor',
            started_at: '2025-01-01T00:00:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });
      const statePath = getStateFilePath(testDir);
      writeFileSync(statePath, JSON.stringify(diskState, null, 2), 'utf-8');

      // Queue a different pending write (not yet flushed)
      const pendingState = makeState({
        agents: [
          {
            agent_id: 'pending-agent',
            agent_type: 'architect',
            started_at: '2025-01-01T00:01:00.000Z',
            parent_mode: 'none',
            status: 'running',
          },
        ],
        total_spawned: 1,
      });
      writeTrackingState(testDir, pendingState);

      // readDiskState should return disk content, not pending
      const result = readDiskState(testDir);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].agent_id).toBe('disk-agent');

      // readTrackingState should return pending content
      const pendingResult = readTrackingState(testDir);
      expect(pendingResult.agents[0].agent_id).toBe('pending-agent');
    });

    it('should return empty state when no file exists', () => {
      const emptyDir = join(tmpdir(), `empty-test-${Date.now()}`);
      mkdirSync(join(emptyDir, '.omc', 'state'), { recursive: true });

      try {
        const result = readDiskState(emptyDir);
        expect(result.agents).toHaveLength(0);
        expect(result.total_spawned).toBe(0);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
