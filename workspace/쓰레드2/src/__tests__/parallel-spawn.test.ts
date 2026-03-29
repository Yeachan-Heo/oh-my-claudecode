/**
 * @file parallel-spawn.test.ts — spawnEditorsParallel TDD
 * 동시 실행, 실패 격리, maxConcurrency 제한 검증
 */

import { describe, it, expect, vi } from 'vitest';
import { spawnEditorsParallel, type EditorTask } from '../orchestrator/parallel-spawn.js';

describe('spawnEditorsParallel', () => {
  it('should run multiple editor tasks concurrently', async () => {
    const callOrder: string[] = [];
    const mockSpawnFn = vi.fn().mockImplementation(async (task: EditorTask) => {
      callOrder.push(`start:${task.editorId}`);
      await new Promise(r => setTimeout(r, 10));
      callOrder.push(`end:${task.editorId}`);
      return { draft: `draft-${task.editorId}`, status: 'ok' as const };
    });

    const tasks: EditorTask[] = [
      { editorId: 'bini-beauty-editor', slot: { category: '뷰티', time: '09:00' } },
      { editorId: 'hana-health-editor', slot: { category: '건강', time: '12:00' } },
    ];

    const results = await spawnEditorsParallel(tasks, mockSpawnFn);
    expect(results).toHaveLength(2);
    expect(results.filter(r => r.status === 'ok')).toHaveLength(2);

    // Verify concurrent execution: both should start before either ends
    expect(callOrder[0]).toBe('start:bini-beauty-editor');
    expect(callOrder[1]).toBe('start:hana-health-editor');
  });

  it('should isolate failures — one editor fail does not block others', async () => {
    const mockSpawnFn = vi.fn()
      .mockResolvedValueOnce({ draft: 'ok', status: 'ok' as const })
      .mockRejectedValueOnce(new Error('editor crash'));

    const tasks: EditorTask[] = [
      { editorId: 'bini-beauty-editor', slot: { category: '뷰티', time: '09:00' } },
      { editorId: 'hana-health-editor', slot: { category: '건강', time: '12:00' } },
    ];

    const results = await spawnEditorsParallel(tasks, mockSpawnFn);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('failed');
  });

  it('should respect maxConcurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const mockSpawnFn = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return { draft: 'ok', status: 'ok' as const };
    });

    const tasks: EditorTask[] = Array.from({ length: 4 }, (_, i) => ({
      editorId: `editor-${i}`,
      slot: { category: 'test', time: '09:00' },
    }));

    await spawnEditorsParallel(tasks, mockSpawnFn, { maxConcurrency: 2 });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
