import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
vi.mock('child_process', () => ({
    spawnSync: vi.fn()
}));
const mockSpawnSync = vi.mocked(spawnSync);
const DEFAULT_WORKSPACE_FOLDER = '/workspaces/app';
function dockerInspectResult(payload) {
    return JSON.stringify([payload]);
}
function writeDevContainerConfig(workspaceRoot, relativePath, config = { workspaceFolder: DEFAULT_WORKSPACE_FOLDER }) {
    const fullPath = join(workspaceRoot, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(config));
    return fullPath;
}
describe('devcontainer LSP helpers', () => {
    let workspaceRoot;
    beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), 'omc-devcontainer-'));
        delete process.env.OMC_LSP_CONTAINER_ID;
        vi.resetModules();
    });
    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true });
        vi.restoreAllMocks();
        delete process.env.OMC_LSP_CONTAINER_ID;
    });
    it('prefers explicit container override and translates host/container paths and URIs', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer/devcontainer.json');
        process.env.OMC_LSP_CONTAINER_ID = 'forced-container';
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'forced-container',
                        State: { Running: true },
                        Config: { Labels: {} },
                        Mounts: [{ Source: workspaceRoot, Destination: DEFAULT_WORKSPACE_FOLDER }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(workspaceRoot);
        expect(context).toEqual({
            containerId: 'forced-container',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: DEFAULT_WORKSPACE_FOLDER,
            configFilePath
        });
        const hostFile = join(workspaceRoot, 'src', 'index.ts');
        expect(mod.hostPathToContainerPath(hostFile, context)).toBe('/workspaces/app/src/index.ts');
        expect(mod.containerPathToHostPath('/workspaces/app/src/index.ts', context)).toBe(hostFile);
        expect(mod.hostUriToContainerUri(pathToFileURL(hostFile).href, context)).toBe('file:///workspaces/app/src/index.ts');
        expect(mod.containerUriToHostUri('file:///workspaces/app/src/index.ts', context)).toBe(pathToFileURL(hostFile).href);
    });
    it('matches running devcontainer by labels and nested mount', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer/devcontainer.json');
        const mountedParent = join(workspaceRoot, '..');
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'abc123\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'abc123',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': configFilePath
                            }
                        },
                        Mounts: [{ Source: mountedParent, Destination: '/workspaces' }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(workspaceRoot);
        expect(context?.containerId).toBe('abc123');
        expect(context?.containerWorkspaceRoot).toBe(`/workspaces/${workspaceRoot.split('/').pop()}`);
        expect(context?.configFilePath).toBe(configFilePath);
    });
    it('finds ancestor devcontainer config for nested workspace roots', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer/devcontainer.json');
        const nestedWorkspaceRoot = join(workspaceRoot, 'packages', 'app');
        mkdirSync(nestedWorkspaceRoot, { recursive: true });
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'nested123\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'nested123',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': configFilePath
                            }
                        },
                        Mounts: [{ Source: workspaceRoot, Destination: DEFAULT_WORKSPACE_FOLDER }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(nestedWorkspaceRoot);
        expect(context).toEqual({
            containerId: 'nested123',
            hostWorkspaceRoot: nestedWorkspaceRoot,
            containerWorkspaceRoot: '/workspaces/app/packages/app',
            configFilePath
        });
    });
    it('supports .devcontainer.json at the workspace root', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer.json');
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'dotfile123\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'dotfile123',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': configFilePath
                            }
                        },
                        Mounts: [{ Source: workspaceRoot, Destination: DEFAULT_WORKSPACE_FOLDER }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(workspaceRoot);
        expect(context).toEqual({
            containerId: 'dotfile123',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: DEFAULT_WORKSPACE_FOLDER,
            configFilePath
        });
    });
    it('supports nested .devcontainer/<name>/devcontainer.json layouts', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer/custom/devcontainer.json');
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'nested-layout\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'nested-layout',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': configFilePath
                            }
                        },
                        Mounts: [{ Source: workspaceRoot, Destination: DEFAULT_WORKSPACE_FOLDER }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(workspaceRoot);
        expect(context).toEqual({
            containerId: 'nested-layout',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: DEFAULT_WORKSPACE_FOLDER,
            configFilePath
        });
    });
    it('finds ancestor .devcontainer.json for nested workspace roots', async () => {
        const configFilePath = writeDevContainerConfig(workspaceRoot, '.devcontainer.json');
        const nestedWorkspaceRoot = join(workspaceRoot, 'packages', 'app');
        mkdirSync(nestedWorkspaceRoot, { recursive: true });
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'nested-dotfile\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'nested-dotfile',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': configFilePath
                            }
                        },
                        Mounts: [{ Source: workspaceRoot, Destination: DEFAULT_WORKSPACE_FOLDER }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        const context = mod.resolveDevContainerContext(nestedWorkspaceRoot);
        expect(context).toEqual({
            containerId: 'nested-dotfile',
            hostWorkspaceRoot: nestedWorkspaceRoot,
            containerWorkspaceRoot: '/workspaces/app/packages/app',
            configFilePath
        });
    });
    it('honors config discovery precedence for conflicting layouts in the same ancestor', async () => {
        const primaryConfigPath = writeDevContainerConfig(workspaceRoot, '.devcontainer/devcontainer.json', { workspaceFolder: '/workspaces/primary' });
        const dotfileConfigPath = writeDevContainerConfig(workspaceRoot, '.devcontainer.json', { workspaceFolder: '/workspaces/dotfile' });
        const alphaNestedConfigPath = writeDevContainerConfig(workspaceRoot, '.devcontainer/alpha/devcontainer.json', { workspaceFolder: '/workspaces/alpha' });
        writeDevContainerConfig(workspaceRoot, '.devcontainer/beta/devcontainer.json', { workspaceFolder: '/workspaces/beta' });
        let expectedConfigPath = primaryConfigPath;
        let expectedWorkspaceFolder = '/workspaces/primary';
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'precedence123\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'precedence123',
                        State: { Running: true },
                        Config: {
                            Labels: {
                                'devcontainer.local_folder': workspaceRoot,
                                'devcontainer.config_file': expectedConfigPath
                            }
                        },
                        Mounts: [{ Source: workspaceRoot, Destination: expectedWorkspaceFolder }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        let context = mod.resolveDevContainerContext(workspaceRoot);
        expect(context?.configFilePath).toBe(primaryConfigPath);
        expect(context?.containerWorkspaceRoot).toBe('/workspaces/primary');
        rmSync(primaryConfigPath, { force: true });
        expectedConfigPath = dotfileConfigPath;
        expectedWorkspaceFolder = '/workspaces/dotfile';
        vi.resetModules();
        const dotfileMod = await import('../devcontainer.js');
        context = dotfileMod.resolveDevContainerContext(workspaceRoot);
        expect(context?.configFilePath).toBe(dotfileConfigPath);
        expect(context?.containerWorkspaceRoot).toBe('/workspaces/dotfile');
        rmSync(dotfileConfigPath, { force: true });
        expectedConfigPath = alphaNestedConfigPath;
        expectedWorkspaceFolder = '/workspaces/alpha';
        vi.resetModules();
        const nestedMod = await import('../devcontainer.js');
        context = nestedMod.resolveDevContainerContext(workspaceRoot);
        expect(context?.configFilePath).toBe(alphaNestedConfigPath);
        expect(context?.containerWorkspaceRoot).toBe('/workspaces/alpha');
    });
    it('returns null when no matching running devcontainer exists', async () => {
        mockSpawnSync.mockImplementation((command, args) => {
            expect(command).toBe('docker');
            if (args?.[0] === 'ps') {
                return { status: 0, stdout: 'abc123\n' };
            }
            if (args?.[0] === 'inspect') {
                return {
                    status: 0,
                    stdout: dockerInspectResult({
                        Id: 'abc123',
                        State: { Running: true },
                        Config: { Labels: {} },
                        Mounts: [{ Source: '/tmp/other', Destination: '/workspaces/other' }]
                    })
                };
            }
            throw new Error(`Unexpected docker args: ${args}`);
        });
        const mod = await import('../devcontainer.js');
        expect(mod.resolveDevContainerContext(workspaceRoot)).toBeNull();
    });
});
//# sourceMappingURL=devcontainer.test.js.map