import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { detectCli, detectAllClis } from '../cli-detection.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  };
}

describe('cli-detection', () => {
  it('uses shell:true for Windows provider version probes', () => {
    const mockSpawnSync = vi.mocked(spawnSync);
    const restorePlatform = setProcessPlatform('win32');

    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'codex 1.0.0', stderr: '', pid: 0, output: [], signal: null } as any)
      .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd', stderr: '', pid: 0, output: [], signal: null } as any);

    expect(detectCli('codex')).toEqual({
      available: true,
      version: 'codex 1.0.0',
      path: 'C:\\Tools\\codex.cmd',
    });

    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'codex', ['--version'], { timeout: 5000, shell: true });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'where', ['codex'], { timeout: 5000 });
    restorePlatform();
    mockSpawnSync.mockRestore();
  });

  it('detectAllClis includes qwen in results', () => {
    const mockSpawnSync = vi.mocked(spawnSync);
    // Mock all version + path calls for claude, codex, gemini, qwen (4 * 2 = 8 calls)
    for (let i = 0; i < 8; i++) {
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);
    }

    const result = detectAllClis();
    expect(result).toHaveProperty('claude');
    expect(result).toHaveProperty('codex');
    expect(result).toHaveProperty('gemini');
    expect(result).toHaveProperty('qwen');
    mockSpawnSync.mockRestore();
  });
});
