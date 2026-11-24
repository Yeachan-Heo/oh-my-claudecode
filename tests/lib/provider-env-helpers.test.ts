/**
 * Unit tests for scripts/lib/provider-env-helpers.mjs
 * Tests the isTruthyProviderFlag() helper used by session-start.mjs and pre-tool-enforcer.mjs
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HELPER_PATH = join(PROJECT_ROOT, 'scripts', 'lib', 'provider-env-helpers.mjs');

describe('scripts/lib/provider-env-helpers.mjs: isTruthyProviderFlag()', () => {
  describe('truthy cases', () => {
    it('returns true for "1"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('1')).toBe(true);
    });

    it('returns true for "true" (lowercase)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('true')).toBe(true);
    });

    it('returns true for "TRUE" (uppercase)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('TRUE')).toBe(true);
    });

    it('returns true for "True" (mixed case)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('True')).toBe(true);
    });

    it('returns true for " true " (padded with spaces)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag(' true ')).toBe(true);
    });

    it('returns true for "\\ttrue\\n" (padded with tabs and newlines)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('\ttrue\n')).toBe(true);
    });

    it('returns true for " 1 " (padded with spaces)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag(' 1 ')).toBe(true);
    });
  });

  describe('falsy cases', () => {
    it('returns false for "0"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('0')).toBe(false);
    });

    it('returns false for "false"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('false')).toBe(false);
    });

    it('returns false for "FALSE"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('FALSE')).toBe(false);
    });

    it('returns false for "" (empty string)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('')).toBe(false);
    });

    it('returns false for " " (spaces)', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag(' ')).toBe(false);
    });

    it('returns false for null', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag(null)).toBe(false);
    });

    it('returns false for undefined', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag(undefined)).toBe(false);
    });

    it('returns false for "2"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('2')).toBe(false);
    });

    it('returns false for "yes"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('yes')).toBe(false);
    });

    it('returns false for "on"', async () => {
      const { isTruthyProviderFlag } = await import(pathToFileURL(HELPER_PATH).href);
      expect(isTruthyProviderFlag('on')).toBe(false);
    });
  });
});
