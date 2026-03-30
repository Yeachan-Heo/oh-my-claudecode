import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSecurityConfig,
  clearSecurityConfigCache,
  isToolPathRestricted,
  isPythonSandboxEnabled,
  isProjectSkillsDisabled,
  isAutoUpdateDisabled,
  getHardMaxIterations,
} from '../lib/security-config.js';

describe('security-config', () => {
  const originalSecurity = process.env.OMC_SECURITY;

  afterEach(() => {
    if (originalSecurity === undefined) {
      delete process.env.OMC_SECURITY;
    } else {
      process.env.OMC_SECURITY = originalSecurity;
    }
    clearSecurityConfigCache();
  });

  describe('defaults (no env var)', () => {
    beforeEach(() => {
      delete process.env.OMC_SECURITY;
      clearSecurityConfigCache();
    });

    it('secure defaults for safe features, opt-in for others', () => {
      const config = getSecurityConfig();
      expect(config.restrictToolPaths).toBe(false);
      expect(config.pythonSandbox).toBe(false);
      expect(config.disableProjectSkills).toBe(false);
      // Secure-by-default: auto-update off, hard max set
      expect(config.disableAutoUpdate).toBe(true);
      expect(config.hardMaxIterations).toBe(500);
    });

    it('convenience functions reflect defaults', () => {
      expect(isToolPathRestricted()).toBe(false);
      expect(isPythonSandboxEnabled()).toBe(false);
      expect(isProjectSkillsDisabled()).toBe(false);
      expect(isAutoUpdateDisabled()).toBe(true);
      expect(getHardMaxIterations()).toBe(500);
    });
  });

  describe('OMC_SECURITY=strict', () => {
    beforeEach(() => {
      process.env.OMC_SECURITY = 'strict';
      clearSecurityConfigCache();
    });

    it('all features enabled', () => {
      const config = getSecurityConfig();
      expect(config.restrictToolPaths).toBe(true);
      expect(config.pythonSandbox).toBe(true);
      expect(config.disableProjectSkills).toBe(true);
      expect(config.disableAutoUpdate).toBe(true);
      expect(config.hardMaxIterations).toBe(200);
    });

    it('convenience functions return true/200', () => {
      expect(isToolPathRestricted()).toBe(true);
      expect(isPythonSandboxEnabled()).toBe(true);
      expect(isProjectSkillsDisabled()).toBe(true);
      expect(isAutoUpdateDisabled()).toBe(true);
      expect(getHardMaxIterations()).toBe(200);
    });
  });

  describe('OMC_SECURITY with non-strict value', () => {
    beforeEach(() => {
      process.env.OMC_SECURITY = 'relaxed';
      clearSecurityConfigCache();
    });

    it('uses defaults', () => {
      const config = getSecurityConfig();
      expect(config.restrictToolPaths).toBe(false);
      expect(config.pythonSandbox).toBe(false);
    });
  });

  describe('caching', () => {
    it('returns same object on repeated calls', () => {
      delete process.env.OMC_SECURITY;
      clearSecurityConfigCache();
      const first = getSecurityConfig();
      const second = getSecurityConfig();
      expect(first).toBe(second);
    });

    it('clearSecurityConfigCache forces re-read', () => {
      delete process.env.OMC_SECURITY;
      clearSecurityConfigCache();
      const first = getSecurityConfig();

      process.env.OMC_SECURITY = 'strict';
      clearSecurityConfigCache();
      const second = getSecurityConfig();

      expect(first.restrictToolPaths).toBe(false);
      expect(second.restrictToolPaths).toBe(true);
    });
  });
});
