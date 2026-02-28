/**
 * Tests for shell PATH resolution (issue #1128)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to re-import after reset for the IIFE-cached value
let shellPathModule: typeof import('../team/shell-path.js');

beforeEach(async () => {
  vi.resetModules();
  shellPathModule = await import('../team/shell-path.js');
  shellPathModule._resetShellPathCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveShellPath', () => {
  it('returns a non-empty string', () => {
    const path = shellPathModule.resolveShellPath();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  it('caches the result on subsequent calls', () => {
    const first = shellPathModule.resolveShellPath();
    const second = shellPathModule.resolveShellPath();
    expect(first).toBe(second);
  });

  it('_resetShellPathCache allows re-resolution', () => {
    const first = shellPathModule.resolveShellPath();
    shellPathModule._resetShellPathCache();
    const second = shellPathModule.resolveShellPath();
    // Both should be valid paths (may be same value but re-resolved)
    expect(typeof second).toBe('string');
    expect(second.length).toBeGreaterThan(0);
  });

  it('falls back to process.env.PATH on Windows', async () => {
    // Save and mock platform
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    vi.resetModules();
    const winModule = await import('../team/shell-path.js');
    winModule._resetShellPathCache();

    const path = winModule.resolveShellPath();
    expect(path).toBe(process.env.PATH || '');

    // Restore
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

describe('resolvedEnv', () => {
  it('returns an object with PATH set', () => {
    const env = shellPathModule.resolvedEnv();
    // Should have PATH (or Path on Windows)
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
    expect(pathKey).toBeTruthy();
    expect(env[pathKey!]).toBeTruthy();
  });

  it('merges extra vars into environment', () => {
    const env = shellPathModule.resolvedEnv({ MY_CUSTOM_VAR: 'hello' });
    expect(env.MY_CUSTOM_VAR).toBe('hello');
  });

  it('extra vars override existing env', () => {
    const env = shellPathModule.resolvedEnv({ HOME: '/custom/home' });
    expect(env.HOME).toBe('/custom/home');
  });

  it('preserves existing process.env keys', () => {
    const env = shellPathModule.resolvedEnv();
    // Should still have HOME or USERPROFILE
    const hasHome = env.HOME || env.USERPROFILE;
    expect(hasHome).toBeTruthy();
  });
});
