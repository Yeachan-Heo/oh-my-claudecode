import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state module before imports
vi.mock('../../hud/state.js', () => ({
  readHudState: vi.fn(),
  writeHudState: vi.fn(() => true),
  createEmptyHudState: vi.fn(() => ({
    timestamp: new Date().toISOString(),
    backgroundTasks: [],
  })),
}));

import { clearBackgroundTasks } from '../../hud/background-tasks.js';
import { readHudState, writeHudState, createEmptyHudState } from '../../hud/state.js';

const mockReadHudState = vi.mocked(readHudState);
const mockWriteHudState = vi.mocked(writeHudState);
const mockCreateEmptyHudState = vi.mocked(createEmptyHudState);

describe('background-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEmptyHudState.mockReturnValue({
      timestamp: new Date().toISOString(),
      backgroundTasks: [],
    });
    mockWriteHudState.mockReturnValue(true);
  });

  describe('clearBackgroundTasks', () => {
    it('preserves sessionStartTimestamp when clearing tasks', () => {
      const sessionStart = '2024-01-01T00:00:00.000Z';
      const sessionId = 'test-session-123';
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          {
            id: 'task-1',
            description: 'Running task',
            startedAt: new Date().toISOString(),
            status: 'running',
          },
        ],
        sessionStartTimestamp: sessionStart,
        sessionId: sessionId,
      });

      clearBackgroundTasks();

      expect(mockWriteHudState).toHaveBeenCalledTimes(1);
      const writtenState = mockWriteHudState.mock.calls[0][0];
      expect(writtenState.backgroundTasks).toEqual([]);
      expect(writtenState.sessionStartTimestamp).toBe(sessionStart);
      expect(writtenState.sessionId).toBe(sessionId);
    });

    it('works when no existing state exists', () => {
      mockReadHudState.mockReturnValue(null);

      const result = clearBackgroundTasks();

      expect(result).toBe(true);
      expect(mockWriteHudState).toHaveBeenCalledTimes(1);
      const writtenState = mockWriteHudState.mock.calls[0][0];
      expect(writtenState.backgroundTasks).toEqual([]);
      // No session fields to preserve
      expect(writtenState.sessionStartTimestamp).toBeUndefined();
      expect(writtenState.sessionId).toBeUndefined();
    });

    it('clears all background tasks', () => {
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          { id: 'a', description: 'Task A', startedAt: new Date().toISOString(), status: 'running' },
          { id: 'b', description: 'Task B', startedAt: new Date().toISOString(), status: 'completed' },
        ],
      });

      clearBackgroundTasks();

      const writtenState = mockWriteHudState.mock.calls[0][0];
      expect(writtenState.backgroundTasks).toEqual([]);
    });

    it('preserves session fields when clearing tasks with directory param', () => {
      const sessionStart = '2024-06-15T12:00:00.000Z';
      mockReadHudState.mockReturnValue({
        timestamp: new Date().toISOString(),
        backgroundTasks: [
          { id: 'x', description: 'X', startedAt: new Date().toISOString(), status: 'running' },
        ],
        sessionStartTimestamp: sessionStart,
        sessionId: 'dir-session',
      });

      clearBackgroundTasks('/some/dir');

      expect(mockReadHudState).toHaveBeenCalledWith('/some/dir', undefined);
      const writtenState = mockWriteHudState.mock.calls[0][0];
      expect(writtenState.sessionStartTimestamp).toBe(sessionStart);
      expect(writtenState.sessionId).toBe('dir-session');
    });
  });
});
