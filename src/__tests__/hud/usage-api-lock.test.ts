import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const CLAUDE_CONFIG_DIR = '/tmp/test-claude';
const CACHE_PATH = `${CLAUDE_CONFIG_DIR}/plugins/oh-my-claudecode/.usage-cache.json`;
const LOCK_PATH = `${CACHE_PATH}.lock`;
const CACHE_DIR = `${CLAUDE_CONFIG_DIR}/plugins/oh-my-claudecode`;

function createFsMock(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles));
  const directories = new Set<string>([CLAUDE_CONFIG_DIR]);

  const existsSync = vi.fn((path: string) => files.has(String(path)) || directories.has(String(path)));
  const readFileSync = vi.fn((path: string) => {
    const content = files.get(String(path));
    if (content == null) throw new Error(`ENOENT: ${path}`);
    return content;
  });
  const writeFileSync = vi.fn((path: string, content: string) => {
    files.set(String(path), String(content));
  });
  const mkdirSync = vi.fn((path: string) => {
    directories.add(String(path));
  });
  const unlinkSync = vi.fn((path: string) => {
    files.delete(String(path));
  });
  const openSync = vi.fn((path: string) => {
    const normalized = String(path);
    if (files.has(normalized)) {
      const err = new Error(`EEXIST: ${normalized}`) as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    }
    files.set(normalized, '');
    return 1;
  });
  const statSync = vi.fn((path: string) => {
    if (!files.has(String(path))) throw new Error(`ENOENT: ${path}`);
    return { mtimeMs: Date.now() };
  });

  return {
    files,
    fsModule: {
      existsSync,
      readFileSync,
      writeFileSync,
      mkdirSync,
      unlinkSync,
      openSync,
      statSync,
      writeSync: vi.fn(),
      closeSync: vi.fn(),
      renameSync: vi.fn(),
      constants: {
        O_CREAT: 0x40,
        O_EXCL: 0x80,
        O_WRONLY: 0x1,
      },
    },
  };
}

describe('getUsage lock behavior', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('../../utils/paths.js');
    vi.unmock('../../utils/ssrf-guard.js');
    vi.unmock('fs');
    vi.unmock('child_process');
    vi.unmock('https');
  });

  it('acquires lock before API call when cache is expired', async () => {
    const expiredCache = JSON.stringify({
      timestamp: Date.now() - 91_000,
      source: 'zai',
      data: {
        fiveHourPercent: 12,
        fiveHourResetsAt: null,
      },
    });

    const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
    let requestSawLock = false;

    vi.doMock('../../utils/paths.js', () => ({
      getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
    }));
    vi.doMock('../../utils/ssrf-guard.js', () => ({
      validateAnthropicBaseUrl: () => ({ allowed: true }),
    }));
    vi.doMock('child_process', () => ({
      execSync: vi.fn(),
    }));
    vi.doMock('fs', () => fsModule);
    vi.doMock('https', () => ({
      default: {
        request: vi.fn((options: Record<string, unknown>, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
          requestSawLock = files.has(LOCK_PATH);

          const req = new EventEmitter() as EventEmitter & {
            destroy: () => void;
            end: () => void;
          };
          req.destroy = vi.fn();
          req.end = () => {
            setTimeout(() => {
              const res = new EventEmitter() as EventEmitter & { statusCode?: number };
              res.statusCode = 200;
              callback(res);
              res.emit('data', JSON.stringify({
                data: {
                  limits: [
                    { type: 'TOKENS_LIMIT', percentage: 67, nextResetTime: Date.now() + 3_600_000 },
                  ],
                },
              }));
              res.emit('end');
            }, 10);
          };
          return req;
        }),
      },
    }));

    const { getUsage } = await import('../../hud/usage-api.js');
    const httpsModule = await import('https') as unknown as { default: { request: ReturnType<typeof vi.fn> } };

    const [first, second] = await Promise.all([getUsage(), getUsage()]);

    expect(requestSawLock).toBe(true);
    expect(fsModule.openSync.mock.invocationCallOrder[0]).toBeLessThan(
      httpsModule.default.request.mock.invocationCallOrder[0],
    );
    expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      rateLimits: {
        fiveHourPercent: 67,
        fiveHourResetsAt: expect.any(Date),
        monthlyPercent: undefined,
        monthlyResetsAt: undefined,
      },
    });
    expect(second).toEqual(first);
    expect(files.has(LOCK_PATH)).toBe(false);
    expect(files.get(CACHE_PATH)).toContain('"source": "zai"');
  });
});
