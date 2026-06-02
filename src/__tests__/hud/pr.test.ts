/**
 * Tests for the pull-request HUD element.
 *
 * Covers the pure render path and the synchronous cache-read path.
 * The background `gh` refresh (detached spawn) is intentionally not exercised
 * here — it is fire-and-forget and platform-dependent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'node:fs';
import { renderPr, readPrInfo } from '../../hud/elements/pr.js';

const mockedExists = vi.mocked(existsSync);
const mockedRead = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('renderPr', () => {
  it('returns null for null/undefined', () => {
    expect(renderPr(null)).toBeNull();
    expect(renderPr(undefined)).toBeNull();
  });

  it('renders an open PR with number and state', () => {
    const out = renderPr({ number: 42, state: 'OPEN', isDraft: false })!;
    expect(out).toContain('pr:');
    expect(out).toContain('#42');
    expect(out).toContain('OPEN');
  });

  it('renders DRAFT for draft PRs regardless of state', () => {
    const out = renderPr({ number: 7, state: 'OPEN', isDraft: true })!;
    expect(out).toContain('#7');
    expect(out).toContain('DRAFT');
    expect(out).not.toContain('OPEN');
  });
});

describe('readPrInfo', () => {
  it('returns null when the cache file is missing', () => {
    mockedExists.mockReturnValue(false);
    expect(readPrInfo('/repo', 'main')).toBeNull();
  });

  it('returns null for an empty cache file (the no-PR marker)', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('' as any);
    expect(readPrInfo('/repo', 'main')).toBeNull();
  });

  it('parses a cached PR json payload', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue(
      JSON.stringify({ number: 9, state: 'OPEN', isDraft: false, title: 't' }) as any,
    );
    expect(readPrInfo('/repo', 'main')).toMatchObject({
      number: 9,
      state: 'OPEN',
      isDraft: false,
    });
  });

  it('returns null when the cached json has no PR number', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue(JSON.stringify({ state: 'OPEN' }) as any);
    expect(readPrInfo('/repo', 'main')).toBeNull();
  });

  it('returns null on unparseable json', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('not json{' as any);
    expect(readPrInfo('/repo', 'main')).toBeNull();
  });
});
