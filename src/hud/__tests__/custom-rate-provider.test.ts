import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithTimeout } from '../custom-rate-provider.js';

describe('custom rate provider child lifecycle', () => {
  it('terminates a timed-out command process group without retaining pipe handles', async () => {
    if (process.platform === 'win32') return;

    const directory = mkdtempSync(join(tmpdir(), 'omc-hud-provider-'));
    const pidFile = join(directory, 'pid');
    try {
      await expect(
        spawnWithTimeout(`echo $$ > ${JSON.stringify(pidFile)}; while :; do :; done`, 50),
      ).rejects.toThrow('timed out');

      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 2_000);

  it('returns normal command output before the timeout', async () => {
    await expect(spawnWithTimeout('printf normal-output', 500)).resolves.toBe('normal-output');
  });

});
