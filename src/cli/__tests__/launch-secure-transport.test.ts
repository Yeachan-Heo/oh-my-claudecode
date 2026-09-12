import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

describe('secure credential transport failure cleanup', () => {
  it('removes the private temp directory when writing the transport fails', () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('omc-launch-env-')));
    process.env.ANTHROPIC_API_KEY = 'write-failure-secret';
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('disk full');
    });

    try {
      expect(() => buildSensitiveEnvFilePrefix(['ANTHROPIC_API_KEY'])).toThrow(
        'Unable to prepare secure credential transport: disk full',
      );
      const after = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('omc-launch-env-')));
      expect(after).toEqual(before);
    } finally {
      writeFileSyncMock.mockReset();
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });
});
