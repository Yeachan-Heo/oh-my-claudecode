type QueuedTask<T> = () => Promise<T>;

interface QueueEntry<T> {
  task: QueuedTask<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class CommandQueue {
  private queues: Map<string, QueueEntry<unknown>[]> = new Map();
  private processing: Set<string> = new Set();

  async enqueue<T>(sessionId: string, task: QueuedTask<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ task, resolve: resolve as (value: unknown) => void, reject });
      this.queues.set(sessionId, queue);

      this.processQueue(sessionId);
    });
  }

  private async processQueue(sessionId: string): Promise<void> {
    if (this.processing.has(sessionId)) return;

    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    this.processing.add(sessionId);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      try {
        const result = await entry.task();
        entry.resolve(result);
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.processing.delete(sessionId);
    this.queues.delete(sessionId);
  }

  getQueueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}

export const globalQueue = new CommandQueue();
