/**
 * Tests for the User-Agent on `GET /api/oauth/usage`.
 *
 * The endpoint buckets its rate limit by User-Agent, and a request that does not
 * name a Claude Code *version* lands in a bucket that allows roughly one request
 * per hour. Measured against api.anthropic.com with a single OAuth token,
 * requests seconds apart, recording status and `retry-after` only:
 *
 *   User-Agent           | HTTP | retry-after
 *   ---------------------|------|--------------------------------------------
 *   (header omitted)     | 429  | 348s
 *   claude-code          | 429  | 349s / 348s - same absolute deadline
 *   claude-code/2.1.232  | 403  | none - the endpoint's real answer
 *   claude-code/9.9.9    | 403  | none - the endpoint's real answer
 *
 * The 403 is the token's own scope error, i.e. a real per-request answer rather
 * than a throttle. Two things follow, and both are asserted below: a versioned
 * product token is what unlocks the bucket, and a version-less one buys nothing,
 * so we send no header at all rather than a fabricated version.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { buildUserAgent, getUsage } from '../../hud/usage-api.js';

const lockState = vi.hoisted(() => ({ tail: Promise.resolve() }));

// Mock file-lock so withFileLock always executes the callback.
vi.mock('../../lib/file-lock.js', () => ({
  withFileLock: vi.fn((_lockPath: string, fn: () => unknown) => {
    const run = lockState.tail.then(fn);
    lockState.tail = run.then(() => undefined, () => undefined);
    return run;
  }),
  lockPathFor: vi.fn((p: string) => p + '.lock'),
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

// Keychain lookups must fail so the credential read falls through to the file
// path, which is the one branch that behaves identically on macOS and Linux CI.
vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
}));

vi.mock('https', () => ({
  default: {
    request: vi.fn(),
  },
}));

const FAKE_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access-token-not-a-real-secret',
    refreshToken: 'test-refresh-token-not-a-real-secret',
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
});

/** Serve credentials from the file path and nothing else, so the usage cache stays absent. */
function stubCredentialFile(): void {
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => typeof p === 'string' && p.endsWith('.credentials.json'),
  );
  vi.mocked(fs.readFileSync).mockImplementation(
    (p) => (typeof p === 'string' && p.endsWith('.credentials.json') ? FAKE_CREDENTIALS : '{}') as never,
  );
}

/** Answer the next https.request with a minimal 200 usage payload. */
function stubUsage200(httpsRequest: ReturnType<typeof vi.fn>): void {
  httpsRequest.mockImplementationOnce((_options: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify({ five_hour: { utilization: 11 }, seven_day: { utilization: 22 } }));
      res.emit('end');
    };
    return req;
  });
}

/** Answer the next https.request with a rate-limit response. */
function stubUsage429(httpsRequest: ReturnType<typeof vi.fn>): void {
  httpsRequest.mockImplementationOnce((_options: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = 429;
      callback(res);
      res.emit('data', JSON.stringify({ error: { type: 'rate_limit_error' } }));
      res.emit('end');
    };
    return req;
  });
}

describe('buildUserAgent', () => {
  it('names the Claude Code version the session is actually running', () => {
    // Mutation that fails this: drop the header, or stop interpolating the version.
    expect(buildUserAgent('2.1.232')).toBe('claude-code/2.1.232');
  });

  it('accepts a prerelease or build suffix', () => {
    expect(buildUserAgent('2.1.232-beta.1')).toBe('claude-code/2.1.232-beta.1');
  });

  it('returns undefined rather than "claude-code/undefined" when no version is known', () => {
    // Mutation that fails this: template the version unconditionally.
    expect(buildUserAgent(undefined)).toBeUndefined();
    expect(buildUserAgent('')).toBeUndefined();
    expect(buildUserAgent('   ')).toBeUndefined();
  });

  it('refuses a value that is not version-shaped instead of inventing one', () => {
    // Mutation that fails this: drop the shape test and pass the string through.
    expect(buildUserAgent('abc')).toBeUndefined();
    expect(buildUserAgent('2.1')).toBeUndefined();
    expect(buildUserAgent('v2.1.232')).toBeUndefined();
  });

  it('refuses a version carrying header-unsafe characters', () => {
    // A version reaches us from a JSON payload, so an unanchored prefix match
    // would let CR/LF or a stray token into an outgoing header.
    // Mutation that fails this: unanchor the pattern (drop the trailing `$`).
    expect(buildUserAgent('2.1.232\r\nX-Injected: 1')).toBeUndefined();
    expect(buildUserAgent('2.1.232 (external, cli)')).toBeUndefined();
  });
});

describe('GET /api/oauth/usage request headers', () => {
  let httpsModule: { default: { request: ReturnType<typeof vi.fn> } };
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    lockState.tail = Promise.resolve();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    httpsModule = await import('https') as unknown as typeof httpsModule;
    stubCredentialFile();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends the versioned product token when the statusline reports a version', async () => {
    stubUsage200(httpsModule.default.request);

    await getUsage({ clientVersion: '2.1.232' });

    expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
    const headers = httpsModule.default.request.mock.calls[0][0].headers;
    expect(headers['User-Agent']).toBe('claude-code/2.1.232');
    // The headers this request already sent must be untouched by the addition.
    expect(headers.Authorization).toBe('Bearer test-access-token-not-a-real-secret');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the header entirely when no version is known, rather than sending a made-up one', async () => {
    stubUsage200(httpsModule.default.request);

    await getUsage();

    expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
    const headers = httpsModule.default.request.mock.calls[0][0].headers;
    // Not just falsy: the key must be absent, so nothing serializes as
    // "User-Agent: undefined" on the wire.
    // Mutation that fails this: fall back to a bare or hard-coded product token.
    expect('User-Agent' in headers).toBe(false);
    expect(headers.Authorization).toBe('Bearer test-access-token-not-a-real-secret');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the header when the reported version is unusable', async () => {
    stubUsage200(httpsModule.default.request);

    await getUsage({ clientVersion: 'not-a-version' });

    const headers = httpsModule.default.request.mock.calls[0][0].headers;
    expect('User-Agent' in headers).toBe(false);
  });

  it('does not let an anonymous 429 suppress a concurrent versioned request', async () => {
    const cacheFiles = new Map<string, string>();
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p).endsWith('.credentials.json') || cacheFiles.has(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const path = String(p);
      return (path.endsWith('.credentials.json') ? FAKE_CREDENTIALS : cacheFiles.get(path) ?? '{}') as never;
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p, content) => {
      cacheFiles.set(String(p), String(content));
    });

    stubUsage429(httpsModule.default.request);
    stubUsage200(httpsModule.default.request);

    const [, versioned] = await Promise.all([
      getUsage(),
      getUsage({ clientVersion: '2.1.232' }),
    ]);

    expect(httpsModule.default.request).toHaveBeenCalledTimes(2);
    const requests = httpsModule.default.request.mock.calls.map((call) => call[0].headers);
    expect(requests.some((headers) => !('User-Agent' in headers))).toBe(true);
    expect(requests.some((headers) => headers['User-Agent'] === 'claude-code/2.1.232')).toBe(true);
    expect(versioned.rateLimits).not.toBeNull();
    expect(versioned.error).toBeUndefined();
  });

  it('keeps active Anthropic backoffs independent for different versions', async () => {
    const cacheFiles = new Map<string, string>();
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p).endsWith('.credentials.json') || cacheFiles.has(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const path = String(p);
      return (path.endsWith('.credentials.json') ? FAKE_CREDENTIALS : cacheFiles.get(path) ?? '{}') as never;
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p, content) => {
      cacheFiles.set(String(p), String(content));
    });

    stubUsage429(httpsModule.default.request);
    stubUsage429(httpsModule.default.request);

    await Promise.all([
      getUsage({ clientVersion: '2.1.232' }),
      getUsage({ clientVersion: '2.1.233' }),
    ]);
    const firstFollowUp = await getUsage({ clientVersion: '2.1.232' });
    const secondFollowUp = await getUsage({ clientVersion: '2.1.233' });

    expect(httpsModule.default.request).toHaveBeenCalledTimes(2);
    expect(firstFollowUp.error).toBe('rate_limited');
    expect(secondFollowUp.error).toBe('rate_limited');
  });
});
