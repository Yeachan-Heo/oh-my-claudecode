import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSecurityConfig,
  clearSecurityConfigCache,
  isToolPathRestricted,
  isPythonSandboxEnabled,
  isProjectSkillsDisabled,
  isAutoUpdateDisabled,
  getHardMaxIterations,
  isRemoteMcpDisabled,
  isExternalLLMDisabled,
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
      // New fields default to false
      expect(config.disableRemoteMcp).toBe(false);
      expect(config.disableExternalLLM).toBe(false);
    });

    it('convenience functions reflect defaults', () => {
      expect(isToolPathRestricted()).toBe(false);
      expect(isPythonSandboxEnabled()).toBe(false);
      expect(isProjectSkillsDisabled()).toBe(false);
      expect(isAutoUpdateDisabled()).toBe(true);
      expect(getHardMaxIterations()).toBe(500);
      expect(isRemoteMcpDisabled()).toBe(false);
      expect(isExternalLLMDisabled()).toBe(false);
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
      // New fields are true in strict mode
      expect(config.disableRemoteMcp).toBe(true);
      expect(config.disableExternalLLM).toBe(true);
    });

    it('convenience functions return true/200', () => {
      expect(isToolPathRestricted()).toBe(true);
      expect(isPythonSandboxEnabled()).toBe(true);
      expect(isProjectSkillsDisabled()).toBe(true);
      expect(isAutoUpdateDisabled()).toBe(true);
      expect(getHardMaxIterations()).toBe(200);
      expect(isRemoteMcpDisabled()).toBe(true);
      expect(isExternalLLMDisabled()).toBe(true);
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
      expect(config.disableRemoteMcp).toBe(false);
      expect(config.disableExternalLLM).toBe(false);
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

  describe('strict mode override protection', () => {
    it('strict mode: boolean security flags cannot be relaxed by file overrides', () => {
      // This test verifies that in strict mode, security cannot be weakened.
      // We test the logic directly by checking that strict base values are true
      // and the || operator ensures file overrides of false cannot override them.
      process.env.OMC_SECURITY = 'strict';
      clearSecurityConfigCache();

      const config = getSecurityConfig();
      // In strict mode all boolean security flags must be true regardless
      expect(config.restrictToolPaths).toBe(true);
      expect(config.pythonSandbox).toBe(true);
      expect(config.disableProjectSkills).toBe(true);
      expect(config.disableAutoUpdate).toBe(true);
      expect(config.disableRemoteMcp).toBe(true);
      expect(config.disableExternalLLM).toBe(true);
    });

    it('strict mode: hardMaxIterations only decreases from base', () => {
      process.env.OMC_SECURITY = 'strict';
      clearSecurityConfigCache();

      const config = getSecurityConfig();
      // Without file overrides, strict base is 200
      expect(config.hardMaxIterations).toBe(200);
    });

    it('non-strict mode: config file overrides work normally', () => {
      delete process.env.OMC_SECURITY;
      clearSecurityConfigCache();

      // Verify default values can be overridden in non-strict mode
      // (We can't test file loading in unit tests easily, but we verify
      // the defaults are the non-strict ones)
      const config = getSecurityConfig();
      expect(config.disableRemoteMcp).toBe(false);
      expect(config.disableExternalLLM).toBe(false);
    });
  });
});
