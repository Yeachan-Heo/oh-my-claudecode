/**
 * Unit tests for resolvePluginDirArg helper.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { resolvePluginDirArg } from '../plugin-dir.js';

describe('resolvePluginDirArg', () => {
  it('returns an absolute path unchanged', () => {
    expect(resolvePluginDirArg('/tmp/foo')).toBe(resolve('/tmp/foo'));
  });

  it('resolves a relative path to absolute', () => {
    expect(resolvePluginDirArg('./rel/path')).toBe(resolve('./rel/path'));
  });

  it('resolves a bare name to absolute (relative to cwd)', () => {
    expect(resolvePluginDirArg('mydir')).toBe(resolve('mydir'));
  });

  it('throws for an empty string', () => {
    expect(() => resolvePluginDirArg('')).toThrow('--plugin-dir requires a non-empty path argument');
  });

  it('throws for a whitespace-only string', () => {
    expect(() => resolvePluginDirArg('   ')).toThrow('--plugin-dir requires a non-empty path argument');
  });

  // Tilde limitation: path.resolve() does NOT expand `~`.
  // `~/foo` is treated as a literal path component relative to cwd, NOT $HOME/foo.
  // Use $HOME or an explicit absolute path instead of `~`.
  it('does NOT expand ~ (tilde is treated as a literal path component)', () => {
    const result = resolvePluginDirArg('~/foo');
    // path.resolve('~/foo') produces <cwd>/~/foo, NOT /home/<user>/foo
    expect(result).toBe(resolve('~/foo'));
    expect(result).not.toBe(resolve(process.env.HOME ?? '/root', 'foo'));
  });
});
