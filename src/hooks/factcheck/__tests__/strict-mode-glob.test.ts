import { describe, it, expect } from 'vitest';
import { shouldUseStrictMode } from '../config.js';

describe('shouldUseStrictMode glob matching', () => {
  it('supports * and ? wildcards', () => {
    expect(shouldUseStrictMode('prod-api', ['prod-*'])).toBe(true);
    expect(shouldUseStrictMode('app1', ['app?'])).toBe(true);
    expect(shouldUseStrictMode('staging-api', ['prod-*'])).toBe(false);
  });

  it('matches regex metacharacters literally instead of throwing', () => {
    expect(() => shouldUseStrictMode('app', ['app(1'])).not.toThrow();
    expect(shouldUseStrictMode('app(1)', ['app(1)'])).toBe(true);
    expect(shouldUseStrictMode('c++', ['c++'])).toBe(true);
    expect(shouldUseStrictMode('a[1]', ['a[1]'])).toBe(true);
  });

  it('does not treat . as any character', () => {
    expect(shouldUseStrictMode('my.app', ['my.app'])).toBe(true);
    expect(shouldUseStrictMode('myXapp', ['my.app'])).toBe(false);
  });
});
