/**
 * Tests for HUD rate limits error indicator rendering.
 */

import { describe, it, expect } from 'vitest';
import { renderRateLimitsError } from '../../hud/elements/limits.js';

describe('renderRateLimitsError', () => {
  it('returns null for no_credentials (expected for API key users)', () => {
    expect(renderRateLimitsError('no_credentials')).toBeNull();
  });

  it('returns yellow [API err] for network errors', () => {
    const result = renderRateLimitsError('network');
    expect(result).not.toBeNull();
    expect(result).toContain('[API err]');
    // Verify yellow ANSI color code is present
    expect(result).toContain('\x1b[33m');
  });

  it('returns yellow [API auth] for auth errors', () => {
    const result = renderRateLimitsError('auth');
    expect(result).not.toBeNull();
    expect(result).toContain('[API auth]');
    // Verify yellow ANSI color code is present
    expect(result).toContain('\x1b[33m');
  });
});
