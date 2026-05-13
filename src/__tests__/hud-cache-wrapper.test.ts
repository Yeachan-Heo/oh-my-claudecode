import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const wrapperPath = join(root, 'scripts', 'lib', 'hud-cache-wrapper.sh');

function makeOld(path: string): void {
  const old = new Date(Date.now() - 30_000);
  // Directory mtimes are enough for the wrapper's stale lock check.
  utimesSync(path, old, old);
}

describe('HUD cache wrapper stale render cleanup', () => {
  it('removes stale render locks and zero-byte temp files without deleting diagnostics', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-cache-wrapper-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const currentLock = join(cacheDir, 'render.issue-3002.lock');
    const otherLock = join(cacheDir, 'render.other-session.lock');
    mkdirSync(currentLock);
    mkdirSync(otherLock);
    makeOld(currentLock);
    makeOld(otherLock);

    const emptyStdoutTmp = join(cacheDir, 'statusline.issue-3002.123.tmp');
    const emptyStderrTmp = join(cacheDir, 'statusline.issue-3002.123.err');
    const emptyInputTmp = join(cacheDir, 'stdin.123.tmp');
    const diagnosticErr = join(cacheDir, 'statusline.issue-3002.diagnostic.err');
    writeFileSync(emptyStdoutTmp, '');
    writeFileSync(emptyStderrTmp, '');
    writeFileSync(emptyInputTmp, '');
    makeOld(emptyStdoutTmp);
    makeOld(emptyStderrTmp);
    makeOld(emptyInputTmp);
    writeFileSync(diagnosticErr, 'renderer exploded\n');

    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('rendered issue 3002'));\n");

    const output = execFileSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'issue-3002', cwd: tempRoot }),
      encoding: 'utf8',
      env: {
        ...process.env,
        OMC_HUD_CACHE_DIR: cacheDir,
        OMC_HUD_SYNC_REFRESH: '1',
      },
    });

    expect(output).toBe('[OMC] Starting...\n');
    expect(() => statSync(currentLock)).toThrow();
    expect(() => statSync(otherLock)).toThrow();
    expect(() => statSync(emptyStdoutTmp)).toThrow();
    expect(() => statSync(emptyStderrTmp)).toThrow();
    expect(() => statSync(emptyInputTmp)).toThrow();
    expect(readFileSync(diagnosticErr, 'utf8')).toBe('renderer exploded\n');
    expect(readFileSync(join(cacheDir, 'statusline.issue-3002.txt'), 'utf8')).toBe('rendered issue 3002\n');

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
