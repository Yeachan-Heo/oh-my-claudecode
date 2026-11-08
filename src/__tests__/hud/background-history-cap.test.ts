import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hud/state.js', () => ({
  readHudState: vi.fn(),
  writeHudState: vi.fn(() => true),
  createEmptyHudState: vi.fn(),
}));

import { cleanupStaleBackgroundTasks } from '../../hud/background-cleanup.js';
import { addBackgroundTask } from '../../hud/background-tasks.js';
import { readHudState, writeHudState } from '../../hud/state.js';
import type { BackgroundTask } from '../../hud/types.js';

beforeEach(() => vi.clearAllMocks());

function tasks(runningCount: number): BackgroundTask[] {
  const timestamp = new Date().toISOString();
  return [
    ...Array.from({ length: runningCount }, (_, index): BackgroundTask => ({
      id: `running-${index}`, description: 'active', status: 'running', startedAt: timestamp,
    })),
    ...Array.from({ length: 3 }, (_, index): BackgroundTask => ({
      id: `completed-${index}`, description: 'done', status: 'completed', startedAt: timestamp, completedAt: timestamp,
    })),
  ];
}

describe('background history capacity with active tasks', () => {
  it.each([19, 20, 21])('startup cleanup preserves %i active tasks and only history that fits', async runningCount => {
    const state = { timestamp: new Date().toISOString(), backgroundTasks: tasks(runningCount) };
    vi.mocked(readHudState).mockReturnValue(state);
    const historyCount = Math.max(0, 20 - runningCount);
    expect(await cleanupStaleBackgroundTasks()).toBe(3 - historyCount);
    const written = vi.mocked(writeHudState).mock.calls[0][0].backgroundTasks;
    expect(written.filter(task => task.status === 'running').map(task => task.id))
      .toEqual(Array.from({ length: runningCount }, (_, index) => `running-${index}`));
    expect(written.filter(task => task.status !== 'running').map(task => task.id))
      .toEqual(historyCount ? ['completed-2'] : []);
  });

  it.each([18, 19, 20, 21])('task launch preserves %i existing active tasks without retaining excess history', runningCount => {
    vi.mocked(readHudState).mockReturnValue({ timestamp: new Date().toISOString(), backgroundTasks: tasks(runningCount) });
    expect(addBackgroundTask('new-active', 'new task')).toBe(true);
    const written = vi.mocked(writeHudState).mock.calls[0][0].backgroundTasks;
    expect(written.filter(task => task.status === 'running').map(task => task.id))
      .toEqual([...Array.from({ length: runningCount }, (_, index) => `running-${index}`), 'new-active']);
    expect(written.filter(task => task.status !== 'running').map(task => task.id))
      .toEqual(runningCount < 19 ? ['completed-2'] : []);
  });
});
