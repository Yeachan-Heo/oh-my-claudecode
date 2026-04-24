import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

import type { StatuslineStdin } from '../../hud/types.js';
import {
  getContextPercent,
  getModelName,
  getRateLimitsFromStdin,
  readStdinCache,
  stabilizeContextPercent,
  writeStdinCache,
} from '../../hud/stdin.js';

function makeStdin(overrides: Partial<StatuslineStdin> = {}): StatuslineStdin {
  return {
    cwd: '/tmp/worktree',
    transcript_path: '/tmp/worktree/session.jsonl',
    model: {
      id: 'claude-sonnet',
      display_name: 'Claude Sonnet',
    },
    context_window: {
      context_window_size: 1000,
      current_usage: {
        input_tokens: 520,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides.context_window,
    },
    ...overrides,
  };
}

describe('HUD stdin context percent', () => {
  it('prefers the native percentage when available', () => {
    const stdin = makeStdin({
      context_window: {
        used_percentage: 53.6,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 520,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(stdin)).toBe(54);
  });

  it('reuses the previous native percentage when a transient fallback would cause ctx jitter', () => {
    const previous = makeStdin({
      context_window: {
        used_percentage: 54,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 540,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const current = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 520,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(current)).toBe(52);
    expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(54);
  });

  it('ignores cache_read_input_tokens in the manual fallback calculation', () => {
    const stdin = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 250_000,
        },
      },
    });

    expect(getContextPercent(stdin)).toBe(15);
  });

  it('keeps preferring native percentage even when cache reads are huge', () => {
    const stdin = makeStdin({
      context_window: {
        used_percentage: 54,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 250_000,
        },
      },
    });

    expect(getContextPercent(stdin)).toBe(54);
  });

  it('does not hide a real context jump when the fallback differs materially', () => {
    const previous = makeStdin({
      context_window: {
        used_percentage: 80,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const current = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(20);
  });

  it('does not let cache-read spikes interfere with stabilization decisions', () => {
    const previous = makeStdin({
      context_window: {
        used_percentage: 54,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 540,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const current = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 520,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 250_000,
        },
      },
    });

    expect(getContextPercent(current)).toBe(52);
    expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(54);
  });
});


describe('HUD stdin model display', () => {
  it('prefers the official display_name over the raw model id', () => {
    expect(getModelName(makeStdin({
      model: {
        id: 'claude-sonnet-4-5-20250929',
        display_name: 'Claude Sonnet 4.5',
      },
    }))).toBe('Claude Sonnet 4.5');
  });

  it('falls back to the raw model id when display_name is unavailable', () => {
    expect(getModelName(makeStdin({
      model: {
        id: 'claude-sonnet-4-5-20250929',
      },
    }))).toBe('claude-sonnet-4-5-20250929');
  });

  it('returns Unknown when stdin omits the model block', () => {
    expect(getModelName(makeStdin({ model: undefined }))).toBe('Unknown');
  });
});

describe('HUD stdin rate limits', () => {
  it('parses stdin rate_limits into the existing RateLimits shape', () => {
    const result = getRateLimitsFromStdin(makeStdin({
      rate_limits: {
        five_hour: {
          used_percentage: 11,
          resets_at: 1776348000,
        },
        seven_day: {
          used_percentage: 2,
          resets_at: '2026-04-22T00:00:00.000Z',
        },
      },
    }));

    expect(result).toEqual({
      fiveHourPercent: 11,
      weeklyPercent: 2,
      fiveHourResetsAt: new Date(1776348000 * 1000),
      weeklyResetsAt: new Date('2026-04-22T00:00:00.000Z'),
    });
  });

  it('returns null when stdin omits rate limits', () => {
    expect(getRateLimitsFromStdin(makeStdin())).toBeNull();
  });

  it('tolerates invalid reset values without breaking the result', () => {
    const result = getRateLimitsFromStdin(makeStdin({
      rate_limits: {
        five_hour: {
          used_percentage: 140,
          resets_at: 'not-a-date',
        },
      },
    }));

    expect(result).toEqual({
      fiveHourPercent: 100,
      weeklyPercent: undefined,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
    });
  });
});

describe('HUD stdin cache path is session-scoped', () => {
  let tmpRoot: string;
  let originalCwd: string;
  const envKeys = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-hud-stdin-cache-'));
    // Make a real git repo so getWorktreeRoot() (which shells out to git
    // rev-parse) deterministically returns tmpRoot instead of leaking into
    // the surrounding workspace.
    execSync('git init --quiet', { cwd: tmpRoot });
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes to a session-scoped path when CLAUDE_SESSION_ID is set', () => {
    process.env.CLAUDE_SESSION_ID = 'test-session-aaa';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omc', 'state', 'sessions', 'test-session-aaa', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
    const loaded = JSON.parse(readFileSync(expected, 'utf-8')) as StatuslineStdin;
    expect(loaded.cwd).toBe(tmpRoot);
  });

  it('falls back to the legacy flat path when no session env var is set', () => {
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
    const sessionScoped = join(tmpRoot, '.omc', 'state', 'sessions');
    expect(existsSync(sessionScoped)).toBe(false);
  });

  it('accepts CLAUDECODE_SESSION_ID as the session id source', () => {
    process.env.CLAUDECODE_SESSION_ID = 'test-session-bbb';
    const stdin = makeStdin({ cwd: tmpRoot });

    writeStdinCache(stdin);

    const expected = join(tmpRoot, '.omc', 'state', 'sessions', 'test-session-bbb', 'hud-stdin-cache.json');
    expect(existsSync(expected)).toBe(true);
  });

  it('prevents two concurrent sessions from clobbering each other', () => {
    process.env.CLAUDE_SESSION_ID = 'session-alpha';
    const alpha = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/alpha.jsonl` });
    writeStdinCache(alpha);

    process.env.CLAUDE_SESSION_ID = 'session-beta';
    const beta = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/beta.jsonl` });
    writeStdinCache(beta);

    // Reading back from each session must return its own snapshot.
    process.env.CLAUDE_SESSION_ID = 'session-alpha';
    expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/alpha.jsonl`);

    process.env.CLAUDE_SESSION_ID = 'session-beta';
    expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/beta.jsonl`);
  });

  it('readStdinCache ignores a legacy flat file when a session id is set', () => {
    const stateDir = join(tmpRoot, '.omc', 'state');
    execSync(`mkdir -p "${stateDir}"`);
    // Simulate a stale legacy cache written by an older build.
    const legacy = makeStdin({ cwd: '/legacy/cwd' });
    writeFileSync(join(stateDir, 'hud-stdin-cache.json'), JSON.stringify(legacy));

    process.env.CLAUDE_SESSION_ID = 'fresh-session';
    // Without a session file yet, read should miss rather than return the
    // legacy (cross-session) value.
    expect(readStdinCache()).toBeNull();
  });
});
