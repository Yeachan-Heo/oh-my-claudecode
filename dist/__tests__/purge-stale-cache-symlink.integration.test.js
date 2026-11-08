/** Real-filesystem regressions for cache targets whose payload is symlinked. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, lstatSync, readdirSync, readlinkSync, utimesSync, } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
let configDir;
vi.mock('../utils/config-dir.js', () => ({
    getClaudeConfigDir: vi.fn(() => configDir),
}));
const { purgeStalePluginCacheVersions } = await import('../utils/paths.js');
const PLUGIN = 'omc/oh-my-claudecode';
const STALE = '4.15.6';
const ACTIVE = '4.15.10';
const LEGACY_SESSION_START_COMMAND = 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/session-start.mjs';
const LEGACY = ['4.13.5', '4.14.0'];
let pluginDir;
function makeStale(path) {
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
    utimesSync(path, old, old);
}
function writeVersion(version) {
    const directory = join(pluginDir, version);
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    writeFileSync(join(directory, 'scripts', 'run.cjs'), `// ${version}\n`);
    mkdirSync(join(directory, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'hooks', 'hooks.json'), '{}\n');
    return directory;
}
function writeSessionStartManifest(versionPath, command = 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-start.mjs') {
    writeFileSync(join(versionPath, 'hooks', 'hooks.json'), JSON.stringify({
        description: 'OMC session-start hook',
        hooks: {
            SessionStart: [
                {
                    matcher: '*',
                    hooks: [
                        {
                            type: 'command',
                            command,
                            timeout: 5,
                        },
                    ],
                },
            ],
        },
    }));
}
function hookResolves(version) {
    const root = join(pluginDir, version);
    return (existsSync(join(root, 'hooks', 'hooks.json')) &&
        existsSync(join(root, 'scripts', 'run.cjs')) &&
        existsSync(join(root, 'scripts')));
}
function installPath(path = join(pluginDir, ACTIVE)) {
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2,
        plugins: {
            'oh-my-claudecode@omc': [{ installPath: path, version: ACTIVE }],
        },
    }));
}
function stubOwnerLiveness() {
    vi.spyOn(process, 'kill').mockImplementation(((pid) => {
        if (pid === process.pid)
            return true;
        const error = new Error('ESRCH');
        error.code = 'ESRCH';
        throw error;
    }));
}
beforeEach(() => {
    stubOwnerLiveness();
    configDir = mkdtempSync(join(tmpdir(), 'omc-cache-link-'));
    pluginDir = join(configDir, 'plugins', 'cache', PLUGIN);
    mkdirSync(pluginDir, { recursive: true });
    writeVersion(ACTIVE);
    installPath();
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(configDir, { recursive: true, force: true });
});
describe('purgeStalePluginCacheVersions symlink payload validation', () => {
    it('preserves OMC payload when a required entry point links into the stale tree', () => {
        const stale = writeVersion(STALE);
        const staleScript = join(stale, 'payload', 'run.cjs');
        const active = join(pluginDir, ACTIVE);
        const activeScript = join(active, 'scripts', 'run.cjs');
        mkdirSync(join(stale, 'payload'), { recursive: true });
        writeFileSync(staleScript, '// only stale entrypoint');
        mkdirSync(join(active, 'hooks'), { recursive: true });
        writeFileSync(join(active, 'hooks', 'hooks.json'), '{}\n');
        mkdirSync(join(active, 'scripts'), { recursive: true });
        mkdirSync(join(active, 'payload'), { recursive: true });
        writeFileSync(join(active, 'payload', 'run.cjs'), '// active counterpart');
        rmSync(activeScript, { force: true });
        symlinkSync(staleScript, activeScript, 'file');
        makeStale(stale);
        installPath(active);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readlinkSync(activeScript)).toBe(staleScript);
        expect(existsSync(activeScript)).toBe(true);
        expect(readdirSync(pluginDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves OMC payload when a non-entrypoint hook script links into the stale tree', () => {
        const stale = writeVersion(STALE);
        const staleScript = join(stale, 'scripts', 'session-start.mjs');
        const active = join(pluginDir, ACTIVE);
        const activeScript = join(active, 'scripts', 'session-start.mjs');
        writeFileSync(staleScript, '// only stale hook script');
        writeSessionStartManifest(active);
        symlinkSync(staleScript, activeScript, 'file');
        makeStale(stale);
        installPath(active);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readlinkSync(activeScript)).toBe(staleScript);
        expect(existsSync(activeScript)).toBe(true);
        expect(readdirSync(pluginDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves OMC payload when a manifest-referenced hook script is missing', () => {
        const stale = writeVersion(STALE);
        const staleScript = join(stale, 'scripts', 'session-start.mjs');
        const active = join(pluginDir, ACTIVE);
        writeFileSync(join(stale, 'scripts', 'find-node.sh'), '#!/bin/sh\n');
        writeFileSync(join(active, 'scripts', 'find-node.sh'), '#!/bin/sh\n');
        writeFileSync(staleScript, '// complete stale hook script');
        writeSessionStartManifest(stale, LEGACY_SESSION_START_COMMAND);
        writeSessionStartManifest(active, LEGACY_SESSION_START_COMMAND);
        makeStale(stale);
        installPath(active);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(join(active, 'scripts', 'session-start.mjs'))).toBe(false);
        expect(readdirSync(pluginDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('allows a directory symlink back to an ancestor when validating OMC payload', () => {
        const stale = writeVersion(STALE);
        const active = join(pluginDir, ACTIVE);
        writeFileSync(join(active, 'scripts', 'find-node.sh'), '#!/bin/sh\n');
        writeFileSync(join(active, 'scripts', 'session-start.mjs'), '// active hook script');
        writeSessionStartManifest(active, LEGACY_SESSION_START_COMMAND);
        const docs = join(active, 'docs');
        const backLink = join(docs, 'back');
        mkdirSync(docs);
        symlinkSync('..', backLink, 'dir');
        makeStale(stale);
        installPath(active);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(1);
        expect(result.errors).toHaveLength(0);
        expect(lstatSync(stale).isSymbolicLink()).toBe(true);
        expect(readlinkSync(stale)).toBe(active);
        expect(existsSync(join(stale, 'scripts', 'run.cjs'))).toBe(true);
    });
    it('rejects a generic target whose only entry is a directory cycle', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const backLink = join(active, 'back');
        mkdirSync(active, { recursive: true });
        symlinkSync('.', backLink, 'dir');
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'only stale payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(join(stale, 'README.md'), 'utf8')).toBe('only stale payload');
        expect(readlinkSync(backLink)).toBe('.');
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('rejects a generic target containing only empty directories', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        mkdirSync(join(active, 'commands'), { recursive: true });
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'only stale payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(join(stale, 'README.md'), 'utf8')).toBe('only stale payload');
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('rejects a generic target containing only zero-byte files', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), '');
        symlinkSync(join(active, 'README.md'), join(active, 'README-link.md'), 'file');
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'only stale payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(join(stale, 'README.md'), 'utf8')).toBe('only stale payload');
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it.each(['.DS_Store', 'desktop.ini', 'Thumbs.db'])('rejects a generic target containing only %s', (junkName) => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, junkName), 'operating-system metadata');
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'only stale payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(join(stale, 'README.md'), 'utf8')).toBe('only stale payload');
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it.skipIf(process.platform === 'win32')('rejects a generic target containing only a Unix socket', async () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const socketPath = join(active, 'only.sock');
        mkdirSync(active, { recursive: true });
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'only stale payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const server = createServer();
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(socketPath, resolve);
            });
            const result = purgeStalePluginCacheVersions();
            expect(result.symlinked).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(lstatSync(stale).isDirectory()).toBe(true);
            expect(readFileSync(join(stale, 'README.md'), 'utf8')).toBe('only stale payload');
            expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
        }
        finally {
            if (server.listening) {
                await new Promise((resolve) => server.close(() => resolve()));
            }
        }
    });
    it('preserves generic payload when a child symlink traverses the stale version', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const staleCommands = join(stale, 'commands');
        const activeCommands = join(active, 'commands');
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), 'active generic payload');
        mkdirSync(staleCommands, { recursive: true });
        writeFileSync(join(staleCommands, 'old-command.js'), 'old payload');
        writeFileSync(join(stale, 'README.md'), 'old generic payload');
        symlinkSync(staleCommands, activeCommands, 'dir');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(join(stale, 'commands', 'old-command.js'))).toBe(true);
        expect(readlinkSync(activeCommands)).toBe(staleCommands);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves generic payload when a resolvable link aliases stale data', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const activePayload = join(active, 'payload');
        const stalePayload = join(stale, 'payload');
        const legacyPayload = join(active, 'legacy');
        mkdirSync(activePayload, { recursive: true });
        writeFileSync(join(activePayload, 'current-command.js'), 'current payload');
        mkdirSync(stalePayload, { recursive: true });
        writeFileSync(join(stalePayload, 'legacy-command.js'), 'only stale payload');
        writeFileSync(join(active, 'README.md'), 'active generic payload');
        writeFileSync(join(stale, 'README.md'), 'old generic payload');
        symlinkSync(stalePayload, legacyPayload, 'dir');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(join(legacyPayload, 'legacy-command.js'))).toBe(true);
        expect(readlinkSync(legacyPayload)).toBe(stalePayload);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves generic payload when an intermediate link traverses the stale tree', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const oldRoot = join(configDir, 'external-old-root');
        const newRoot = join(configDir, 'external-new-root');
        const staleForward = join(stale, 'forward');
        const activeForward = join(active, 'forward');
        const activeLegacy = join(active, 'legacy');
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), 'generic plugin payload');
        mkdirSync(oldRoot, { recursive: true });
        writeFileSync(join(oldRoot, 'legacy-command.js'), 'old payload');
        mkdirSync(newRoot, { recursive: true });
        writeFileSync(join(newRoot, 'legacy-command.js'), 'new payload');
        mkdirSync(stale, { recursive: true });
        symlinkSync(oldRoot, staleForward, 'dir');
        symlinkSync(newRoot, activeForward, 'dir');
        symlinkSync(staleForward, activeLegacy, 'dir');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(join(activeLegacy, 'legacy-command.js'), 'utf8')).toBe('old payload');
        expect(readlinkSync(activeLegacy)).toBe(staleForward);
        expect(readlinkSync(staleForward)).toBe(oldRoot);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it.skipIf(process.platform === 'win32')('preserves generic payload when .. follows a link into the stale tree', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const outside = join(configDir, 'outside');
        const staleSubdir = join(stale, 'subdir');
        const staleFile = join(stale, 'forward', 'file');
        const activeFile = join(active, 'forward', 'file');
        const activeAlias = join(active, 'legacy');
        const aliasTarget = `${join(outside, 'pivot')}${sep}..${sep}forward${sep}file`;
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), 'active generic payload');
        mkdirSync(dirname(staleFile), { recursive: true });
        mkdirSync(staleSubdir, { recursive: true });
        writeFileSync(staleFile, 'only stale payload');
        mkdirSync(join(active, 'forward'), { recursive: true });
        writeFileSync(activeFile, 'active counterpart');
        mkdirSync(outside, { recursive: true });
        symlinkSync(staleSubdir, join(outside, 'pivot'), 'dir');
        symlinkSync(aliasTarget, activeAlias, 'file');
        writeFileSync(join(stale, 'README.md'), 'old generic payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(readFileSync(activeAlias, 'utf8')).toBe('only stale payload');
        expect(readlinkSync(activeAlias)).toBe(aliasTarget);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('allows a generic payload link with a valid relative parent traversal', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const sharedPayload = join(genericDir, 'shared-payload');
        const target = join(sharedPayload, 'legacy-command.js');
        const activeAlias = join(active, 'legacy-command.js');
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), 'active generic payload');
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'old generic payload');
        mkdirSync(sharedPayload, { recursive: true });
        writeFileSync(target, 'shared generic payload');
        const relativeTarget = relative(active, target);
        expect(relativeTarget.startsWith(`..${sep}`)).toBe(true);
        symlinkSync(relativeTarget, activeAlias, 'file');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(1);
        expect(result.errors).toHaveLength(0);
        expect(lstatSync(stale).isSymbolicLink()).toBe(true);
        expect(readlinkSync(stale)).toBe(active);
        expect(readFileSync(activeAlias, 'utf8')).toBe('shared generic payload');
    });
    it('preserves generic payload when a directory symlink contains a stale-version link', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        const externalPayload = join(configDir, 'external-generic-payload');
        const staleData = join(stale, 'data');
        const externalChild = join(externalPayload, 'child');
        const activePayload = join(active, 'payload');
        mkdirSync(active, { recursive: true });
        writeFileSync(join(active, 'README.md'), 'active generic payload');
        mkdirSync(stale, { recursive: true });
        writeFileSync(staleData, 'only old data');
        mkdirSync(externalPayload, { recursive: true });
        symlinkSync(staleData, externalChild, 'file');
        symlinkSync(externalPayload, activePayload, 'dir');
        writeFileSync(join(stale, 'README.md'), 'old generic payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(staleData)).toBe(true);
        expect(readlinkSync(activePayload)).toBe(externalPayload);
        expect(readlinkSync(externalChild)).toBe(staleData);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it.each(['root', 'descendant'])('preserves a stale root when the registered target redirects through its %s', (targetShape) => {
        const stale = writeVersion(STALE);
        let redirectTarget = stale;
        if (targetShape === 'descendant') {
            redirectTarget = join(stale, 'nested');
            mkdirSync(join(redirectTarget, 'scripts'), { recursive: true });
            writeFileSync(join(redirectTarget, 'scripts', 'run.cjs'), '// nested plugin root\n');
            mkdirSync(join(redirectTarget, 'hooks'), { recursive: true });
            writeFileSync(join(redirectTarget, 'hooks', 'hooks.json'), '{}\n');
        }
        const redirect = join(pluginDir, LEGACY[0]);
        symlinkSync(redirectTarget, redirect, 'dir');
        makeStale(stale);
        installPath(redirect);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(hookResolves(STALE)).toBe(true);
        expect(readlinkSync(redirect)).toBe(redirectTarget);
        expect(readdirSync(pluginDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('restores stale payload when the active symlink chain passes through it', () => {
        const stale = writeVersion(STALE);
        const forward = join(stale, 'forward');
        const externalRoot = join(configDir, 'external-valid-root');
        mkdirSync(join(externalRoot, 'scripts'), { recursive: true });
        writeFileSync(join(externalRoot, 'scripts', 'run.cjs'), '// valid plugin root\n');
        mkdirSync(join(externalRoot, 'hooks'), { recursive: true });
        writeFileSync(join(externalRoot, 'hooks', 'hooks.json'), '{}\n');
        symlinkSync(externalRoot, forward, 'dir');
        const active = join(pluginDir, LEGACY[0]);
        symlinkSync(forward, active, 'dir');
        makeStale(stale);
        installPath(active);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(hookResolves(STALE)).toBe(true);
        expect(readlinkSync(active)).toBe(forward);
        expect(readlinkSync(forward)).toBe(externalRoot);
        expect(readdirSync(pluginDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves generic plugin payload when the registered active target is empty', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        mkdirSync(active, { recursive: true });
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'README.md'), 'old plugin payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(join(stale, 'README.md'))).toBe(true);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
    it('preserves generic plugin payload when the active redirect points to its namespace', () => {
        const genericDir = join(configDir, 'plugins', 'cache', 'official', 'hookify');
        const active = join(genericDir, ACTIVE);
        const stale = join(genericDir, STALE);
        mkdirSync(genericDir, { recursive: true });
        symlinkSync(genericDir, active, 'dir');
        mkdirSync(stale);
        writeFileSync(join(stale, 'README.md'), 'old plugin payload');
        makeStale(stale);
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(lstatSync(stale).isDirectory()).toBe(true);
        expect(existsSync(join(stale, 'README.md'))).toBe(true);
        expect(readlinkSync(active)).toBe(genericDir);
        expect(readdirSync(genericDir).filter((name) => name.includes('.omc-stale-'))).toEqual([]);
    });
});
//# sourceMappingURL=purge-stale-cache-symlink.integration.test.js.map