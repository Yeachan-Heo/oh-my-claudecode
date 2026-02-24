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