import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { commitAgent, countOccupied, reserveAgent } from '../../scripts/lib/jev-pool.mjs';

const moduleUrl = new URL('../../scripts/lib/jev-pool.mjs', import.meta.url).href;
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function concurrentStops(dir, event, toolUseId) {
  const children = [];
  try {
    const workers = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const remove = fs.rmSync;
        // Widen the real read/delete race, without replacing pool reads or locking.
        fs.rmSync = (path, options) => {
          if (String(path).endsWith('.json') && String(path).includes('pool-agents')) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
          }
          return remove(path, options);
        };
        syncBuiltinESMExports();
        const { handlePoolHookEvent } = await import(${JSON.stringify(moduleUrl)});
        process.once('message', async () => {
          const released = await handlePoolHookEvent({
            hook_event_name: ${JSON.stringify(event)}, session_id: 'session',
            tool_use_id: ${JSON.stringify(toolUseId)}, cwd: process.cwd(),
          }, { env: { OMC_JEV_POOL: '1', OMC_JEV_LOG_DIR: ${JSON.stringify(dir)}, OMC_JEV_POOL_MAX_AGENTS: '40' } });
          process.send({ released }, () => process.disconnect());
        });
        process.send('ready');
      `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      let released;
      const ready = new Promise((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else released = message.released;
        });
        child.on('error', reject);
        child.on('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
      });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve(released) : reject(new Error(stderr)));
      });
      return { child, ready, done };
    });
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('go');
    return await Promise.all(workers.map((worker) => worker.done));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

// Mutation proof (release locks bypassed in a temporary module, 2026-11-17):
// FAIL: AssertionError: expected 1 to be 8 // Object.is equality
// All eight SubagentStop callers returned true, but only one file was deleted.
// Exact-call release also failed: expected [...] to have a length of 1 but got 8.
it.each(['pending', 'alive'])('releases eight distinct %s slots for eight concurrent SubagentStop hooks at capacity 40', async (state) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-release-race-'));
  directories.push(dir);
  for (let index = 0; index < 40; index++) {
    expect(reserveAgent({ dir, sessionId: 'session', toolUseId: `call-${index}`, env: { OMC_JEV_POOL_MAX_AGENTS: '40' } }).ok).toBe(true);
    if (state === 'alive') expect(commitAgent(dir, 'session')).toBe(true);
  }
  expect(countOccupied(dir)).toBe(40);
  expect(reserveAgent({ dir, sessionId: 'overflow', env: { OMC_JEV_POOL_MAX_AGENTS: '40' } }).ok).toBe(false);
  const results = await concurrentStops(dir, 'SubagentStop', '');
  expect(results.filter(Boolean)).toHaveLength(8);
  const files = readdirSync(join(dir, 'pool-agents')).filter((name) => name.endsWith('.json'));
  expect(40 - files.length).toBe(8);
  expect(countOccupied(dir)).toBe(32);
}, 20_000);

it('reports only one successful release for eight concurrent failures of the same tool call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-release-exact-race-'));
  directories.push(dir);
  expect(reserveAgent({ dir, sessionId: 'session', toolUseId: 'same-call', env: { OMC_JEV_POOL_MAX_AGENTS: '40' } }).ok).toBe(true);
  const results = await concurrentStops(dir, 'PostToolUseFailure', 'same-call');
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(countOccupied(dir)).toBe(0);
}, 20_000);
