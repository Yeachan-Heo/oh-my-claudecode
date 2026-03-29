/**
 * @file parallel-spawn.ts — 에디터 병렬 스폰 유틸.
 * Promise.allSettled로 한 에디터 실패가 전체를 중단시키지 않음.
 * maxConcurrency로 동시 실행 수 제한 가능.
 */

export interface EditorTask {
  editorId: string;
  slot: { category: string; time: string; [k: string]: unknown };
}

export interface SpawnResult {
  editorId: string;
  status: 'ok' | 'failed';
  draft?: string;
  error?: string;
}

type SpawnFn = (task: EditorTask) => Promise<{ draft: string; status: 'ok' }>;

/**
 * 에디터를 병렬로 스폰하되 maxConcurrency로 동시 실행 수를 제한.
 * Promise.allSettled로 한 에디터 실패가 전체를 중단시키지 않음.
 */
export async function spawnEditorsParallel(
  tasks: EditorTask[],
  spawnFn: SpawnFn,
  opts?: { maxConcurrency?: number },
): Promise<SpawnResult[]> {
  const maxConcurrency = opts?.maxConcurrency ?? tasks.length;

  if (maxConcurrency >= tasks.length) {
    // No concurrency limit needed — run all at once
    const settled = await Promise.allSettled(
      tasks.map(task => spawnFn(task)),
    );
    return settled.map((result, i) => {
      if (result.status === 'fulfilled') {
        return { editorId: tasks[i].editorId, status: 'ok' as const, draft: result.value.draft };
      }
      return { editorId: tasks[i].editorId, status: 'failed' as const, error: String(result.reason) };
    });
  }

  // Semaphore-based concurrency control
  const results: SpawnResult[] = [];
  let running = 0;
  let idx = 0;

  await new Promise<void>(resolve => {
    function next() {
      if (idx >= tasks.length && running === 0) {
        resolve();
        return;
      }
      while (running < maxConcurrency && idx < tasks.length) {
        const taskIdx = idx++;
        const task = tasks[taskIdx];
        running++;
        spawnFn(task)
          .then(res => {
            results[taskIdx] = { editorId: task.editorId, status: 'ok', draft: res.draft };
          })
          .catch(err => {
            results[taskIdx] = { editorId: task.editorId, status: 'failed', error: String(err) };
          })
          .finally(() => {
            running--;
            next();
          });
      }
    }
    next();
  });

  return results;
}
