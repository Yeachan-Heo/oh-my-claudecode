import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatSessionSummary, interpolatePath, triggerStopCallbacks } from '../callbacks.js';
import type { SessionMetrics } from '../index.js';

// Mock auto-update module
vi.mock('../../../features/auto-update.js', () => ({
  getOMCConfig: vi.fn(() => ({
    silentAutoUpdate: false,
    stopHookCallbacks: undefined,
  })),
}));

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Import mocked modules
import { getOMCConfig } from '../../../features/auto-update.js';
import { writeFileSync, mkdirSync } from 'fs';

const mockGetConfig = vi.mocked(getOMCConfig);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function createTestMetrics(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    session_id: 'test-session-123',
    started_at: '2026-02-04T10:00:00.000Z',
    ended_at: '2026-02-04T11:00:00.000Z',
    reason: 'clear',
    duration_ms: 3600000, // 1 hour
    agents_spawned: 5,
    agents_completed: 4,
    modes_used: ['ultrawork'],
    ...overrides,
  };
}

describe('formatSessionSummary', () => {
  it('formats markdown summary with all fields', () => {
    const metrics = createTestMetrics();
    const summary = formatSessionSummary(metrics);

    expect(summary).toContain('test-session-123');
    expect(summary).toContain('60m 0s');
    expect(summary).toContain('clear');
    expect(summary).toContain('5');
    expect(summary).toContain('4');
  });

  it('handles unknown duration', () => {
    const metrics = createTestMetrics({ duration_ms: undefined });
    const summary = formatSessionSummary(metrics);

    expect(summary).toContain('unknown');
  });

  it('handles no modes used', () => {
    const metrics = createTestMetrics({ modes_used: [] });
    const summary = formatSessionSummary(metrics);

    expect(summary).toContain('none');
  });

  it('formats JSON summary', () => {
    const metrics = createTestMetrics();
    const summary = formatSessionSummary(metrics, 'json');

    const parsed = JSON.parse(summary);
    expect(parsed.session_id).toBe('test-session-123');
    expect(parsed.duration_ms).toBe(3600000);
  });

  it('formats short durations correctly', () => {
    const metrics = createTestMetrics({ duration_ms: 90000 }); // 1m 30s
    const summary = formatSessionSummary(metrics);

    expect(summary).toContain('1m 30s');
  });
});

describe('interpolatePath', () => {
  it('replaces {session_id} placeholder', () => {
    const result = interpolatePath('/tmp/{session_id}.md', 'abc-123');
    expect(result).toBe('/tmp/abc-123.md');
  });

  it('replaces {date} placeholder', () => {
    const result = interpolatePath('/tmp/{date}.md', 'session-1');
    // Date should be YYYY-MM-DD format
    expect(result).toMatch(/\/tmp\/\d{4}-\d{2}-\d{2}\.md/);
  });

  it('replaces {time} placeholder', () => {
    const result = interpolatePath('/tmp/{time}.md', 'session-1');
    // Time should be HH-MM-SS format
    expect(result).toMatch(/\/tmp\/\d{2}-\d{2}-\d{2}\.md/);
  });

  it('replaces ~ with homedir', () => {
    const result = interpolatePath('~/logs/test.md', 'session-1');
    expect(result).not.toContain('~');
    expect(result).toContain('/logs/test.md');
  });

  it('replaces multiple placeholders', () => {
    const result = interpolatePath('/tmp/{date}/{session_id}.md', 'my-session');
    expect(result).toContain('my-session');
    expect(result).toMatch(/\/tmp\/\d{4}-\d{2}-\d{2}\/my-session\.md/);
  });

  it('handles paths without placeholders', () => {
    const result = interpolatePath('/tmp/fixed-path.md', 'session-1');
    expect(result).toBe('/tmp/fixed-path.md');
  });
});

describe('triggerStopCallbacks', () => {
  const testInput = { session_id: 'test-session-123', cwd: '/tmp/test' };

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset global fetch mock
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when no callbacks configured', async () => {
    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: undefined,
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when callbacks object is empty', async () => {
    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {},
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('writes file when file callback is enabled', async () => {
    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        file: {
          enabled: true,
          path: '/tmp/test-{session_id}.md',
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-test-session-123.md',
      expect.stringContaining('test-session-123'),
      { encoding: 'utf-8', mode: 0o600 }
    );
  });

  it('writes JSON format when configured', async () => {
    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        file: {
          enabled: true,
          path: '/tmp/test.json',
          format: 'json' as const,
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test.json',
      expect.stringContaining('"session_id"'),
      { encoding: 'utf-8', mode: 0o600 }
    );
  });

  it('skips disabled file callback', async () => {
    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        file: {
          enabled: false,
          path: '/tmp/test.md',
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('sends Telegram notification when enabled', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        telegram: {
          enabled: true,
          botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxyz012345678',
          chatId: '12345',
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrSTUvwxyz012345678/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"chat_id":"12345"'),
      })
    );
  });

  it('prefixes Telegram messages with normalized tags from tagList', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        telegram: {
          enabled: true,
          botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxyz012345678',
          chatId: '12345',
          tagList: ['@alice', 'bob', '  ', '', 'charlie'],
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    const request = mockFetch.mock.calls[0]?.[1] as { body: string };
    const payload = JSON.parse(request.body) as { text: string };
    expect(payload.text.startsWith('@alice @bob @charlie\n# Session Ended')).toBe(true);
  });

  it('skips Telegram when missing credentials', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        telegram: {
          enabled: true,
          // Missing botToken and chatId
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends Discord notification when enabled', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('test-session-123'),
      })
    );
  });

  it('prefixes Discord messages with normalized tags from tagList', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
          tagList: ['@here', '@everyone', 'role:123', '456', 'dev-team', '  ', ''],
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    const request = mockFetch.mock.calls[0]?.[1] as { body: string };
    const payload = JSON.parse(request.body) as { content: string };
    expect(payload.content.startsWith('@here @everyone <@&123> <@456> dev-team\n# Session Ended')).toBe(true);
  });

  it('skips Discord when missing webhook URL', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: {
          enabled: true,
          // Missing webhookUrl
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles file write errors gracefully', async () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        file: {
          enabled: true,
          path: '/root/protected/test.md',
        },
      },
    });

    const metrics = createTestMetrics();
    // Should not throw
    await expect(triggerStopCallbacks(metrics, testInput)).resolves.not.toThrow();
  });

  it('handles Telegram API errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        telegram: {
          enabled: true,
          botToken: '123456789:BADtokenABCdefGHIjklMNO012345678',
          chatId: '12345',
        },
      },
    });

    const metrics = createTestMetrics();
    // Should not throw
    await expect(triggerStopCallbacks(metrics, testInput)).resolves.not.toThrow();
  });

  it('handles network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
        },
      },
    });

    const metrics = createTestMetrics();
    // Should not throw
    await expect(triggerStopCallbacks(metrics, testInput)).resolves.not.toThrow();
  });

  it('executes multiple callbacks in parallel', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK'),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetConfig.mockReturnValue({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        file: {
          enabled: true,
          path: '/tmp/test.md',
        },
        telegram: {
          enabled: true,
          botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxyz012345678',
          chatId: '12345',
        },
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
        },
      },
    });

    const metrics = createTestMetrics();
    await triggerStopCallbacks(metrics, testInput);

    // File callback
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    // Telegram + Discord = 2 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});