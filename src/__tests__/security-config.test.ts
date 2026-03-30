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

    it('all features disabled by default', () => {
      const config = getSecurityConfig();
      expect(config.restrictToolPaths).toBe(false);
      expect(config.pythonSandbox).toBe(false);
      expect(config.disableProjectSkills).toBe(false);
      expect(config.disableAutoUpdate).toBe(false);
      expect(config.hardMaxIterations).toBe(0);
    });

    it('convenience functions return false/0', () => {
      expect(isToolPathRestricted()).toBe(false);
      expect(isPythonSandboxEnabled()).toBe(false);
      expect(isProjectSkillsDisabled()).toBe(false);
      expect(isAutoUpdateDisabled()).toBe(false);
      expect(getHardMaxIterations()).toBe(0);
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
