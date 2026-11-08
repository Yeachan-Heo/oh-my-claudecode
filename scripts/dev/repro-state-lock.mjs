// Repro for issue #4146: mutual exclusion of the owner-file fallback in
// scripts/lib/state-lock.mjs (owner releases/exits during a reclaimer's liveness
// probe; the reclaimer must not quarantine a live replacement owner).
//
// Usage (from any cwd):  node scripts/dev/repro-state-lock.mjs [procs=8] [iterations=15]
//
// Spawns `procs` worker processes that each acquire/increment/release a shared
// counter `iterations` times. Children run with NODE_ENV=test
// OMC_TEST_FLOCK_AVAILABLE=0 to force the owner-file fallback (the same path
// taken when better-sqlite3 cannot load). Prints acquisitions vs. counter,
// overlaps, release/acquire failures, and a final RESULT line
// (OK | MUTUAL EXCLUSION VIOLATED | LOCK STRANDED).
//
// Worker mode (used internally and by tests/integration/state-lock-owner-reclaim.test.ts):
//   node scripts/dev/repro-state-lock.mjs worker <target> <iterations> <log>
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , role, ...args] = process.argv;

if (role === 'worker') {
  const lib = await import('../lib/state-lock.mjs');
  const [target, iterations, log] = args;
  const inside = `${target}.inside`; // created O_EXCL inside the critical section
  const deadline = Date.now() + 60_000; // keep the run bounded if a lock gets stranded
  for (let i = 0; i < Number(iterations) && Date.now() < deadline; i++) {
    const lock = lib.acquireStateFileLockSync(target, 50);
    if (!lock) {
      const message = lib.getStateFileLockFailureMessage();
      appendFileSync(log, `${process.pid} acquire-failed: ${/contention/.test(message) ? 'contention' : /could not be verified/.test(message) ? 'unverifiable' : message}\n`);
      continue;
    }
    let marker = true;
    try { closeSync(openSync(inside, 'wx')); } catch { marker = false; appendFileSync(log, `${process.pid} OVERLAP: another process is inside the critical section\n`); }
    const n = Number(readFileSync(target, 'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // hold the lock ~5 ms
    writeFileSync(target, String(n + 1));
    if (marker) unlinkSync(inside);
    appendFileSync(log, `${process.pid} acquired\n`);
    if (!lib.releaseStateFileLockSync(lock)) appendFileSync(log, `${process.pid} release-failed: ${lib.getStateFileLockFailureMessage()}\n`);
  }
} else {
  const procs = Number(role || 8), iterations = Number(args[0] || 15);
  const dir = mkdtempSync(join(tmpdir(), 'omc-lock-repro-'));
  mkdirSync(join(dir, 'state'));
  const target = join(dir, 'state', 'counter.json');
  const log = join(dir, 'log.txt');
  writeFileSync(target, '0'); writeFileSync(log, '');
  // Force the owner-file fallback (same path taken when better-sqlite3 cannot load).
  const env = { ...process.env, NODE_ENV: 'test', OMC_TEST_FLOCK_AVAILABLE: '0' };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: procs }, () => new Promise(resolve =>
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', target, String(iterations), log], { env, stdio: 'inherit' }).on('exit', resolve))));
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const count = re => lines.filter(l => re.test(l)).length;
  const acquired = count(/ acquired$/), counter = Number(readFileSync(target, 'utf8'));
  console.log(`platform=${process.platform} node=${process.version} procs=${procs} iterations=${iterations} elapsed=${Date.now() - t0}ms`);
  console.log(`acquisitions=${acquired} counter=${counter} lostUpdates=${acquired - counter} overlaps=${count(/OVERLAP/)} releaseFailures=${count(/release-failed/)} acquireFailures=${count(/acquire-failed/)}`);
  const stranded = existsSync(`${target}.mutation.lock`);
  if (stranded) console.log(`lock file still present after all workers exited:${readFileSync(`${target}.mutation.lock`, 'utf8')}`);
  for (const l of [...new Set(lines.filter(l => !/ acquired$/.test(l)).map(l => l.replace(/^\d+ /, '')))].slice(0, 6)) console.log(`  ${l}`);
  const violated = acquired !== counter || count(/OVERLAP/) > 0;
  console.log(`RESULT: ${violated ? 'MUTUAL EXCLUSION VIOLATED' : stranded ? 'LOCK STRANDED' : 'OK'}`);
}
