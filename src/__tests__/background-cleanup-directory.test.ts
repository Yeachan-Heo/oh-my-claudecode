import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track calls to readHudState/writeHudState to verify directory propagation
const readHudStateMock = vi.fn();
const writeHudStateMock = vi.fn();

vi.mock('../hud/state.js', () => ({
  readHudState: (...args: unknown[]) => readHudStateMock(...args),
  writeHudState: (...args: unknown[]) => writeHudStateMock(...args),
  initializeHUDState: vi.fn(),
}));

import {
  cleanupStaleBackgroundTasks,
  markOrphanedTasksAsStale,
} from '../hud/background-cleanup.js';

describe('background-cleanup directory propagation', () => {
  beforeEach(() => {
    readHudStateMock.mockReset();
    writeHudStateMock.mockReset();
  });

  it('cleanupStaleBackgroundTasks should pass directory to readHudState', async () => {
    // BUG FIX: cleanupStaleBackgroundTasks called readHudState() without directory,
    // defaulting to process.cwd() instead of the actual project directory.
    readHudStateMock.mockReturnValue(null);

    await cleanupStaleBackgroundTasks(undefined, '/custom/project/dir');

    expect(readHudStateMock).toHaveBeenCalledWith('/custom/project/dir', undefined);
  });

  it('cleanupStaleBackgroundTasks should pass directory to writeHudState when cleaning', async () => {
    const staleTask = {
      id: 'task-1',
      status: 'running',
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    };
    readHudStateMock.mockReturnValue({ backgroundTasks: [staleTask] });

    await cleanupStaleBackgroundTasks(undefined, '/custom/project/dir');

    expect(writeHudStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundTasks: expect.any(Array) }),
      '/custom/project/dir',
      undefined
    );
  });

  it('markOrphanedTasksAsStale should pass directory to readHudState', async () => {
    readHudStateMock.mockReturnValue(null);

    await markOrphanedTasksAsStale('/custom/project/dir');

    expect(readHudStateMock).toHaveBeenCalledWith('/custom/project/dir', undefined);
  });

  it('markOrphanedTasksAsStale should pass directory to writeHudState when marking', async () => {
    const orphanedTask = {
      id: 'task-orphan',
      status: 'running',
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
    };
    readHudStateMock.mockReturnValue({ backgroundTasks: [orphanedTask] });

    await markOrphanedTasksAsStale('/custom/project/dir');

    expect(writeHudStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundTasks: expect.any(Array) }),
      '/custom/project/dir',
      undefined
    );
  });

  it('functions should default to no directory when not provided', async () => {
    readHudStateMock.mockReturnValue(null);

    await cleanupStaleBackgroundTasks();
    expect(readHudStateMock).toHaveBeenCalledWith(undefined, undefined);

    readHudStateMock.mockReset();
    await markOrphanedTasksAsStale();
    expect(readHudStateMock).toHaveBeenCalledWith(undefined, undefined);
  });
});
