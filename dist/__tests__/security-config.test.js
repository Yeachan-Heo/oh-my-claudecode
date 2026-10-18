import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => '{}'),
    };
});
import { existsSync, readFileSync } from 'fs';
import { getSecurityConfig, clearSecurityConfigCache, isToolPathRestricted, isPythonSandboxEnabled, isProjectSkillsDisabled, isAutoUpdateDisabled, getHardMaxIterations, isRemoteMcpDisabled, isExternalLLMDisabled, } from '../lib/security-config.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
describe('security-config', () => {
    const originalSecurity = process.env.OMC_SECURITY;
    afterEach(() => {
        if (originalSecurity === undefined) {
            delete process.env.OMC_SECURITY;
        }
        else {
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
            // Auto-update controlled by OMCConfig; security-config only overrides in strict
            expect(config.disableAutoUpdate).toBe(false);
            expect(config.hardMaxIterations).toBe(500);
            // New fields default to false
            expect(config.disableRemoteMcp).toBe(false);
            expect(config.disableExternalLLM).toBe(false);
        });
        it('convenience functions reflect defaults', () => {
            expect(isToolPathRestricted()).toBe(false);
            expect(isPythonSandboxEnabled()).toBe(false);
            expect(isProjectSkillsDisabled()).toBe(false);
            expect(isAutoUpdateDisabled()).toBe(false);
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
        it('strict mode: config file with false overrides cannot relax security', () => {
            process.env.OMC_SECURITY = 'strict';
            // Simulate a malicious config file that tries to disable all security
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                security: {
                    restrictToolPaths: false,
                    pythonSandbox: false,
                    disableProjectSkills: false,
                    disableAutoUpdate: false,
                    disableRemoteMcp: false,
                    disableExternalLLM: false,
                    hardMaxIterations: 9999,
                },
            }));
            clearSecurityConfigCache();
            const config = getSecurityConfig();
            // All boolean flags must remain true despite file overrides
            expect(config.restrictToolPaths).toBe(true);
            expect(config.pythonSandbox).toBe(true);
            expect(config.disableProjectSkills).toBe(true);
            expect(config.disableAutoUpdate).toBe(true);
            expect(config.disableRemoteMcp).toBe(true);
            expect(config.disableExternalLLM).toBe(true);
            // hardMaxIterations: Math.min(200, 9999) = 200
            expect(config.hardMaxIterations).toBe(200);
        });
        it('strict mode: config file can tighten hardMaxIterations below 200', () => {
            process.env.OMC_SECURITY = 'strict';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                security: { hardMaxIterations: 50 },
            }));
            clearSecurityConfigCache();
            const config = getSecurityConfig();
            // Math.min(200, 50) = 50 — tightening is allowed
            expect(config.hardMaxIterations).toBe(50);
        });
        it('non-strict mode: config file overrides work normally', () => {
            delete process.env.OMC_SECURITY;
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                security: {
                    restrictToolPaths: true,
                    disableRemoteMcp: true,
                    hardMaxIterations: 100,
                },
            }));
            clearSecurityConfigCache();
            const config = getSecurityConfig();
            // File overrides are applied in non-strict mode
            expect(config.restrictToolPaths).toBe(true);
            expect(config.disableRemoteMcp).toBe(true);
            expect(config.hardMaxIterations).toBe(100);
            // Unset fields keep defaults
            expect(config.pythonSandbox).toBe(false);
            expect(config.disableExternalLLM).toBe(false);
        });
    });
});
//# sourceMappingURL=security-config.test.js.map