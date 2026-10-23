import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt,
} from '../worker-launch-ack.js';

describe('worker launch ack timeout env', () => {
  let cwd = '';
  const previous = process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS;

  afterEach(async () => {
    if (previous === undefined)
      delete process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS;
    else process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS = previous;
    if (cwd) await rm(cwd, { recursive: true, force: true });
    cwd = '';
  });

  async function decisionTimeout(raw: string): Promise<number> {
    process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS = raw;
    cwd = await mkdtemp(join(tmpdir(), 'ack-timeout-'));
    const attempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      instanceId: randomUUID(),
      paneId: '%2',
      provider: 'codex',
      runtimeCliPath: '/runtime-cli.cjs',
    });
    return buildWorkerLaunchBootstrapSpec(attempt, ['codex'], cwd)
      .decision_timeout_ms;
  }

  it('reads a plain millisecond value', async () => {
    await expect(decisionTimeout('20000')).resolves.toBe(20_000);
  });

  it('reads a scientific integer instead of stopping at the exponent', async () => {
    await expect(decisionTimeout('1e5')).resolves.toBe(100_000);
  });

  it('ignores a numeric separator instead of keeping the digits before it', async () => {
    await expect(decisionTimeout('30_000')).resolves.toBe(15_000);
  });

  it('ignores trailing junk instead of keeping the truncated prefix', async () => {
    await expect(decisionTimeout('12abc')).resolves.toBe(15_000);
  });

  it.each([
    '0',
    '-1',
    'not-a-number',
    '1.5',
    '   ',
    '9007199254740992',
    '1e309',
  ])('uses the default for invalid timeout %s', async (raw) => {
    await expect(decisionTimeout(raw)).resolves.toBe(15_000);
  });

  it('trims surrounding whitespace around a valid timeout', async () => {
    await expect(decisionTimeout(' \t20000\n ')).resolves.toBe(20_000);
  });

  it('accepts the largest safe integer timeout', async () => {
    await expect(decisionTimeout('9007199254740991')).resolves.toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
