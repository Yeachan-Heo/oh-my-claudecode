import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state module before imports
vi.mock('../../hud/state.js', () => ({
  readHudState: vi.fn(),
  writeHudState: vi.fn(() => true),
}));

import { cleanupStaleBackgroundTasks } from '../../hud/background-cleanup.js';
import { readHudState, writeHudState } from '../../hud/state.js';

const mockReadHudState = vi.mocked(readHudState);
const mockWriteHudState = vi.mocked(writeHudState);

describe('background-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteHudState.mockReturnValue(true);
  });

  describe('cleanupStaleBackgroundTasks', () => {
    it('marks stale running tasks as failed instead of silently removing them', async () => {
      const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          {
            id: 'stale-running',
            description: 'Stale running task',
            startedAt: staleTime,
            status: 'running',
          },
        ],
      });

      await cleanupStaleBackgroundTasks(30 * 60 * 1000); // 30 min threshold

      expect(mockWriteHudState).toHaveBeenCalled();
      const writtenState = mockWriteHudState.mock.calls[0][0];

      // The stale running task should be marked as failed, NOT removed
      const staleTask = writtenState.backgroundTasks.find(
        (t: { id: string }) => t.id === 'stale-running'
      );
      expect(staleTask).toBeDefined();
      expect(staleTask!.status).toBe('failed');
      expect(staleTask!.completedAt).toBeDefined();
    });

    it('keeps recent running tasks unchanged', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          {
            id: 'recent-running',
            description: 'Recent running task',
            startedAt: recentTime,
            status: 'running',
          },
        ],
      });

      await cleanupStaleBackgroundTasks(30 * 60 * 1000);

      // Should not have been written (no changes)
      // or if written, the task should still be running
      if (mockWriteHudState.mock.calls.length > 0) {
        const writtenState = mockWriteHudState.mock.calls[0][0];
        const task = writtenState.backgroundTasks.find(
          (t: { id: string }) => t.id === 'recent-running'
        );
        expect(task).toBeDefined();
        expect(task!.status).toBe('running');
      }
    });

    it('keeps completed tasks for history', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          {
            id: 'completed-task',
            description: 'Done task',
            startedAt: recentTime,
            status: 'completed',
            completedAt: recentTime,
          },
        ],
      });

      await cleanupStaleBackgroundTasks(30 * 60 * 1000);

      // No stale tasks to remove, so no write needed (or task preserved if written)
      if (mockWriteHudState.mock.calls.length > 0) {
        const writtenState = mockWriteHudState.mock.calls[0][0];
        expect(writtenState.backgroundTasks).toHaveLength(1);
        expect(writtenState.backgroundTasks[0].status).toBe('completed');
      }
    });

    it('returns 0 when no state exists', async () => {
      mockReadHudState.mockReturnValue(null);
      const result = await cleanupStaleBackgroundTasks();
      expect(result).toBe(0);
    });

    it('handles mix of stale running and completed tasks', async () => {
      const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          {
            id: 'stale-running',
            description: 'Stale running',
            startedAt: staleTime,
            status: 'running',
          },
          {
            id: 'recent-completed',
            description: 'Recent completed',
            startedAt: recentTime,
            status: 'completed',
            completedAt: recentTime,
          },
          {
            id: 'recent-running',
            description: 'Recent running',
            startedAt: recentTime,
            status: 'running',
          },
        ],
      });

      await cleanupStaleBackgroundTasks(30 * 60 * 1000);

      expect(mockWriteHudState).toHaveBeenCalled();
      const writtenState = mockWriteHudState.mock.calls[0][0];

      // Stale running should be marked failed (not removed)
      const staleTask = writtenState.backgroundTasks.find(
        (t: { id: string }) => t.id === 'stale-running'
      );
      expect(staleTask).toBeDefined();
      expect(staleTask!.status).toBe('failed');
      expect(staleTask!.completedAt).toBeDefined();

      // Recent completed should be kept
      const completedTask = writtenState.backgroundTasks.find(
        (t: { id: string }) => t.id === 'recent-completed'
      );
      expect(completedTask).toBeDefined();
      expect(completedTask!.status).toBe('completed');

      // Recent running should be kept as running
      const recentRunning = writtenState.backgroundTasks.find(
        (t: { id: string }) => t.id === 'recent-running'
      );
      expect(recentRunning).toBeDefined();
      expect(recentRunning!.status).toBe('running');
    });
  });
});
