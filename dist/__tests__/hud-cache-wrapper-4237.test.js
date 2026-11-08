import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(__dirname, '..', '..');
const wrapperPath = join(root, 'scripts', 'lib', 'hud-cache-wrapper.sh');
function makeOld(path) {
    const old = new Date(Date.now() - 30_000);
    utimesSync(path, old, old);
}
function makeFresh(path) {
    const now = new Date();
    utimesSync(path, now, now);
}
describe('HUD cache wrapper fast path (issue #4237)', () => {
    it('fast path: fresh cache younger than floor => no render started', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-fastpath-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const sessionId = 'fastpath-fresh';
        const cachedLine = 'FAST PATH CACHED LINE';
        writeFileSync(join(cacheDir, `statusline.${sessionId}.txt`), `${cachedLine}\n`);
        makeFresh(join(cacheDir, `statusline.${sessionId}.txt`));
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "console.log('should not render');");
        const nodeMarker = join(tempRoot, 'node-invoked');
        const fakeBin = join(tempRoot, 'bin');
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\nexit 0\n`);
        chmodSync(join(fakeBin, 'node'), 0o755);
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: JSON.stringify({ session_id: sessionId, cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}:/usr/bin:/bin`,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_MIN_REFRESH_SECONDS: '30',
            },
            timeout: 2000,
        });
        expect(output).toBe(`${cachedLine}\n`);
        expect(existsSync(nodeMarker)).toBe(false);
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('fast path: stale cache (older than floor) => render started', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-stale-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const sessionId = 'fastpath-stale';
        const cachedLine = 'STALE CACHED LINE';
        const newLine = 'FRESHLY RENDERED LINE';
        writeFileSync(join(cacheDir, `statusline.${sessionId}.txt`), `${cachedLine}\n`);
        makeOld(join(cacheDir, `statusline.${sessionId}.txt`));
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, `process.stdin.resume(); process.stdin.on('end', () => console.log('${newLine}'));`);
        // Multi-line payload without a trailing newline: the fast path consumed stdin,
        // so the stock path must persist exactly these bytes.
        const payload = `{"session_id":"${sessionId}",\n"cwd":"${tempRoot}"}`;
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: payload,
            encoding: 'utf8',
            env: {
                ...process.env,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_MIN_REFRESH_SECONDS: '10',
                OMC_HUD_SYNC_REFRESH: '1',
            },
            timeout: 2000,
        });
        // When cache is stale, we print the cached line but still trigger a refresh.
        // With SYNC_REFRESH, that refresh happens synchronously, updating the cache file.
        expect(output).toBe(`${cachedLine}\n`);
        expect(readFileSync(join(cacheDir, `statusline.${sessionId}.txt`), 'utf8')).toBe(`${newLine}\n`);
        expect(readFileSync(join(cacheDir, `stdin.${sessionId}.json`), 'utf8')).toBe(payload);
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('floor=0 restores stock behavior (always render, even if fresh)', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-floor0-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const sessionId = 'floor-zero';
        const cachedLine = 'FLOOR ZERO CACHE';
        const newLine = 'ALWAYS RENDER';
        writeFileSync(join(cacheDir, `statusline.${sessionId}.txt`), `${cachedLine}\n`);
        makeFresh(join(cacheDir, `statusline.${sessionId}.txt`));
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, `process.stdin.resume(); process.stdin.on('end', () => console.log('${newLine}'));`);
        const nodeMarker = join(tempRoot, 'node-invoked');
        const fakeBin = join(tempRoot, 'bin');
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\necho '${newLine}'\n`);
        chmodSync(join(fakeBin, 'node'), 0o755);
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: JSON.stringify({ session_id: sessionId, cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}:/usr/bin:/bin`,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_MIN_REFRESH_SECONDS: '0',
                OMC_HUD_SYNC_REFRESH: '1',
            },
            timeout: 2000,
        });
        // When floor=0, we should print cached line then force a refresh (today's behavior)
        expect(output).toBe(`${cachedLine}\n`);
        // Verify that Node was invoked despite fresh cache
        expect(existsSync(nodeMarker)).toBe(true);
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('falls through when session_id is missing', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-no-id-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('fallthrough-ok'));");
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: JSON.stringify({ cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_SYNC_REFRESH: '1',
            },
            timeout: 2000,
        });
        expect(output).toBe('fallthrough-ok\n');
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('falls through when session_id contains unsafe characters', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-unsafe-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('unsafe-fallthrough'));");
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: JSON.stringify({ session_id: 'unsafe@id#123', cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_SYNC_REFRESH: '1',
            },
            timeout: 2000,
        });
        expect(output).toBe('unsafe-fallthrough\n');
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('falls through with non-compact JSON (no session_id match)', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-noncompact-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('noncompact-ok'));");
        const spaced_json = JSON.stringify({ session_id: 'test-session', cwd: tempRoot }, null, 2);
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: spaced_json,
            encoding: 'utf8',
            env: {
                ...process.env,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_SYNC_REFRESH: '1',
            },
            timeout: 2000,
        });
        expect(output).toBe('noncompact-ok\n');
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('works under dash shell', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-dash-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const sessionId = 'dash-shell-test';
        const cachedLine = 'DASH SHELL CACHE';
        writeFileSync(join(cacheDir, `statusline.${sessionId}.txt`), `${cachedLine}\n`);
        makeFresh(join(cacheDir, `statusline.${sessionId}.txt`));
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "console.log('should not render');");
        const nodeMarker = join(tempRoot, 'node-invoked');
        const fakeBin = join(tempRoot, 'bin');
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\nexit 0\n`);
        chmodSync(join(fakeBin, 'node'), 0o755);
        const output = execFileSync('dash', [wrapperPath, hudScript], {
            input: JSON.stringify({ session_id: sessionId, cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}:/usr/bin:/bin`,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_MIN_REFRESH_SECONDS: '30',
            },
            timeout: 2000,
        });
        expect(output).toBe(`${cachedLine}\n`);
        expect(existsSync(nodeMarker)).toBe(false);
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('fast path preserves exact bytes including trailing newlines', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-4237-bytes-'));
        const cacheDir = join(tempRoot, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const sessionId = 'exact-bytes';
        const cachedContent = 'LINE1\nLINE2\n';
        writeFileSync(join(cacheDir, `statusline.${sessionId}.txt`), cachedContent);
        makeFresh(join(cacheDir, `statusline.${sessionId}.txt`));
        const hudScript = join(tempRoot, 'fake-hud.mjs');
        writeFileSync(hudScript, "console.log('should not render');");
        const nodeMarker = join(tempRoot, 'node-invoked');
        const fakeBin = join(tempRoot, 'bin');
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\nexit 0\n`);
        chmodSync(join(fakeBin, 'node'), 0o755);
        const output = execFileSync('sh', [wrapperPath, hudScript], {
            input: JSON.stringify({ session_id: sessionId, cwd: tempRoot }),
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}:/usr/bin:/bin`,
                OMC_HUD_CACHE_DIR: cacheDir,
                OMC_HUD_MIN_REFRESH_SECONDS: '30',
            },
            timeout: 2000,
        });
        expect(output).toBe(cachedContent);
        expect(existsSync(nodeMarker)).toBe(false);
        rmSync(tempRoot, { recursive: true, force: true });
    });
});
//# sourceMappingURL=hud-cache-wrapper-4237.test.js.map