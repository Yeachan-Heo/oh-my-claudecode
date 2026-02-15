import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('child_process', () => ({
    execSync: vi.fn(),
}));
vi.mock('../installer/index.js', async () => {
    const actual = await vi.importActual('../installer/index.js');
    return {
        ...actual,
        install: vi.fn(),
        HOOKS_DIR: '/tmp/omc-test-hooks',
        isProjectScopedPlugin: vi.fn(),
        checkNodeVersion: vi.fn(),
    };
});
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});
import { existsSync, readFileSync } from 'fs';
import { getOMCConfig, isAutoUpgradePromptEnabled, isEcomodeEnabled, isLowTierAgentsEnabled, isSilentAutoUpdateEnabled, } from '../features/auto-update.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
describe('auto-upgrade prompt config', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('defaults autoUpgradePrompt to true when config file does not exist', () => {
        mockedExistsSync.mockReturnValue(false);
        const config = getOMCConfig();
        expect(config.autoUpgradePrompt).toBeUndefined();
        expect(isAutoUpgradePromptEnabled()).toBe(true);
    });
    it('defaults autoUpgradePrompt to true when field is not set in config', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: false,
        }));
        const config = getOMCConfig();
        expect(config.autoUpgradePrompt).toBeUndefined();
        expect(isAutoUpgradePromptEnabled()).toBe(true);
    });
    it('returns true when autoUpgradePrompt is explicitly true', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: false,
            autoUpgradePrompt: true,
        }));
        expect(isAutoUpgradePromptEnabled()).toBe(true);
        expect(getOMCConfig().autoUpgradePrompt).toBe(true);
    });
    it('returns false when autoUpgradePrompt is explicitly false', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: false,
            autoUpgradePrompt: false,
        }));
        expect(isAutoUpgradePromptEnabled()).toBe(false);
        expect(getOMCConfig().autoUpgradePrompt).toBe(false);
    });
    it('autoUpgradePrompt and silentAutoUpdate are independent', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: true,
            autoUpgradePrompt: false,
        }));
        expect(isSilentAutoUpdateEnabled()).toBe(true);
        expect(isAutoUpgradePromptEnabled()).toBe(false);
    });
    it('defaults to true when config file is invalid JSON', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue('not valid json');
        expect(isAutoUpgradePromptEnabled()).toBe(true);
    });
    it('defaults ecomode and low-tier agents to enabled when unset', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: false,
        }));
        expect(isEcomodeEnabled()).toBe(true);
        expect(isLowTierAgentsEnabled()).toBe(true);
    });
    it('returns false when ecomode.enabled=false and agentTiers.lowEnabled=false', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            silentAutoUpdate: false,
            ecomode: { enabled: false },
            agentTiers: { lowEnabled: false },
        }));
        expect(isEcomodeEnabled()).toBe(false);
        expect(isLowTierAgentsEnabled()).toBe(false);
    });
});
//# sourceMappingURL=auto-upgrade-prompt.test.js.map