import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;
/**
 * Integration tests for the plugin cache cleanup logic in session-start.mjs.
 *
 * The script's cleanup block scans ~/.claude/plugins/cache/omc/oh-my-claudecode/
 * for version directories, keeps the latest 2 real directories, and replaces
 * older versions with symlinks pointing to the latest version. This prevents
 * "Cannot find module" errors when a running session's CLAUDE_PLUGIN_ROOT
 * still points to an old (now-removed) version directory.
 */
describe('session-start.mjs — plugin cache cleanup uses symlinks', () => {
    let tmpDir;
    let fakeHome;
    let fakeCacheBase;
    let fakeProject;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'omc-cache-test-'));
        fakeHome = join(tmpDir, 'home');
        fakeCacheBase = join(fakeHome, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        fakeProject = join(tmpDir, 'project');
        // Create fake project directory with .omc
        mkdirSync(join(fakeProject, '.omc', 'state'), { recursive: true });
        // session-start validateCwd requires a real workspace anchor (.git / .omc-workspace)
        mkdirSync(join(fakeProject, '.git'), { recursive: true });
        // Create fake cache base
        mkdirSync(fakeCacheBase, { recursive: true });
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });
    function createFakeVersion(version) {
        const versionDir = join(fakeCacheBase, version);
        mkdirSync(join(versionDir, 'scripts'), { recursive: true });
        writeFileSync(join(versionDir, 'scripts', 'run.cjs'), '// stub');
        writeFileSync(join(versionDir, 'scripts', 'session-start.mjs'), '// stub');
        writeFileSync(join(versionDir, 'package.json'), JSON.stringify({ version }));
        return versionDir;
    }
    function runSessionStart(env = {}) {
        // We can't easily run the full session-start.mjs because it reads stdin
        // and relies on many env vars. Instead, we test the cleanup logic by
        // providing the minimal input it needs.
        try {
            const result = execFileSync(NODE, [SCRIPT_PATH], {
                input: JSON.stringify({
                    hook_event_name: 'SessionStart',
                    session_id: 'test-session',
                    cwd: fakeProject,
                }),
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome, // Windows compat
                    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'), // Override to use fake home
                    CLAUDE_PLUGIN_ROOT: join(fakeCacheBase, '4.4.3'),
                    ...env,
                },
                timeout: 15000,
            });
            return result.trim();
        }
        catch (err) {
            // The script may exit with non-zero but we still want its stdout
            return err.stdout?.trim() || '';
        }
    }
    function createExternalPluginRoot(version) {
        const externalRoot = join(tmpDir, 'external-plugin-root');
        mkdirSync(join(externalRoot, 'dist', 'notifications'), { recursive: true });
        writeFileSync(join(externalRoot, 'package.json'), JSON.stringify({ version }));
        writeFileSync(join(externalRoot, 'dist', 'notifications', 'index.js'), 'export async function notify() {}\n');
        writeFileSync(join(externalRoot, 'dist', 'notifications', 'reply-listener.js'), 'export async function buildDaemonConfig() { return null; }\nexport function startReplyListener() {}\n');
        return externalRoot;
    }
    it('keeps explicit external plugin roots authoritative for update checks', () => {
        createFakeVersion('4.14.5');
        const externalRoot = createExternalPluginRoot('4.14.4');
        const updateCache = join(fakeHome, '.claude', '.omc', 'update-check.json');
        mkdirSync(join(fakeHome, '.claude', '.omc'), { recursive: true });
        writeFileSync(updateCache, JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '4.14.5',
            currentVersion: '4.14.4',
            updateAvailable: true,
        }));
        const output = runSessionStart({ CLAUDE_PLUGIN_ROOT: externalRoot });
        const parsed = JSON.parse(output);
        expect(parsed.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
        expect(parsed.systemMessage).toContain('current: v4.14.4');
    });
    it('uses latest managed cache version for stale managed cache roots', () => {
        createFakeVersion('4.14.4');
        createFakeVersion('4.14.5');
        const updateCache = join(fakeHome, '.claude', '.omc', 'update-check.json');
        mkdirSync(join(fakeHome, '.claude', '.omc'), { recursive: true });
        writeFileSync(updateCache, JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '4.14.5',
            currentVersion: '4.14.4',
            updateAvailable: true,
        }));
        const output = runSessionStart({ CLAUDE_PLUGIN_ROOT: join(fakeCacheBase, '4.14.4') });
        const parsed = JSON.parse(output);
        expect(parsed.systemMessage).toBeUndefined();
    });
    it('replaces old versions (beyond latest 2) with symlinks to the latest', () => {
        createFakeVersion('4.4.1');
        createFakeVersion('4.4.2');
        createFakeVersion('4.4.3');
        runSessionStart();
        // 4.4.3 (latest) and 4.4.2 (2nd latest) should remain as real directories
        const v3Stat = lstatSync(join(fakeCacheBase, '4.4.3'));
        expect(v3Stat.isDirectory()).toBe(true);
        expect(v3Stat.isSymbolicLink()).toBe(false);
        const v2Stat = lstatSync(join(fakeCacheBase, '4.4.2'));
        expect(v2Stat.isDirectory()).toBe(true);
        expect(v2Stat.isSymbolicLink()).toBe(false);
        // 4.4.1 (oldest) should be a symlink to 4.4.3
        const v1Stat = lstatSync(join(fakeCacheBase, '4.4.1'));
        expect(v1Stat.isSymbolicLink()).toBe(true);
        const target = readlinkSync(join(fakeCacheBase, '4.4.1'));
        expect(target).toBe('4.4.3');
    });
    it('with only 2 versions, no symlinks are created', () => {
        createFakeVersion('4.4.2');
        createFakeVersion('4.4.3');
        runSessionStart();
        // Both should remain as real directories
        const v3Stat = lstatSync(join(fakeCacheBase, '4.4.3'));
        expect(v3Stat.isDirectory()).toBe(true);
        expect(v3Stat.isSymbolicLink()).toBe(false);
        const v2Stat = lstatSync(join(fakeCacheBase, '4.4.2'));
        expect(v2Stat.isDirectory()).toBe(true);
        expect(v2Stat.isSymbolicLink()).toBe(false);
    });
    it('symlinked old version still resolves scripts correctly', () => {
        createFakeVersion('4.4.1');
        createFakeVersion('4.4.2');
        createFakeVersion('4.4.3');
        runSessionStart();
        // Verify that accessing a script through the symlinked old version works
        const scriptPath = join(fakeCacheBase, '4.4.1', 'scripts', 'run.cjs');
        expect(existsSync(scriptPath)).toBe(true);
    });
    it('handles 4+ versions, symlinking all but latest 2', () => {
        createFakeVersion('4.4.0');
        createFakeVersion('4.4.1');
        createFakeVersion('4.4.2');
        createFakeVersion('4.4.3');
        runSessionStart();
        // 4.4.3 and 4.4.2: real directories
        expect(lstatSync(join(fakeCacheBase, '4.4.3')).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(fakeCacheBase, '4.4.2')).isSymbolicLink()).toBe(false);
        // 4.4.1 and 4.4.0: symlinks to 4.4.3
        expect(lstatSync(join(fakeCacheBase, '4.4.1')).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(fakeCacheBase, '4.4.1'))).toBe('4.4.3');
        expect(lstatSync(join(fakeCacheBase, '4.4.0')).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(fakeCacheBase, '4.4.0'))).toBe('4.4.3');
    });
    it('updates an existing symlink pointing to a non-latest target', () => {
        createFakeVersion('4.4.2');
        createFakeVersion('4.4.3');
        // Manually create a stale symlink: 4.4.1 -> 4.4.2 (not the latest 4.4.3)
        const { symlinkSync } = require('fs');
        symlinkSync('4.4.2', join(fakeCacheBase, '4.4.1'));
        runSessionStart();
        // 4.4.1 should now be a symlink to 4.4.3 (updated from 4.4.2)
        const v1Stat = lstatSync(join(fakeCacheBase, '4.4.1'));
        expect(v1Stat.isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(fakeCacheBase, '4.4.1'))).toBe('4.4.3');
        // 4.4.3 and 4.4.2 remain as real directories
        expect(lstatSync(join(fakeCacheBase, '4.4.3')).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(fakeCacheBase, '4.4.2')).isSymbolicLink()).toBe(false);
    });
    it('with only 1 version, no cleanup is needed', () => {
        createFakeVersion('4.4.3');
        runSessionStart();
        // Single version should remain as a real directory
        const entries = readdirSync(fakeCacheBase);
        expect(entries).toEqual(['4.4.3']);
        const v3Stat = lstatSync(join(fakeCacheBase, '4.4.3'));
        expect(v3Stat.isDirectory()).toBe(true);
        expect(v3Stat.isSymbolicLink()).toBe(false);
    });
});
//# sourceMappingURL=session-start-cache-cleanup.test.js.map