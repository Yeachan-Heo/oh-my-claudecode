import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient, LspClientManager } from '../client.js';

const SERVER_CONFIG = {
  name: 'test-server',
  command: 'test-lsp',
  args: [],
  extensions: ['.ts'],
  installHint: 'install test-lsp',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('LspClient.withOpenDocument', () => {
  it('sends didClose for a didOpen when the operation rejects', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-lifecycle-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const client = new LspClient(workspace, SERVER_CONFIG);
    const child = {};
    const state = client as unknown as { process: typeof child; connectionGeneration: number };
    state.process = child;
    state.connectionGeneration = 1;
    const notify = vi
      .spyOn(client as unknown as { notify: (method: string, params: unknown) => void }, 'notify')
      .mockImplementation(() => undefined);

    try {
      const operation = client.withOpenDocument(file, async () => {
        throw new Error('cancelled');
      });
      const rejection = expect(operation).rejects.toThrow('cancelled');
      await vi.advanceTimersByTimeAsync(100);
      await rejection;

      expect(notify.mock.calls.map(([method]) => method)).toEqual([
        'textDocument/didOpen',
        'textDocument/didClose',
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('serializes overlapping operations for the same document', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const ensureDocumentOpen = vi
      .spyOn(client as unknown as { ensureDocumentOpen: (file: string) => Promise<void> }, 'ensureDocumentOpen')
      .mockResolvedValue();
    const closeTransientDocument = vi
      .spyOn(client as unknown as { closeTransientDocument: (file: string) => Promise<void> }, 'closeTransientDocument')
      .mockResolvedValue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = client.withOpenDocument('/tmp/a.ts', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = client.withOpenDocument('/tmp/a.ts', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(ensureDocumentOpen).toHaveBeenCalledTimes(2);
    expect(closeTransientDocument).toHaveBeenCalledTimes(2);
  });

  it('does not close a document that was already open before the operation', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const hostUri = 'file:///tmp/a.ts';
    const state = client as unknown as { openDocuments: Set<string>; persistentDocuments: Set<string> };
    state.openDocuments.add(hostUri);
    state.persistentDocuments.add(hostUri);
    const closeTransientDocument = vi
      .spyOn(client as unknown as { closeTransientDocument: (file: string) => Promise<void> }, 'closeTransientDocument')
      .mockResolvedValue();

    await client.withOpenDocument('/tmp/a.ts', async () => undefined);

    expect(closeTransientDocument).not.toHaveBeenCalled();
  });

  it('closes transient ownership before a queued direct open takes ownership', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const ensureDocumentOpen = vi
      .spyOn(client as unknown as { ensureDocumentOpen: (file: string) => Promise<void> }, 'ensureDocumentOpen')
      .mockResolvedValue();
    const closeTransientDocument = vi
      .spyOn(client as unknown as { closeTransientDocument: (file: string) => Promise<void> }, 'closeTransientDocument')
      .mockResolvedValue();
    const operationGate = deferred();
    let operationStarted = false;

    const transient = client.withOpenDocument('/tmp/a.ts', async () => {
      operationStarted = true;
      await operationGate.promise;
    });
    await vi.waitFor(() => expect(operationStarted).toBe(true));

    const directOpen = client.openDocument('/tmp/a.ts');
    operationGate.resolve();
    await Promise.all([transient, directOpen]);

    expect(ensureDocumentOpen).toHaveBeenCalledTimes(2);
    expect(closeTransientDocument).toHaveBeenCalledOnce();
  });

  it('defers a direct close until an active transient operation finishes', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    vi.spyOn(
      client as unknown as { ensureDocumentOpen: (file: string) => Promise<void> },
      'ensureDocumentOpen'
    ).mockResolvedValue();
    const closeTransientDocument = vi
      .spyOn(
        client as unknown as { closeTransientDocument: (file: string) => Promise<void> },
        'closeTransientDocument'
      )
      .mockResolvedValue();
    const operationGate = deferred();
    let operationStarted = false;

    const transient = client.withOpenDocument('/tmp/a.ts', async () => {
      operationStarted = true;
      await operationGate.promise;
    });
    await vi.waitFor(() => expect(operationStarted).toBe(true));

    const directClose = client.closeDocument('/tmp/a.ts');
    await Promise.resolve();
    expect(closeTransientDocument).not.toHaveBeenCalled();

    operationGate.resolve();
    await Promise.all([transient, directClose]);
    expect(closeTransientDocument).toHaveBeenCalled();
  });

  it('waits for stdin drain before starting a transient operation', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-backpressure-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };
    let operationStarted = false;

    try {
      const operation = client.withOpenDocument(file, async () => {
        operationStarted = true;
      });
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      expect(operationStarted).toBe(false);
      expect(stdin.listenerCount('drain')).toBe(1);

      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(100);
      await operation;

      expect(operationStarted).toBe(true);
      expect(stdin.write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('serializes transient close before a direct reopen during backpressure', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-open-singleflight-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const transient = client.withOpenDocument(file, async () => undefined);
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      const direct = client.openDocument(file);

      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([transient, direct]);

      const methods = stdin.write.mock.calls.map(([message]) => String(message));
      expect(methods.filter(message => message.includes('textDocument/didOpen'))).toHaveLength(2);
      expect(methods.filter(message => message.includes('textDocument/didClose'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('does not write another document notification before stdin drains', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-notification-queue-'));
    const firstFile = join(workspace, 'a.ts');
    const secondFile = join(workspace, 'b.ts');
    writeFileSync(firstFile, 'const first = 1;');
    writeFileSync(secondFile, 'const second = 2;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const first = client.withOpenDocument(firstFile, async () => undefined);
      const second = client.withOpenDocument(secondFile, async () => undefined);
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      expect(stdin.write).toHaveBeenCalledOnce();

      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([first, second]);

      expect(stdin.write).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('does not write a request while a document notification waits for drain', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-request-queue-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const open = client.openDocument(file);
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      const request = (client as unknown as {
        request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
      }).request('workspace/symbol', { query: 'queued' }, 1_000);
      const rejection = expect(request).rejects.toThrow('force-killed');

      await Promise.resolve();
      expect(stdin.write).toHaveBeenCalledOnce();
      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(100);
      expect(stdin.write).toHaveBeenCalledTimes(2);

      client.forceKill();
      await rejection;
      await expect(open).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('rejects a pending request when stdin fails after accepting the write', async () => {
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(true),
    });
    const client = new LspClient('/tmp', SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };
    stdin.on('error', (error: Error) => {
      (client as unknown as { handleTransportFailure: (failure: Error) => void }).handleTransportFailure(error);
    });

    const request = (client as unknown as {
      request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
    }).request('workspace/symbol', { query: 'accepted' }, 1_000);
    const rejection = expect(request).rejects.toThrow('broken pipe');
    await vi.waitFor(() => expect(stdin.write).toHaveBeenCalledOnce());

    stdin.emit('error', new Error('broken pipe'));
    await rejection;
  });

  it('does not transmit a queued request after its timeout expires', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-request-timeout-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const open = client.openDocument(file);
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      const request = (client as unknown as {
        request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
      }).request('workspace/symbol', { query: 'expired' }, 10);
      const rejection = expect(request).rejects.toThrow("timed out after 10ms");

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(100);
      await open;

      expect(stdin.write.mock.calls.some(([message]) => String(message).includes('workspace/symbol'))).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('preserves a direct close requested while a direct open waits for drain', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-open-close-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const open = client.openDocument(file);
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }
      const close = client.closeDocument(file);

      stdin.emit('drain');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([open, close]);

      expect(stdin.write).toHaveBeenCalledTimes(2);
      expect(String(stdin.write.mock.calls[0][0])).toContain('textDocument/didOpen');
      expect(String(stdin.write.mock.calls[1][0])).toContain('textDocument/didClose');
    } finally {
      vi.useRealTimers();
      rmSync(workspace, { recursive: true });
    }
  });

  it('rejects a drain-blocked document operation when the client is force-killed', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-drain-cancel-'));
    const file = join(workspace, 'a.ts');
    writeFileSync(file, 'const value = 1;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(false),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };

    try {
      const operation = client.withOpenDocument(file, async () => undefined);
      const rejection = expect(operation).rejects.toThrow('force-killed');
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }

      client.forceKill();
      await rejection;
      expect(stdin.listenerCount('drain')).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true });
    }
  });

  it('rejects notifications queued behind a force-killed drain waiter', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lsp-client-queued-cancel-'));
    const firstFile = join(workspace, 'a.ts');
    const secondFile = join(workspace, 'b.ts');
    writeFileSync(firstFile, 'const first = 1;');
    writeFileSync(secondFile, 'const second = 2;');
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(false),
    });
    const client = new LspClient(workspace, SERVER_CONFIG);
    (client as unknown as { process: { stdin: typeof stdin } }).process = { stdin };
    let firstStarted = false;
    let secondStarted = false;

    try {
      const first = client.withOpenDocument(firstFile, async () => {
        firstStarted = true;
      });
      const second = client.withOpenDocument(secondFile, async () => {
        secondStarted = true;
      });
      for (let turn = 0; turn < 10 && stdin.listenerCount('drain') === 0; turn++) {
        await Promise.resolve();
      }

      client.forceKill();
      const results = await Promise.allSettled([first, second]);

      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(firstStarted).toBe(false);
      expect(secondStarted).toBe(false);
      expect(stdin.write).toHaveBeenCalledOnce();
    } finally {
      rmSync(workspace, { recursive: true });
    }
  });

  it('releases the document queue when didClose throws', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    vi.spyOn(
      client as unknown as { ensureDocumentOpen: (file: string) => Promise<void> },
      'ensureDocumentOpen'
    ).mockResolvedValue();
    const closeTransientDocument = vi.spyOn(
      client as unknown as { closeTransientDocument: (file: string) => Promise<void> },
      'closeTransientDocument'
    );
    closeTransientDocument.mockRejectedValueOnce(new Error('write failed')).mockResolvedValue();

    const first = client.withOpenDocument('/tmp/a.ts', async () => undefined);
    const second = client.withOpenDocument('/tmp/a.ts', async () => 'second completed');

    await expect(first).rejects.toThrow('write failed');
    await expect(second).resolves.toBe('second completed');
  });

  it('does not let a stale disconnect finalizer kill a replacement child', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const shutdownGate = deferred();
    const oldChild = { kill: vi.fn() };
    const newChild = { kill: vi.fn() };
    const state = client as unknown as {
      process: typeof oldChild | null;
      connectionGeneration: number;
      disconnected: boolean;
      request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
    };
    state.process = oldChild;
    state.connectionGeneration = 1;
    vi.spyOn(state, 'request').mockImplementation(() => shutdownGate.promise);

    const staleDisconnect = client.disconnect();
    await Promise.resolve();
    state.process = newChild;
    state.connectionGeneration = 2;
    state.disconnected = false;
    shutdownGate.resolve();
    await staleDisconnect;

    expect(oldChild.kill).toHaveBeenCalledOnce();
    expect(newChild.kill).not.toHaveBeenCalled();
    expect(state.process).toBe(newChild);
  });

  it('rejects document operations queued by a retired connection generation', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const operationGate = deferred();
    const state = client as unknown as {
      connectionGeneration: number;
      disconnected: boolean;
      terminalError: Error | null;
      openDocuments: Set<string>;
      persistentDocuments: Set<string>;
      ensureDocumentOpen: (file: string) => Promise<void>;
    };
    state.connectionGeneration = 1;
    vi.spyOn(state, 'ensureDocumentOpen').mockResolvedValue();
    let operationStarted = false;

    const active = client.withOpenDocument('/tmp/a.ts', async () => {
      operationStarted = true;
      await operationGate.promise;
    });
    await vi.waitFor(() => expect(operationStarted).toBe(true));
    const staleClose = client.closeDocument('/tmp/a.ts');
    const staleRejection = expect(staleClose).rejects.toThrow('connection was replaced');

    client.forceKill();
    state.connectionGeneration++;
    state.disconnected = false;
    state.terminalError = null;
    state.openDocuments.add('file:///tmp/a.ts');
    state.persistentDocuments.add('file:///tmp/a.ts');

    await staleRejection;
    expect(state.openDocuments.has('file:///tmp/a.ts')).toBe(true);
    expect(state.persistentDocuments.has('file:///tmp/a.ts')).toBe(true);
    operationGate.resolve();
    await active;
  });
});

describe('LspClientManager concurrent startup', () => {
  it('shares one client connection across concurrent leases', async () => {
    const manager = new LspClientManager();
    const connectGate = deferred();
    const connect = vi.spyOn(LspClient.prototype, 'connect').mockImplementation(() => connectGate.promise);
    vi.spyOn(LspClient.prototype, 'disconnect').mockResolvedValue();
    const leasedClients: LspClient[] = [];

    const first = manager.runWithClientLease('/tmp/a.ts', async (client) => {
      leasedClients.push(client);
    });
    const second = manager.runWithClientLease('/tmp/b.ts', async (client) => {
      leasedClients.push(client);
    });

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    connectGate.resolve();
    await Promise.all([first, second]);

    expect(leasedClients).toHaveLength(2);
    expect(leasedClients[0]).toBe(leasedClients[1]);
    expect(manager.clientCount).toBe(1);
    await manager.disconnectAll();
  });

  it('does not resurrect a client that finishes connecting after shutdown', async () => {
    const manager = new LspClientManager();
    const connectGate = deferred();
    const connect = vi.spyOn(LspClient.prototype, 'connect').mockImplementation(() => connectGate.promise);
    const forceKill = vi.spyOn(LspClient.prototype, 'forceKill').mockImplementation(() => undefined);
    connect.mockClear();
    forceKill.mockClear();

    const lease = manager.runWithClientLease('/tmp/a.ts', async () => undefined);
    const rejection = expect(lease).rejects.toThrow('shut down during connection');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    await manager.disconnectAll();
    connectGate.resolve();
    await rejection;

    expect(forceKill).toHaveBeenCalled();
    expect(manager.clientCount).toBe(0);
  });

  it('replaces a cached client after its server exits', async () => {
    const manager = new LspClientManager();
    const connect = vi.spyOn(LspClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(LspClient.prototype, 'disconnect').mockResolvedValue();
    connect.mockClear();

    const first = await manager.getClientForFile('/tmp/a.ts');
    (first as unknown as { disconnected: boolean }).disconnected = true;
    const second = await manager.getClientForFile('/tmp/b.ts');

    expect(second).not.toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.clientCount).toBe(1);
    await manager.disconnectAll();
  });

  it('waits for disconnectAll before acquiring a replacement client', async () => {
    const manager = new LspClientManager();
    const disconnectGate = deferred();
    const connect = vi.spyOn(LspClient.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LspClient.prototype, 'disconnect').mockImplementation(() => disconnectGate.promise);
    connect.mockClear();
    disconnect.mockClear();

    const first = await manager.getClientForFile('/tmp/a.ts');
    const teardown = manager.disconnectAll();
    const acquisition = manager.getClientForFile('/tmp/b.ts');

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(connect).toHaveBeenCalledOnce();

    disconnectGate.resolve();
    await teardown;
    const second = await acquisition;

    expect(second).not.toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.clientCount).toBe(1);
    vi.mocked(LspClient.prototype.disconnect).mockResolvedValue();
    await manager.disconnectAll();
  });

  it('retries a raw acquisition when the selected client is replaced before handoff', async () => {
    const manager = new LspClientManager();
    const first = new LspClient('/tmp', SERVER_CONFIG);
    const second = new LspClient('/tmp', SERVER_CONFIG);
    const key = '/tmp:typescript-language-server:host';
    const state = manager as unknown as {
      clients: Map<string, LspClient>;
      acquireClient: (...args: unknown[]) => Promise<LspClient>;
    };
    state.clients.set(key, second);
    const acquire = vi.spyOn(state, 'acquireClient')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const acquired = await manager.getClientForFile('/tmp/a.ts');

    expect(acquired).toBe(second);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('disconnects an active lease without waiting for its callback to finish', async () => {
    const manager = new LspClientManager();
    const leaseGate = deferred();
    vi.spyOn(LspClient.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LspClient.prototype, 'disconnect').mockResolvedValue();
    disconnect.mockClear();
    let leaseStarted = false;

    const lease = manager.runWithClientLease('/tmp/a.ts', async () => {
      leaseStarted = true;
      await leaseGate.promise;
    });
    await vi.waitFor(() => expect(leaseStarted).toBe(true));

    const teardown = manager.disconnectAll();
    await teardown;
    expect(disconnect).toHaveBeenCalledOnce();

    leaseGate.resolve();
    await lease;
  });
});

describe('LspClient diagnostic waiters', () => {
  it('keeps later waiters registered when an earlier waiter times out', async () => {
    vi.useFakeTimers();
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const waiters = (client as unknown as {
      diagnosticWaiters: Map<string, Array<() => void>>;
    }).diagnosticWaiters;

    try {
      const first = client.waitForDiagnostics('/tmp/a.ts', 10);
      const second = client.waitForDiagnostics('/tmp/a.ts', 100);

      await vi.advanceTimersByTimeAsync(10);
      await first;
      expect(Array.from(waiters.values())[0]).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(90);
      await second;
      expect(waiters.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects waiters when the transport fails', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const waiting = client.waitForDiagnostics('/tmp/a.ts', 1_000);
    const rejection = expect(waiting).rejects.toThrow('transport failed');

    (client as unknown as { handleTransportFailure: (error: Error) => void })
      .handleTransportFailure(new Error('transport failed'));

    await rejection;
  });

  it('rejects diagnostic waits started after terminal transport failure', async () => {
    const client = new LspClient('/tmp', SERVER_CONFIG);
    const state = client as unknown as {
      documentOpenPromises: Map<string, Promise<void>>;
      documentOperationTails: Map<string, Promise<void>>;
      diagnostics: Map<string, unknown[]>;
      buffer: Buffer;
      handleTransportFailure: (error: Error) => void;
    };
    state.documentOpenPromises.set('file:///tmp/a.ts', Promise.resolve());
    state.documentOperationTails.set('file:///tmp/a.ts', Promise.resolve());
    state.diagnostics.set('file:///tmp/a.ts', []);
    state.buffer = Buffer.from('partial frame');
    state.handleTransportFailure(new Error('terminal transport failure'));

    await expect(client.waitForDiagnostics('/tmp/a.ts', 10)).rejects.toThrow('terminal transport failure');
    expect(state.documentOpenPromises.size).toBe(0);
    expect(state.documentOperationTails.size).toBe(0);
    expect(state.diagnostics.size).toBe(0);
    expect(state.buffer).toHaveLength(0);
  });
});
