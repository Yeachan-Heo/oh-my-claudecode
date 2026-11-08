import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
  };
});

import { buildSensitiveEnvFilePrefix } from '../launch.js';

const TEMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

describe('secure credential transport failure cleanup', () => {
  const savedTempEnv: Record<string, string | undefined> = {};
  let transportRoot: string;

  beforeEach(() => {
    // os.tmpdir() is process-wide, so asserting on its contents would observe
    // transports created by concurrently running test files. Redirect it to a
    // private root so the assertion covers only this call's artifacts.
    transportRoot = realpathSync(mkdtempSync(join(tmpdir(), 'omc-transport-root-')));
    for (const name of TEMP_ENV_VARS) {
      savedTempEnv[name] = process.env[name];
      process.env[name] = transportRoot;
    }
  });

  afterEach(() => {
    for (const name of TEMP_ENV_VARS) {
      if (savedTempEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedTempEnv[name] as string;
    }
    rmSync(transportRoot, { recursive: true, force: true });
  });

  it('removes the private temp directory when writing the transport fails', () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'write-failure-secret';
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('disk full');
    });

    try {
      expect(() => buildSensitiveEnvFilePrefix(['ANTHROPIC_API_KEY'])).toThrow(
        'Unable to prepare secure credential transport: disk full',
      );
      expect(readdirSync(transportRoot)).toEqual([]);
    } finally {
      writeFileSyncMock.mockReset();
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });
});
