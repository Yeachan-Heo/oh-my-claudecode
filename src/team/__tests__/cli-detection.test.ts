import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { detectCli, detectAllClis, probeCli } from '../cli-detection.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  };
}

function spawnResult(
  overrides: Partial<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error: NodeJS.ErrnoException;
  }> = {},
): any {
  return {
    status: 1,
    signal: null,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
    ...overrides,
  };
}

describe('cli-detection', () => {
  const mockSpawnSync = vi.mocked(spawnSync);
  const mockExistsSync = vi.mocked(existsSync);
  let restorePlatform: (() => void) | undefined;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = undefined;
    vi.unstubAllEnvs();
    mockExistsSync.mockReset();
  });

  it('resolves and enriches a POSIX CLI with the first absolute result', () => {
    restorePlatform = setProcessPlatform('linux');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/opt/tools/codex\n/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'codex 1.0.0\nsecond line\n' }));

    expect(probeCli('codex')).toEqual({
      found: true,
      path: '/opt/tools/codex',
      version: 'codex 1.0.0',
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['codex'], {
      timeout: 5000,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, '/opt/tools/codex', ['--version'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
  });

  it('uses the modeled Win32 finder and path flavor independent of the host', () => {
    restorePlatform = setProcessPlatform('win32');
    mockSpawnSync
      .mockReturnValueOnce(
        spawnResult({
          status: 0,
          stdout: 'relative\\codex.cmd\r\nC:\\Tools\\codex.cmd\r\nC:\\Other\\codex.cmd\r\n',
        }),
      )
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'codex 2.0.0\r\n' }));

    expect(probeCli('codex')).toEqual({
      found: true,
      path: 'C:\\Tools\\codex.cmd',
      version: 'codex 2.0.0',
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where.exe', ['codex'], {
      timeout: 5000,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'C:\\Tools\\codex.cmd', ['--version'], expect.objectContaining({ shell: false }));
  });

  it('uses POSIX path semantics when the host is modeled as POSIX', () => {
    restorePlatform = setProcessPlatform('darwin');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'C:\\Tools\\codex.exe\n/opt/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'codex 3.0.0' }));

    expect(probeCli('codex')).toMatchObject({ found: true, path: '/opt/codex', version: 'codex 3.0.0' });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['codex'], expect.objectContaining({ shell: false }));
  });

  it('uses Win32 path semantics when the host is modeled as Windows', () => {
    restorePlatform = setProcessPlatform('win32');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'relative\\codex.exe\r\nD:\\Tools\\codex.exe\r\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'codex 4.0.0' }));

    expect(probeCli('codex')).toMatchObject({ found: true, path: 'D:\\Tools\\codex.exe', version: 'codex 4.0.0' });
  });

  it.each([
    ['finder timeout', spawnResult({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } as NodeJS.ErrnoException })],
    ['finder start error', spawnResult({ status: null, signal: null, error: { code: 'ENOENT' } as NodeJS.ErrnoException })],
    ['finder nonzero', spawnResult({ status: 1 })],
    ['finder blank output', spawnResult({ status: 0, stdout: ' \r\n\n' })],
    ['finder only relative output', spawnResult({ status: 0, stdout: 'relative-tool\r\nother-tool\n' })],
  ])('returns a resolver error for %s without a version spawn', (_name, finderResult) => {
    restorePlatform = setProcessPlatform('linux');
    mockSpawnSync.mockReturnValueOnce(finderResult);

    expect(probeCli('codex')).toEqual({ found: false, error: 'CLI resolver failed' });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'codex/evil', 'codex\\evil', 'codex name', 'codex\tname', 'codex\nname', 'codex"name', 'codex&name', 'café'])(
    'rejects unsafe bare binary name %j before spawning',
    (binary) => {
      expect(probeCli(binary)).toEqual({ found: false, error: 'invalid CLI name' });
      expect(mockSpawnSync).not.toHaveBeenCalled();
    },
  );

  it('maps direct status-zero output to the public and legacy results', () => {
    restorePlatform = setProcessPlatform('linux');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '\n codex 5.0.0 \n' }));

    expect(probeCli('codex')).toEqual({ found: true, path: '/usr/bin/codex', version: 'codex 5.0.0' });
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);

    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'codex 5.0.0\n' }));
    expect(detectCli('codex')).toEqual({ available: true, version: 'codex 5.0.0', path: '/usr/bin/codex' });
  });

  it('keeps a zero-exit blank version available to legacy callers', () => {
    restorePlatform = setProcessPlatform('linux');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: ' \r\n\n' }));

    expect(probeCli('codex')).toEqual({
      found: true,
      path: '/usr/bin/codex',
      error: 'version probe returned no output',
    });

    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '  \n' }));
    expect(detectCli('codex')).toEqual({ available: true, version: '', path: '/usr/bin/codex' });
  });

  it('retains found but maps a failed direct version probe to legacy unavailable', () => {
    restorePlatform = setProcessPlatform('linux');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 1, stdout: '', stderr: 'not supported' }));

    expect(probeCli('codex')).toEqual({ found: true, path: '/usr/bin/codex', error: 'version probe failed' });

    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '/usr/bin/codex\n' }))
      .mockReturnValueOnce(spawnResult({ status: 1 }));
    expect(detectCli('codex')).toEqual({ available: false });
  });

  it.each(['ENOENT', 'UNKNOWN', 'EINVAL'])('uses the closed batch fallback for direct %s', (code) => {
    restorePlatform = setProcessPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'C:\\Program Files\\Provider\\provider.cmd\r\n' }))
      .mockReturnValueOnce(spawnResult({ status: null, signal: null, error: { code } as NodeJS.ErrnoException }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'provider 6.0.0\r\n' }));

    expect(probeCli('provider')).toEqual({
      found: true,
      path: 'C:\\Program Files\\Provider\\provider.cmd',
      version: 'provider 6.0.0',
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\Provider\\provider.cmd" --version"'],
      {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: process.env,
      },
    );
  });

  it('maps a blank batch wrapper result like any other zero-exit version result', () => {
    restorePlatform = setProcessPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'C:\\Tools\\provider.cmd\r\n' }))
      .mockReturnValueOnce(spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: '\r\n' }));

    expect(probeCli('provider')).toEqual({
      found: true,
      path: 'C:\\Tools\\provider.cmd',
      error: 'version probe returned no output',
    });
  });

  it('degrades safely when COMSPEC is invalid and the default is unavailable', () => {
    restorePlatform = setProcessPlatform('win32');
    mockExistsSync.mockReturnValue(false);
    vi.stubEnv('ComSpec', 'relative\\not-cmd.exe');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\not-cmd.exe');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'C:\\Tools\\provider.cmd\r\n' }))
      .mockReturnValueOnce(spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException }));

    expect(probeCli('provider')).toEqual({
      found: true,
      path: 'C:\\Tools\\provider.cmd',
      error: 'version probe failed',
    });
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('rejects a relative Windows resolver candidate before any version or COMSPEC call', () => {
    restorePlatform = setProcessPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockSpawnSync.mockReturnValueOnce(spawnResult({ status: 0, stdout: 'relative\\provider.cmd\r\n' }));

    expect(probeCli('provider')).toEqual({ found: false, error: 'CLI resolver failed' });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['non-batch path', 'C:\\Tools\\provider.exe', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['percent path', 'C:\\Tools\\provider%inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['exclamation path', 'C:\\Tools\\provider!inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['caret path', 'C:\\Tools\\provider^inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['ampersand path', 'C:\\Tools\\provider&inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['pipe path', 'C:\\Tools\\provider|inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['less-than path', 'C:\\Tools\\provider<inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['greater-than path', 'C:\\Tools\\provider>inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['parentheses path', 'C:\\Tools\\provider(inject).cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['quoted path', 'C:\\Tools\\provider"inject.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['NUL path', `C:\\Tools\\provider${String.fromCharCode(0)}inject.cmd`, spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['UNC path', '\\\\server\\share\\provider.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['device path', '\\\\?\\C:\\Tools\\provider.cmd', spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['completed zero-exit path', 'C:\\Tools\\provider.cmd', spawnResult({ status: 0, signal: null, stdout: '' })],
    ['completed nonzero path', 'C:\\Tools\\provider.cmd', spawnResult({ status: 1, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['signaled path', 'C:\\Tools\\provider.cmd', spawnResult({ status: null, signal: 'SIGTERM', error: { code: 'EINVAL' } as NodeJS.ErrnoException })],
    ['timed-out path', 'C:\\Tools\\provider.cmd', spawnResult({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } as NodeJS.ErrnoException })],
    ['missing direct error', 'C:\\Tools\\provider.cmd', spawnResult({ status: null, signal: null })],
    ['unadmitted direct error', 'C:\\Tools\\provider.cmd', spawnResult({ status: null, signal: null, error: { code: 'EACCES' } as NodeJS.ErrnoException })],
  ])('never invokes COMSPEC for %s', (_name, resolvedPath, directResult) => {
    restorePlatform = setProcessPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: `${resolvedPath}\r\n` }))
      .mockReturnValueOnce(directResult);

    const result = probeCli('provider');
    expect(result.found).toBe(true);
    expect(result.path).toBe(resolvedPath);
    expect(result.version).toBeUndefined();
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockSpawnSync.mock.calls.every((call) => (call[2] as { shell?: boolean } | undefined)?.shell !== true)).toBe(true);
  });

  it('rejects an unsafe batch path with the fixed degradation error', () => {
    restorePlatform = setProcessPlatform('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'C:\\Tools\\provider&inject.cmd\r\n' }))
      .mockReturnValueOnce(spawnResult({ status: null, signal: null, error: { code: 'EINVAL' } as NodeJS.ErrnoException }));

    expect(probeCli('provider')).toEqual({
      found: true,
      path: 'C:\\Tools\\provider&inject.cmd',
      error: 'version probe skipped: batch path is not literal-safe',
    });
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('preserves the legacy detectAllClis keys', () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));

    expect(Object.keys(detectAllClis())).toEqual(['claude', 'codex', 'gemini', 'cursor', 'grok', 'antigravity']);
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['claude'], expect.objectContaining({ shell: false }));
    expect(mockSpawnSync).toHaveBeenNthCalledWith(6, 'which', ['agy'], expect.objectContaining({ shell: false }));
  });
});
