import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCustomProvider } from '../custom-rate-provider.js';

let directory: string;
let cachePath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'omc-provider-identity-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
  cachePath = join(directory, 'plugins', 'oh-my-claudecode', '.custom-rate-cache.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function provider(ids: string[], counter?: string, failureFlag?: string): string[] {
  const output = JSON.stringify({ version: 1, buckets: ids.map(id => ({ id, label: id, usage: { type: 'percent', value: 25 } })) });
  return [process.execPath, '-e', `const fs = require('node:fs'); ${counter ? `fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n');` : ''} ${failureFlag ? `if (fs.existsSync(${JSON.stringify(failureFlag)})) process.exit(1);` : ''} process.stdout.write(${JSON.stringify(output)});`];
}
const config = (command: string[], periods?: string[]) => ({ type: 'custom' as const, command, periods, timeoutMs: 2_000 });

describe('custom provider cache identity', () => {
  it('runs a changed command instead of returning the previous provider within TTL', async () => {
    expect((await executeCustomProvider(config(provider(['first'])))).buckets[0].id).toBe('first');
    expect((await executeCustomProvider(config(provider(['second'])))).buckets[0].id).toBe('second');
  });

  it('honors changed period filters and restoring all periods within TTL', async () => {
    const command = provider(['daily', 'monthly']);
    expect((await executeCustomProvider(config(command, ['daily']))).buckets.map(bucket => bucket.id)).toEqual(['daily']);
    expect((await executeCustomProvider(config(command, ['monthly']))).buckets.map(bucket => bucket.id)).toEqual(['monthly']);
    expect((await executeCustomProvider(config(command, []))).buckets.map(bucket => bucket.id)).toEqual(['daily', 'monthly']);
  });

  it('reuses matching fresh cache for equivalent period sets without storing command text', async () => {
    const counter = join(directory, 'secret-command-marker');
    const command = provider(['daily', 'monthly'], counter);
    await executeCustomProvider(config(command, ['daily', 'monthly']));
    await executeCustomProvider(config(command, ['monthly', 'daily', 'daily']));
    expect(readFileSync(counter, 'utf8')).toBe('run\n');
    expect(readFileSync(cachePath, 'utf8')).not.toContain(counter);
  });

  it('does not use another provider cache when a changed command fails', async () => {
    await executeCustomProvider(config(provider(['first'])));
    const result = await executeCustomProvider(config([process.execPath, '-e', 'process.exit(1)']));
    expect(result).toEqual({ buckets: [], stale: false, error: 'command failed' });
  });

  it('retains stale fallback for the same command and periods', async () => {
    const failureFlag = join(directory, 'fail');
    const command = provider(['same'], undefined, failureFlag);
    await executeCustomProvider(config(command));
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    writeFileSync(cachePath, JSON.stringify({ ...cache, timestamp: Date.now() - 60_000 }));
    appendFileSync(failureFlag, 'fail');
    const result = await executeCustomProvider(config(command));
    expect(result.stale).toBe(true);
    expect(result.buckets[0].id).toBe('same');
  });

  it('refreshes legacy unkeyed cache rather than attributing it to a new command', async () => {
    await executeCustomProvider(config(provider(['old'])));
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    delete cache.identity;
    writeFileSync(cachePath, JSON.stringify(cache));
    expect((await executeCustomProvider(config(provider(['new'])))).buckets[0].id).toBe('new');
  });
});
