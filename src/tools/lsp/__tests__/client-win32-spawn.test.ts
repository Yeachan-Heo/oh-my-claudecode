import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';

// Mock servers module
vi.mock('../servers.js', () => ({
  getServerForFile: vi.fn(),
  commandExists: vi.fn(() => true),
}));

// Mock child_process.spawn — capture the 'error' handler and fire it
// immediately so connect() rejects fast, but spawn args are still recorded.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    type EventHandler = (...args: unknown[]) => void;
    const handlers: Record<string, EventHandler> = {};
    const proc = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: EventHandler) => {
        handlers[event] = cb;
        // Fire error asynchronously so spawn() returns first
        if (event === 'error') {
          setTimeout(() => cb(new Error('mock')), 0);
        }
      }),
      kill: vi.fn(),
      pid: 12345,
    };
    return proc;
  }),
}));

const mockSpawn = vi.mocked(spawn);

describe('LspClient Windows spawn shell option (#569)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
    mockSpawn.mockClear();
  });

  it('should pass shell: true on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { LspClient } = await import('../client.js');

    const client = new LspClient('/tmp/workspace', {
      name: 'test-server',
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensions: ['.ts'],
      installHint: 'npm i -g typescript-language-server',
    });

    await client.connect().catch(() => {});

    expect(mockSpawn).toHaveBeenCalledOnce();
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts).toMatchObject({ shell: true });
  });

  it('should pass shell: false on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { LspClient } = await import('../client.js');

    const client = new LspClient('/tmp/workspace', {
      name: 'test-server',
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensions: ['.ts'],
      installHint: 'npm i -g typescript-language-server',
    });

    await client.connect().catch(() => {});

    expect(mockSpawn).toHaveBeenCalledOnce();
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts).toMatchObject({ shell: false });
  });

  it('should pass shell: false on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { LspClient } = await import('../client.js');

    const client = new LspClient('/tmp/workspace', {
      name: 'test-server',
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensions: ['.ts'],
      installHint: 'npm i -g typescript-language-server',
    });

    await client.connect().catch(() => {});

    expect(mockSpawn).toHaveBeenCalledOnce();
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts).toMatchObject({ shell: false });
  });
});
