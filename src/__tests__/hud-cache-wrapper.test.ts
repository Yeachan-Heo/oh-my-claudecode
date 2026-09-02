import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const wrapperPath = join(root, 'scripts', 'lib', 'hud-cache-wrapper.sh');

function makeOld(path: string): void {
  const old = new Date(Date.now() - 30_000);
  utimesSync(path, old, old);
}

function makeFresh(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
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

    expect(output).toBe('rendered issue 3002\n');
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

describe('HUD cache wrapper lock ownership (issue #3933 defect 1)', () => {
  it('does not evict a live holder whose lock is mtime-stale', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-lock-live-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const liveLock = join(cacheDir, 'render.live-session.lock');
    mkdirSync(liveLock);
    writeFileSync(join(liveLock, 'pid'), `${process.pid}\n`);
    makeOld(liveLock);
    try {
      makeOld(join(liveLock, 'pid'));
    } catch { void 0; }

    const cached = join(cacheDir, 'statusline.live-session.txt');
    writeFileSync(cached, 'EXISTING\n');
    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "console.log('should not render fresh');\n");
    const fakeBin = join(tempRoot, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const marker = join(tempRoot, 'node-invoked');
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, 'utf8');
    chmodSync(join(fakeBin, 'node'), 0o755);

    try {
      rmSync(liveLock, { recursive: true, force: true });
    } catch { void 0; }
    mkdirSync(liveLock, { recursive: true });
    writeFileSync(join(liveLock, 'pid'), `${process.pid}\n`);
    makeOld(liveLock);
    try {
      makeOld(join(liveLock, 'pid'));
    } catch { void 0; }

    const result = spawnSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'live-session', cwd: tempRoot }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMC_HUD_CACHE_DIR: cacheDir,
      },
      timeout: 2000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('EXISTING\n');
    expect(existsSync(liveLock)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(cached, 'utf8')).toBe('EXISTING\n');

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('recovers a dead-holder lock that is mtime-stale', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-lock-dead-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const deadLock = join(cacheDir, 'render.dead-session.lock');
    mkdirSync(deadLock);
    writeFileSync(join(deadLock, 'pid'), '999999\n');
    makeOld(deadLock);
    try {
      makeOld(join(deadLock, 'pid'));
    } catch { void 0; }

    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('recovered'));\n");

    const output = execFileSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'dead-session', cwd: tempRoot }),
      encoding: 'utf8',
      env: {
        ...process.env,
        OMC_HUD_CACHE_DIR: cacheDir,
        OMC_HUD_SYNC_REFRESH: '1',
      },
    });

    expect(output).toBe('recovered\n');
    expect(readFileSync(join(cacheDir, 'statusline.dead-session.txt'), 'utf8')).toBe('recovered\n');
    expect(existsSync(deadLock)).toBe(false);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('treats malformed pid metadata as reclaimable only when stale', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-lock-malformed-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "console.log('x');\n");
    const fakeBin = join(tempRoot, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const marker = join(tempRoot, 'marker');
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n printf "x\\n"\n`, 'utf8');
    chmodSync(join(fakeBin, 'node'), 0o755);

    const freshBad = join(cacheDir, 'render.malformed-fresh.lock');
    mkdirSync(freshBad);
    writeFileSync(join(freshBad, 'pid'), 'not-a-pid\n');
    makeFresh(freshBad);
    writeFileSync(join(cacheDir, 'statusline.malformed-fresh.txt'), 'CACHED\n');

    let result = spawnSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'malformed-fresh', cwd: tempRoot }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, OMC_HUD_CACHE_DIR: cacheDir },
      timeout: 2000,
    });
    expect(result.stdout).toBe('CACHED\n');
    expect(existsSync(freshBad)).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const staleBad = join(cacheDir, 'render.malformed-stale.lock');
    mkdirSync(staleBad);
    writeFileSync(join(staleBad, 'pid'), 'also-bad-$$$\n');
    makeOld(staleBad);
    writeFileSync(join(cacheDir, 'statusline.malformed-stale.txt'), 'CACHED2\n');
    result = spawnSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'unrelated', cwd: tempRoot }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, OMC_HUD_CACHE_DIR: cacheDir, OMC_HUD_SYNC_REFRESH: '1' },
      timeout: 2000,
    });
    expect(existsSync(staleBad)).toBe(false);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('serializes hot-path acquisition to at most one fresh render (no duplicate updates)', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-lock-race-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(join(cacheDir, 'statusline.race-session.txt'), 'BASE\n');

    const hudScript = join(tempRoot, 'slow-hud.mjs');
    writeFileSync(
      hudScript,
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const c=process.env.OMC_HUD_CACHE_DIR;
      const ctr=path.join(c,'ctr');
      let n=0; try{ n=parseInt(fs.readFileSync(ctr,'utf8'),10)||0;}catch{}
      n++;
      const end=Date.now()+600; while(Date.now()<end){}
      fs.writeFileSync(ctr,String(n));
      console.log('RENDER '+n);
    `,
    );

    const payload = JSON.stringify({ session_id: 'race-session', cwd: tempRoot });
    const first = spawnSync('sh', [wrapperPath, hudScript], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, OMC_HUD_CACHE_DIR: cacheDir, OMC_HUD_SYNC_REFRESH: '1' },
      timeout: 3000,
    });
    expect(first.stdout).toBe('BASE\n');
    const ctr1 = existsSync(join(cacheDir, 'ctr')) ? readFileSync(join(cacheDir, 'ctr'), 'utf8').trim() : '0';
    expect(ctr1).toBe('1');
    expect(readFileSync(join(cacheDir, 'statusline.race-session.txt'), 'utf8')).toBe('RENDER 1\n');

    const manualLock = join(cacheDir, 'render.race-session.lock');
    mkdirSync(manualLock, { recursive: true });
    writeFileSync(join(manualLock, 'pid'), `${process.pid}\n`);
    makeFresh(manualLock);
    const secondWhileLocked = spawnSync('sh', [wrapperPath, hudScript], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, OMC_HUD_CACHE_DIR: cacheDir, OMC_HUD_SYNC_REFRESH: '1' },
      timeout: 2000,
    });
    expect(secondWhileLocked.stdout).toBe('RENDER 1\n');
    const ctr2 = readFileSync(join(cacheDir, 'ctr'), 'utf8').trim();
    expect(ctr2).toBe('1');

    rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('HUD cache wrapper err reclamation (issue #3933 defect 2)', () => {
  it('reclaims non-empty stale .err files while retaining a fresh diagnostic', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-err-reclaim-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const staleErrA = join(cacheDir, 'statusline.s-n.111.err');
    const staleErrB = join(cacheDir, 'statusline.s-n.222.err');
    const freshErr = join(cacheDir, 'statusline.s-n.333.err');
    writeFileSync(staleErrA, 'old diagnostic A\n');
    writeFileSync(staleErrB, 'old diagnostic B\n');
    writeFileSync(freshErr, 'fresh diagnostic keeps for triage\n');
    makeOld(staleErrA);
    makeOld(staleErrB);

    const emptyTmp = join(cacheDir, 'statusline.s-n.999.tmp');
    writeFileSync(emptyTmp, '');
    makeOld(emptyTmp);

    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('ok'));\n");

    const output = execFileSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 's-n', cwd: tempRoot }),
      encoding: 'utf8',
      env: { ...process.env, OMC_HUD_CACHE_DIR: cacheDir, OMC_HUD_SYNC_REFRESH: '1' },
      timeout: 2000,
    });
    expect(output).toBe('ok\n');
    expect(existsSync(staleErrA)).toBe(false);
    expect(existsSync(staleErrB)).toBe(false);
    expect(readFileSync(freshErr, 'utf8')).toBe('fresh diagnostic keeps for triage\n');
    expect(existsSync(emptyTmp)).toBe(false);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not delete a freshly written non-empty .err (actively written guard via staleness)', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-hud-err-fresh-'));
    const cacheDir = join(tempRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const activeErr = join(cacheDir, 'statusline.concurrent.999.err');
    writeFileSync(activeErr, 'concurrent render currently writing...\n');
    makeFresh(activeErr);

    writeFileSync(join(cacheDir, 'statusline.concurrent.txt'), 'CACHED\n');
    const hudScript = join(tempRoot, 'fake-hud.mjs');
    writeFileSync(hudScript, "console.log('x')\n");
    const fakeBin = join(tempRoot, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(join(fakeBin, 'node'), 0o755);
    mkdirSync(join(cacheDir, 'render.concurrent.lock'));
    writeFileSync(join(join(cacheDir, 'render.concurrent.lock'), 'pid'), `${process.pid}\n`);

    const result = spawnSync('sh', [wrapperPath, hudScript], {
      input: JSON.stringify({ session_id: 'concurrent', cwd: tempRoot }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, OMC_HUD_CACHE_DIR: cacheDir },
      timeout: 2000,
    });
    expect(result.stdout).toBe('CACHED\n');
    expect(readFileSync(activeErr, 'utf8')).toContain('concurrent');

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
