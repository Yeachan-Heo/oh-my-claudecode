import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { registerStandaloneShutdownHandlers } from '../standalone-shutdown.js';

class MockProcess extends EventEmitter {
  stdin = new EventEmitter();
  ppid = 4242;
}

describe('registerStandaloneShutdownHandlers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs shutdown when stdin ends', async () => {
    const processRef = new MockProcess();
    const onShutdown = vi.fn(async () => undefined);

    registerStandaloneShutdownHandlers({ processRef, onShutdown });
    processRef.stdin.emit('end');
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledWith('stdin end');
    });
  });

  it('runs shutdown when parent disconnects', async () => {
    const processRef = new MockProcess();
    const onShutdown = vi.fn(async () => undefined);

    registerStandaloneShutdownHandlers({ processRef, onShutdown });
    processRef.emit('disconnect');
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledWith('parent disconnect');
    });
  });

  it('deduplicates shutdown when multiple termination events arrive', async () => {
    const processRef = new MockProcess();
    const onShutdown = vi.fn(async () => undefined);

    registerStandaloneShutdownHandlers({ processRef, onShutdown });
    processRef.stdin.emit('end');
    processRef.stdin.emit('close');
    processRef.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });
    expect(onShutdown).toHaveBeenCalledWith('stdin end');
  });

  it('runs shutdown when parent pid changes to init/orphaned state', async () => {
    vi.useFakeTimers();

    const processRef = new MockProcess();
    const onShutdown = vi.fn(async () => undefined);

    registerStandaloneShutdownHandlers({
      processRef,
      onShutdown,
      pollIntervalMs: 50,
    });

    processRef.ppid = 1;
    await vi.advanceTimersByTimeAsync(120);

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith(expect.stringContaining('parent pid changed'));
  });
});
