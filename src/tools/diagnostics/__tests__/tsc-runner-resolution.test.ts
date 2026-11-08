import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'child_process';
import { runTscDiagnostics } from '../tsc-runner.js';

const execFileSyncMock = vi.mocked(execFileSync);
const originalPlatform = process.platform;
const originalComspec = process.env.COMSPEC;
const fixtures: string[] = [];

function project(withLocalTypescript: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-tsc-resolution-'));
  fixtures.push(directory);
  writeFileSync(join(directory, 'tsconfig.json'), '{}');
  if (withLocalTypescript) {
    mkdirSync(join(directory, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"5.9.3"}');
    writeFileSync(join(directory, 'node_modules', 'typescript', 'bin', 'tsc'), '');
  }
  return directory;
}

function spawnError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`spawnSync tsc ${code}`), { code, stdout: '', stderr: '', ...extra });
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalComspec === undefined) delete process.env.COMSPEC;
  else process.env.COMSPEC = originalComspec;
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('tsc executable resolution', () => {
  it('runs the project-local TypeScript with node on win32, where a bare `tsc` (tsc.cmd) cannot be spawned', () => {
    setPlatform('win32');
    const directory = project(true);
    // Node cannot spawn the tsc.cmd shim without a shell, so a bare `tsc` is ENOENT on win32.
    execFileSyncMock.mockImplementation((file) => {
      if (file === 'tsc') throw spawnError('ENOENT');
      return '';
    });

    const result = runTscDiagnostics(directory);

    expect(result).toMatchObject({ success: true, errorCount: 0 });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileSyncMock.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([join(directory, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false']);
    expect(options).toMatchObject({ cwd: directory });
    expect(options).not.toHaveProperty('shell');
  });

  it('runs the project-local TypeScript with node on POSIX even when tsc is not on PATH', () => {
    setPlatform('linux');
    const directory = project(true);
    execFileSyncMock.mockImplementation((file) => {
      if (file === 'tsc') throw spawnError('ENOENT');
      return '';
    });

    expect(runTscDiagnostics(directory)).toMatchObject({ success: true, errorCount: 0 });
    expect(execFileSyncMock.mock.calls[0][0]).toBe(process.execPath);
  });

  it('falls back to a PATH tsc through cmd.exe with a fixed command line on win32', () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    const directory = project(false);
    execFileSyncMock.mockReturnValue('');

    expect(runTscDiagnostics(directory)).toMatchObject({ success: true, errorCount: 0 });
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual(['where.exe', ['tsc']]);
    const [file, args, options] = execFileSyncMock.mock.calls[1];
    expect(file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', 'tsc --noEmit --pretty false']);
    expect(options).toMatchObject({ cwd: directory, windowsVerbatimArguments: true });
  });

  it('reports tsc not found (not a clean project) when tsc is not on PATH on win32', () => {
    setPlatform('win32');
    const directory = project(false);
    execFileSyncMock.mockImplementation((file) => {
      // where.exe exits 1 when nothing matches; cmd.exe would also exit 1, indistinguishable from a type error.
      if (file === 'where.exe') throw Object.assign(new Error('Command failed: where.exe tsc'), { status: 1 });
      throw new Error(`unexpected spawn: ${String(file)}`);
    });

    const result = runTscDiagnostics(directory);

    expect(result.success).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.error).toContain('tsc not found');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('reports tsc not found when no local TypeScript exists and tsc is not on PATH on POSIX', () => {
    setPlatform('linux');
    const directory = project(false);
    execFileSyncMock.mockImplementation(() => {
      throw spawnError('ENOENT');
    });

    const result = runTscDiagnostics(directory);

    expect(result.success).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.error).toContain('tsc not found');
    expect(result.error).toContain('ENOENT');
  });

  it('still parses file-position diagnostics from the local compiler', () => {
    setPlatform('win32');
    const directory = project(true);
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        status: 2,
        stdout: "input.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        stderr: '',
      });
    });

    const result = runTscDiagnostics(directory);

    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ file: 'input.ts', line: 1, column: 7, code: 'TS2322' }),
    ]);
  });
});
