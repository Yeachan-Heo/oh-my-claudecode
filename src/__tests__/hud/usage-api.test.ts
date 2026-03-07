/**
 * Tests for z.ai host validation, response parsing, and getUsage routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { isZaiHost, parseZaiResponse, getUsage } from '../../hud/usage-api.js';

// Mock file-lock so withFileLock always executes the callback (tests focus on routing, not locking)
vi.mock('../../lib/file-lock.js', () => ({
  withFileLock: vi.fn((_lockPath: string, fn: () => unknown) => fn()),
  lockPathFor: vi.fn((p: string) => p + '.lock'),
}));

// Mock dependencies that touch filesystem / keychain / network
vi.mock('../../utils/paths.js', () => ({
  getClaudeConfigDir: () => '/tmp/test-claude',
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(1),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
    unlinkSync: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
}));

vi.mock('https', () => ({
  default: {
    request: vi.fn(),
  },
}));

describe('isZaiHost', () => {
  it('accepts exact z.ai hostname', () => {
    expect(isZaiHost('https://z.ai')).toBe(true);
    expect(isZaiHost('https://z.ai/')).toBe(true);
    expect(isZaiHost('https://z.ai/v1')).toBe(true);
  });

  it('accepts subdomains of z.ai', () => {
    expect(isZaiHost('https://api.z.ai')).toBe(true);
    expect(isZaiHost('https://api.z.ai/v1/messages')).toBe(true);
    expect(isZaiHost('https://foo.bar.z.ai')).toBe(true);
  });

  it('rejects hosts that merely contain z.ai as substring', () => {
    expect(isZaiHost('https://z.ai.evil.tld')).toBe(false);
    expect(isZaiHost('https://notz.ai')).toBe(false);
    expect(isZaiHost('https://z.ai.example.com')).toBe(false);
  });

  it('rejects unrelated hosts', () => {
    expect(isZaiHost('https://api.anthropic.com')).toBe(false);
    expect(isZaiHost('https://example.com')).toBe(false);
    expect(isZaiHost('https://localhost:8080')).toBe(false);
  });

  it('rejects invalid URLs gracefully', () => {
    expect(isZaiHost('')).toBe(false);
    expect(isZaiHost('not-a-url')).toBe(false);
    expect(isZaiHost('://missing-protocol')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isZaiHost('https://Z.AI/v1')).toBe(true);
    expect(isZaiHost('https://API.Z.AI')).toBe(true);
  });
});

describe('parseZaiResponse', () => {
  it('returns null for empty response', () => {
    expect(parseZaiResponse({})).toBeNull();
    expect(parseZaiResponse({ data: {} })).toBeNull();
    expect(parseZaiResponse({ data: { limits: [] } })).toBeNull();
  });

  it('returns null when no known limit types exist', () => {
    const response = {
      data: {
        limits: [{ type: 'UNKNOWN_LIMIT', percentage: 50 }],
      },
    };
    expect(parseZaiResponse(response)).toBeNull();
  });

  it('parses TOKENS_LIMIT as fiveHourPercent', () => {
    const response = {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: Date.now() + 3600_000 },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.fiveHourPercent).toBe(42);
    expect(result!.fiveHourResetsAt).toBeInstanceOf(Date);
  });

  it('parses TIME_LIMIT as monthlyPercent', () => {
    const response = {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 10 },
          { type: 'TIME_LIMIT', percentage: 75, nextResetTime: Date.now() + 86400_000 },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.monthlyPercent).toBe(75);
    expect(result!.monthlyResetsAt).toBeInstanceOf(Date);
  });

  it('does not set weeklyPercent (z.ai has no weekly quota)', () => {
    const response = {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 50 },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.weeklyPercent).toBeUndefined();
  });

  it('clamps percentages to 0-100', () => {
    const response = {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 150 },
          { type: 'TIME_LIMIT', percentage: -10 },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.fiveHourPercent).toBe(100);
    expect(result!.monthlyPercent).toBe(0);
  });

  it('parses monthly-only limited state (TIME_LIMIT without TOKENS_LIMIT)', () => {
    const resetTime = Date.now() + 86400_000 * 7;
    const response = {
      data: {
        limits: [
          { type: 'TIME_LIMIT', percentage: 90, nextResetTime: resetTime },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.fiveHourPercent).toBe(0); // clamped from undefined
    expect(result!.monthlyPercent).toBe(90);
    expect(result!.monthlyResetsAt).toBeInstanceOf(Date);
    expect(result!.monthlyResetsAt!.getTime()).toBe(resetTime);
    expect(result!.weeklyPercent).toBeUndefined();
  });

  it('handles TIME_LIMIT without nextResetTime', () => {
    const response = {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 10 },
          { type: 'TIME_LIMIT', percentage: 50 },
        ],
      },
    };

    const result = parseZaiResponse(response);
    expect(result).not.toBeNull();
    expect(result!.monthlyPercent).toBe(50);
    expect(result!.monthlyResetsAt).toBeNull();
  });
});

describe('getUsage routing', () => {
  const originalEnv = { ...process.env };
  let httpsModule: { default: { request: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset env
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    // Get the mocked https module for assertions
    httpsModule = await import('https') as unknown as typeof httpsModule;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns no_credentials error when no credentials and no z.ai env', async () => {
    const result = await getUsage();
    expect(result.rateLimits).toBeNull();
    expect(result.error).toBe('no_credentials');
    // No network call should be made without credentials
    expect(httpsModule.default.request).not.toHaveBeenCalled();
  });

  it('routes to z.ai when ANTHROPIC_BASE_URL is z.ai host', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';

    // https.request mock not wired, so fetchUsageFromZai resolves to null (network error)
    const result = await getUsage();
    expect(result.rateLimits).toBeNull();
    expect(result.error).toBe('network');

    // Verify z.ai quota endpoint was called
    expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
    const callArgs = httpsModule.default.request.mock.calls[0][0];
    expect(callArgs.hostname).toBe('api.z.ai');
    expect(callArgs.path).toBe('/api/monitor/usage/quota/limit');
  });

  it('does NOT route to z.ai for look-alike hosts', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://z.ai.evil.tld/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';

    const result = await getUsage();
    expect(result.rateLimits).toBeNull();
    expect(result.error).toBe('no_credentials');

    // Should NOT call https.request with z.ai endpoint.
    // Falls through to OAuth path which has no credentials (mocked),
    // so no network call should be made at all.
    expect(httpsModule.default.request).not.toHaveBeenCalled();
  });

  it('returns error when API call fails', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';

    // Mock failed API response (network error)
    const result = await getUsage();
    expect(result.rateLimits).toBeNull();
    expect(result.error).toBe('network');
  });

  it('reuses successful cached usage data for 90 seconds to avoid excessive polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));

    const mockedExistsSync = vi.mocked(fs.existsSync);
    const mockedReadFileSync = vi.mocked(fs.readFileSync);

    mockedExistsSync.mockImplementation((path) => String(path).endsWith('.usage-cache.json'));
    mockedReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('.usage-cache.json')) {
        return JSON.stringify({
          timestamp: Date.now() - 60_000,
          source: 'anthropic',
          data: {
            fiveHourPercent: 42,
            weeklyPercent: 17,
            fiveHourResetsAt: null,
            weeklyResetsAt: null,
          },
        });
      }
      return '{}';
    });

    const result = await getUsage();

    expect(result).toEqual({
      rateLimits: {
        fiveHourPercent: 42,
        weeklyPercent: 17,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
      },
      error: undefined,
    });
    expect(httpsModule.default.request).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
