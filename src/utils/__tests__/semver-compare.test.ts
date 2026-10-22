import { describe, it, expect } from 'vitest';
import { compareVersions } from '../semver-compare.js';

describe('compareVersions', () => {
  describe('numeric core', () => {
    it('orders by major, then minor, then patch', () => {
      expect(compareVersions('4.15.7', '5.0.0')).toBeLessThan(0);
      expect(compareVersions('5.0.0', '4.15.7')).toBeGreaterThan(0);
      expect(compareVersions('5.1.0', '5.0.9')).toBeGreaterThan(0);
      expect(compareVersions('5.0.1', '5.0.2')).toBeLessThan(0);
      expect(compareVersions('5.0.0', '5.0.0')).toBe(0);
    });

    it('compares components numerically, not lexically', () => {
      expect(compareVersions('5.10.0', '5.9.0')).toBeGreaterThan(0);
      expect(compareVersions('5.0.10', '5.0.9')).toBeGreaterThan(0);
    });

    it('ignores a leading v', () => {
      expect(compareVersions('v5.0.0', '5.0.0')).toBe(0);
      expect(compareVersions('v5.1.0', '5.0.0')).toBeGreaterThan(0);
    });

    it('treats a missing component as zero', () => {
      expect(compareVersions('1.2', '1.2.0')).toBe(0);
      expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0);
    });

    it('compares large core version numbers without losing precision', () => {
      // Number() collapses these two to the same double, so comparing through it
      // made distinct core versions equal and could let an older target pass the
      // installer's `compareVersions(...) < 0` downgrade guard.
      expect(Number('10000000000000000000')).toBe(Number('10000000000000000001'));
      expect(compareVersions('1.10000000000000000000.0', '1.10000000000000000001.0')).toBeLessThan(0);
      expect(compareVersions('1.10000000000000000001.0', '1.10000000000000000000.0')).toBeGreaterThan(0);
    });

    it('handles precision loss in major version', () => {
      expect(compareVersions('10000000000000000000.0.0', '10000000000000000001.0.0')).toBeLessThan(0);
    });

    it('handles precision loss in patch version', () => {
      expect(compareVersions('1.0.10000000000000000000', '1.0.10000000000000000001')).toBeLessThan(0);
    });
  });

  describe('prerelease precedence', () => {
    it('ranks a prerelease below its own release', () => {
      // The previous parseInt-based comparator split '5.7.7-beta.1' into four
      // segments and read the trailing '.1' as a fourth version component, so
      // the prerelease sorted ABOVE 5.7.7 and no update was ever offered.
      expect(compareVersions('5.7.7-beta.1', '5.7.7')).toBeLessThan(0);
      expect(compareVersions('5.7.7', '5.7.7-beta.1')).toBeGreaterThan(0);
    });

    it('ranks a prerelease below the release for any identifier shape', () => {
      expect(compareVersions('1.2.3-alpha', '1.2.3')).toBeLessThan(0);
      expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBeLessThan(0);
      expect(compareVersions('1.2.3-0', '1.2.3')).toBeLessThan(0);
    });

    it('still ranks a prerelease above a lower release', () => {
      expect(compareVersions('5.7.7-beta.1', '5.7.6')).toBeGreaterThan(0);
      expect(compareVersions('5.7.7-beta.1', '5.7.8')).toBeLessThan(0);
    });

    it('compares numeric prerelease identifiers numerically', () => {
      expect(compareVersions('1.2.3-rc.2', '1.2.3-rc.10')).toBeLessThan(0);
      expect(compareVersions('1.2.3-rc.1', '1.2.3-rc.2')).toBeLessThan(0);
    });

    it('ranks a numeric identifier below an alphanumeric one', () => {
      expect(compareVersions('1.2.3-1', '1.2.3-alpha')).toBeLessThan(0);
    });

    it('compares alphanumeric identifiers lexically', () => {
      expect(compareVersions('1.2.3-alpha', '1.2.3-beta')).toBeLessThan(0);
      expect(compareVersions('1.2.3-alpha.1', '1.2.3-beta')).toBeLessThan(0);
    });

    it('ranks a shorter identifier set below a longer one that shares its prefix', () => {
      expect(compareVersions('1.2.3-alpha', '1.2.3-alpha.1')).toBeLessThan(0);
      expect(compareVersions('1.2.3-alpha.1', '1.2.3-alpha')).toBeGreaterThan(0);
    });

    it('compares long numeric identifiers without losing precision', () => {
      // Number() collapses these two to the same double, so comparing through it
      // made distinct prereleases equal and let an older target pass the
      // installer's `compareVersions(...) < 0` downgrade guard.
      expect(Number('10000000000000000000')).toBe(Number('10000000000000000001'));
      expect(compareVersions('1.2.3-rc.10000000000000000000', '1.2.3-rc.10000000000000000001')).toBeLessThan(0);
      expect(compareVersions('1.2.3-rc.10000000000000000001', '1.2.3-rc.10000000000000000000')).toBeGreaterThan(0);
    });

    it('orders numeric identifiers by magnitude, not lexically', () => {
      expect(compareVersions('1.2.3-rc.9', '1.2.3-rc.10')).toBeLessThan(0);
      expect(compareVersions('1.2.3-rc.100', '1.2.3-rc.99')).toBeGreaterThan(0);
    });

    it('ignores leading zeros in a numeric identifier', () => {
      expect(compareVersions('1.2.3-rc.007', '1.2.3-rc.7')).toBe(0);
      expect(compareVersions('1.2.3-rc.007', '1.2.3-rc.8')).toBeLessThan(0);
    });

    it('treats identical prereleases as equal', () => {
      expect(compareVersions('1.2.3-rc.1', '1.2.3-rc.1')).toBe(0);
    });
  });

  describe('build metadata', () => {
    it('ignores build metadata', () => {
      expect(compareVersions('1.2.3+build.9', '1.2.3')).toBe(0);
      expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0);
    });

    it('ignores build metadata attached to a prerelease', () => {
      expect(compareVersions('1.2.3-rc.1+build', '1.2.3-rc.1')).toBe(0);
      expect(compareVersions('1.2.3-rc.1+build', '1.2.3')).toBeLessThan(0);
    });
  });

  describe('non-semver suffixes (issue #3867)', () => {
    it('treats a display-only suffix as equal to the bare version', () => {
      // '4.15.7L' is a leaked HUD display suffix, not a prerelease: no hyphen,
      // so it must not be read as one.
      expect(compareVersions('4.15.7L', '4.15.7')).toBe(0);
    });

    it('still ranks a display-only suffix below a newer release', () => {
      expect(compareVersions('4.15.7L', '5.0.0')).toBeLessThan(0);
    });
  });

  describe('as a sort comparator', () => {
    it('sorts a release channel into semver order', () => {
      const sorted = [
        '5.7.7',
        '5.7.7-beta.1',
        '5.7.6',
        '5.8.0',
        '5.7.7-rc.1',
      ].sort(compareVersions);
      expect(sorted).toEqual([
        '5.7.6',
        '5.7.7-beta.1',
        '5.7.7-rc.1',
        '5.7.7',
        '5.8.0',
      ]);
    });
  });
});
