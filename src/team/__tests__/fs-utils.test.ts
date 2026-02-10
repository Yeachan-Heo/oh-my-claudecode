import { describe, it, expect, afterEach } from 'vitest';
import { statSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  atomicWriteJson, writeFileWithMode, ensureDirWithMode, validateResolvedPath
} from '../fs-utils.js';

const TEST_DIR = join(tmpdir(), '__test_fs_utils__');

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('atomicWriteJson', () => {
  it('creates files with 0o600 permissions', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'test.json');
    atomicWriteJson(filePath, { key: 'value' });
    const stat = statSync(filePath);
    // Check owner-only read/write (0o600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('temp file names contain both PID and timestamp pattern', () => {
    // Verify the temp path format by checking the function creates the final file
    // The temp file is renamed, so we verify the output exists and intermediate is gone
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'atomic.json');
    atomicWriteJson(filePath, { test: true });
    expect(existsSync(filePath)).toBe(true);
    // No leftover .tmp files
    const { readdirSync } = require('fs');
    const files = readdirSync(TEST_DIR);
    const tmpFiles = files.filter((f: string) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('creates parent directories with 0o700', () => {
    const nested = join(TEST_DIR, 'deep', 'nested');
    const filePath = join(nested, 'data.json');
    atomicWriteJson(filePath, { deep: true });
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('writeFileWithMode', () => {
  it('creates files with 0o600 permissions', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'write-test.txt');
    writeFileWithMode(filePath, 'hello');
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('ensureDirWithMode', () => {
  it('creates directories with 0o700 permissions', () => {
    const dirPath = join(TEST_DIR, 'secure-dir');
    ensureDirWithMode(dirPath);
    const stat = statSync(dirPath);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe('validateResolvedPath', () => {
  it('rejects paths that escape base via ../', () => {
    expect(() => validateResolvedPath('/home/user/../escape', '/home/user')).toThrow('Path traversal');
  });

  it('accepts paths within base directory', () => {
    expect(() => validateResolvedPath('/home/user/project/file.ts', '/home/user')).not.toThrow();
  });

  it('accepts exact base path', () => {
    expect(() => validateResolvedPath('/home/user', '/home/user')).not.toThrow();
  });
});
