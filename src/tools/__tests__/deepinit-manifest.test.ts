/**
 * Tests for deepinit-manifest tool
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1719
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  scanDirectories,
  loadManifest,
  computeDiff,
  isExcluded,
  deepinitManifestTool,
} from '../deepinit-manifest.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

let TEST_DIR: string;

function createTestDir(): string {
  const dir = join(tmpdir(), `deepinit-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFile(relativePath: string, content = ''): void {
  const fullPath = join(TEST_DIR, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

function createManifest(directories: Record<string, { files: string[] }>): void {
  const manifestPath = join(TEST_DIR, '.omc', 'deepinit-manifest.json');
  mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    directories,
  }));
}

// Mock validateWorkingDirectory to return our test dir
import * as worktreePaths from '../../lib/worktree-paths.js';
import { vi } from 'vitest';

vi.mock('../../lib/worktree-paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof worktreePaths>();
  return {
    ...original,
    validateWorkingDirectory: vi.fn(() => TEST_DIR),
  };
});

// =============================================================================
// TESTS: isExcluded
// =============================================================================

describe('isExcluded', () => {
  it('excludes node_modules', () => {
    expect(isExcluded('node_modules')).toBe(true);
  });

  it('excludes hidden directories (starting with .)', () => {
    expect(isExcluded('.git')).toBe(true);
    expect(isExcluded('.omc')).toBe(true);
    expect(isExcluded('.vscode')).toBe(true);
    expect(isExcluded('.github')).toBe(true);
  });

  it('excludes build output directories', () => {
    expect(isExcluded('dist')).toBe(true);
    expect(isExcluded('build')).toBe(true);
    expect(isExcluded('coverage')).toBe(true);
  });

  it('excludes Python virtual environment', () => {
    expect(isExcluded('__pycache__')).toBe(true);
  });

  it('excludes framework output directories', () => {
    expect(isExcluded('.next')).toBe(true);
    expect(isExcluded('.nuxt')).toBe(true);
  });

  it('does not exclude normal directories', () => {
    expect(isExcluded('src')).toBe(false);
    expect(isExcluded('lib')).toBe(false);
    expect(isExcluded('tests')).toBe(false);
    expect(isExcluded('components')).toBe(false);
  });
});

// =============================================================================
// TESTS: scanDirectories
// =============================================================================

describe('scanDirectories', () => {
  beforeEach(() => {
    TEST_DIR = createTestDir();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('scans flat directory correctly', () => {
    createFile('index.ts');
    createFile('utils.ts');

    const result = scanDirectories(TEST_DIR);
    expect(result['.']).toBeDefined();
    expect(result['.'].files).toEqual(['index.ts', 'utils.ts']);
  });

  it('scans nested directories correctly', () => {
    createFile('src/index.ts');
    createFile('src/utils.ts');
    createFile('src/hooks/bridge.ts');

    const result = scanDirectories(TEST_DIR);
    expect(result['src']).toBeDefined();
    expect(result['src'].files).toEqual(['index.ts', 'utils.ts']);
    expect(result['src/hooks']).toBeDefined();
    expect(result['src/hooks'].files).toEqual(['bridge.ts']);
  });

  it('excludes node_modules, .git, hidden dirs, .omc/', () => {
    createFile('src/index.ts');
    createFile('node_modules/pkg/index.js');
    createFile('.git/config');
    createFile('.omc/state/test.json');
    createFile('.vscode/settings.json');

    const result = scanDirectories(TEST_DIR);
    expect(result['node_modules/pkg']).toBeUndefined();
    expect(result['.git']).toBeUndefined();
    expect(result['.omc/state']).toBeUndefined();
    expect(result['.vscode']).toBeUndefined();
    expect(result['src']).toBeDefined();
  });

  it('skips empty directories', () => {
    createFile('src/index.ts');
    mkdirSync(join(TEST_DIR, 'empty-dir'), { recursive: true });

    const result = scanDirectories(TEST_DIR);
    expect(result['empty-dir']).toBeUndefined();
    expect(result['src']).toBeDefined();
  });

  it('file lists are sorted alphabetically', () => {
    createFile('zebra.ts');
    createFile('alpha.ts');
    createFile('middle.ts');

    const result = scanDirectories(TEST_DIR);
    expect(result['.'].files).toEqual(['alpha.ts', 'middle.ts', 'zebra.ts']);
  });

  it('uses / separator on all platforms', () => {
    createFile('src/hooks/bridge.ts');

    const result = scanDirectories(TEST_DIR);
    const paths = Object.keys(result);
    for (const p of paths) {
      expect(p).not.toContain('\\');
    }
    expect(result['src/hooks']).toBeDefined();
  });

  it('handles symlink loops without crashing', () => {
    createFile('src/index.ts');
    try {
      symlinkSync(join(TEST_DIR, 'src'), join(TEST_DIR, 'src', 'loop'), 'dir');
    } catch {
      // Symlinks may not be supported on all systems; skip if so
      return;
    }

    // Should complete without hanging or crashing
    const result = scanDirectories(TEST_DIR);
    expect(result['src']).toBeDefined();
  });
});

// =============================================================================
// TESTS: loadManifest
// =============================================================================

describe('loadManifest', () => {
  beforeEach(() => {
    TEST_DIR = createTestDir();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    const result = loadManifest(join(TEST_DIR, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns manifest when valid', () => {
    const manifest = {
      version: 1,
      generatedAt: '2026-03-17T00:00:00.000Z',
      directories: { '.': { files: ['index.ts'] } },
    };
    const path = join(TEST_DIR, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));

    const result = loadManifest(path);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.directories['.']).toBeDefined();
  });

  it('returns null for invalid JSON', () => {
    const path = join(TEST_DIR, 'bad.json');
    writeFileSync(path, '{ not valid json');

    const result = loadManifest(path);
    expect(result).toBeNull();
  });

  it('returns null for wrong version', () => {
    const path = join(TEST_DIR, 'v2.json');
    writeFileSync(path, JSON.stringify({ version: 99, directories: {} }));

    const result = loadManifest(path);
    expect(result).toBeNull();
  });
});

// =============================================================================
// TESTS: computeDiff
// =============================================================================

describe('computeDiff', () => {
  it('first run (null previous): all directories are added', () => {
    const current = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };

    const result = computeDiff(null, current);
    expect(result.summary.added).toBe(2);
    expect(result.summary.unchanged).toBe(0);
    expect(result.entries.every(e => e.status === 'added')).toBe(true);
  });

  it('no changes: all directories are unchanged', () => {
    const state = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };

    const result = computeDiff(state, state);
    expect(result.summary.unchanged).toBe(2);
    expect(result.summary.added).toBe(0);
    expect(result.summary.modified).toBe(0);
    expect(result.summary.deleted).toBe(0);
  });

  it('file added to directory: marked as modified', () => {
    const previous = { 'src': { files: ['app.ts'] } };
    const current = { 'src': { files: ['app.ts', 'utils.ts'] } };

    const result = computeDiff(previous, current);
    const srcEntry = result.entries.find(e => e.path === 'src');
    expect(srcEntry?.status).toBe('modified');
    expect(srcEntry?.reason).toContain('files added: utils.ts');
  });

  it('file removed from directory: marked as modified', () => {
    const previous = { 'src': { files: ['app.ts', 'old.ts'] } };
    const current = { 'src': { files: ['app.ts'] } };

    const result = computeDiff(previous, current);
    const srcEntry = result.entries.find(e => e.path === 'src');
    expect(srcEntry?.status).toBe('modified');
    expect(srcEntry?.reason).toContain('files removed: old.ts');
  });

  it('new directory: marked as added', () => {
    const previous = { '.': { files: ['index.ts'] } };
    const current = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src')?.status).toBe('added');
  });

  it('deleted directory: marked as deleted', () => {
    const previous = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };
    const current = { '.': { files: ['index.ts'] } };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src')?.status).toBe('deleted');
  });

  it('renamed directory: old deleted, new added', () => {
    const previous = {
      '.': { files: ['index.ts'] },
      'src/auth': { files: ['login.ts'] },
    };
    const current = {
      '.': { files: ['index.ts'] },
      'src/authentication': { files: ['login.ts'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src/auth')?.status).toBe('deleted');
    expect(result.entries.find(e => e.path === 'src/authentication')?.status).toBe('added');
  });

  it('entries are sorted by path', () => {
    const current = {
      'z-dir': { files: ['z.ts'] },
      'a-dir': { files: ['a.ts'] },
      '.': { files: ['root.ts'] },
    };

    const result = computeDiff(null, current);
    const paths = result.entries.map(e => e.path);
    expect(paths).toEqual(['.', 'a-dir', 'z-dir']);
  });
});

// =============================================================================
// TESTS: ancestor cascading
// =============================================================================

describe('ancestor cascading', () => {
  it('child added marks parent as modified', () => {
    const previous = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };
    const current = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
      'src/hooks': { files: ['bridge.ts'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src/hooks')?.status).toBe('added');
    expect(result.entries.find(e => e.path === 'src')?.status).toBe('modified');
    expect(result.entries.find(e => e.path === 'src')?.reason).toContain('child directory added');
  });

  it('child deleted marks parent and root as modified', () => {
    const previous = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
      'src/hooks': { files: ['bridge.ts'] },
    };
    const current = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src/hooks')?.status).toBe('deleted');
    expect(result.entries.find(e => e.path === 'src')?.status).toBe('modified');
  });

  it('multiple children in different subtrees cascade independently', () => {
    const previous = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
      'docs': { files: ['readme.md'] },
    };
    const current = {
      '.': { files: ['index.ts'] },
      'src': { files: ['app.ts'] },
      'src/new-module': { files: ['mod.ts'] },
      'docs': { files: ['readme.md'] },
      'docs/api': { files: ['spec.md'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === 'src')?.status).toBe('modified');
    expect(result.entries.find(e => e.path === 'docs')?.status).toBe('modified');
    expect(result.entries.find(e => e.path === '.')?.status).toBe('modified');
  });

  it('root directory (.) is cascaded when child is added', () => {
    const previous = {
      '.': { files: ['index.ts'] },
    };
    const current = {
      '.': { files: ['index.ts'] },
      'new-dir': { files: ['new.ts'] },
    };

    const result = computeDiff(previous, current);
    expect(result.entries.find(e => e.path === '.')?.status).toBe('modified');
  });
});

// =============================================================================
// TESTS: Tool handler (integration via deepinitManifestTool)
// =============================================================================

describe('deepinitManifestTool handler', () => {
  beforeEach(() => {
    TEST_DIR = createTestDir();
    vi.mocked(worktreePaths.validateWorkingDirectory).mockReturnValue(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('diff action', () => {
    it('no manifest (first run): all directories returned as added', async () => {
      createFile('src/index.ts');

      const result = await deepinitManifestTool.handler({
        action: 'diff',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.manifestExists).toBe(false);
      expect(output.summary.added).toBeGreaterThan(0);
      expect(output.summary.unchanged).toBe(0);
    });

    it('no changes: all directories returned as unchanged', async () => {
      createFile('src/index.ts');
      createManifest({ 'src': { files: ['index.ts'] } });

      const result = await deepinitManifestTool.handler({
        action: 'diff',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.summary.unchanged).toBe(1);
      expect(output.summary.added).toBe(0);
    });

    it('mode=full returns all as added regardless of manifest', async () => {
      createFile('src/index.ts');
      createManifest({ 'src': { files: ['index.ts'] } });

      const result = await deepinitManifestTool.handler({
        action: 'diff',
        mode: 'full',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.summary.added).toBeGreaterThan(0);
      expect(output.summary.unchanged).toBe(0);
    });

    it('corrupted manifest treated as first run', async () => {
      createFile('src/index.ts');
      mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.omc', 'deepinit-manifest.json'), '{ broken json');

      const result = await deepinitManifestTool.handler({
        action: 'diff',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.summary.added).toBeGreaterThan(0);
    });
  });

  describe('save action', () => {
    it('writes valid JSON manifest', async () => {
      createFile('src/index.ts');

      await deepinitManifestTool.handler({
        action: 'save',
        mode: 'incremental',
        dryRun: false,
      });

      const manifestPath = join(TEST_DIR, '.omc', 'deepinit-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.version).toBe(1);
      expect(manifest.directories['src']).toBeDefined();
    });

    it('creates .omc/ directory if missing', async () => {
      createFile('index.ts');

      await deepinitManifestTool.handler({
        action: 'save',
        mode: 'incremental',
        dryRun: false,
      });

      expect(existsSync(join(TEST_DIR, '.omc', 'deepinit-manifest.json'))).toBe(true);
    });

    it('dryRun=true does not write file', async () => {
      createFile('src/index.ts');

      const result = await deepinitManifestTool.handler({
        action: 'save',
        mode: 'incremental',
        dryRun: true,
      });

      expect(result.content[0].text).toContain('Dry run');
      expect(existsSync(join(TEST_DIR, '.omc', 'deepinit-manifest.json'))).toBe(false);
    });
  });

  describe('check action', () => {
    it('returns exists=false when no manifest', async () => {
      const result = await deepinitManifestTool.handler({
        action: 'check',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.exists).toBe(false);
      expect(output.valid).toBe(false);
    });

    it('returns exists=true, valid=true when valid manifest exists', async () => {
      createFile('src/index.ts');
      createManifest({ 'src': { files: ['index.ts'] } });

      const result = await deepinitManifestTool.handler({
        action: 'check',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.exists).toBe(true);
      expect(output.valid).toBe(true);
      expect(output.directoryCount).toBe(1);
    });

    it('returns exists=true, valid=false when manifest is corrupted', async () => {
      mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.omc', 'deepinit-manifest.json'), 'not json');

      const result = await deepinitManifestTool.handler({
        action: 'check',
        mode: 'incremental',
        dryRun: false,
      });

      const output = JSON.parse(result.content[0].text);
      expect(output.exists).toBe(true);
      expect(output.valid).toBe(false);
    });
  });

  describe('per-action parameter validation', () => {
    it('rejects mode with action=save', async () => {
      const result = await deepinitManifestTool.handler({
        action: 'save',
        mode: 'full',
        dryRun: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'mode' parameter is only valid with action='diff'");
    });

    it('rejects dryRun with action=diff', async () => {
      createFile('src/index.ts');

      const result = await deepinitManifestTool.handler({
        action: 'diff',
        mode: 'incremental',
        dryRun: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'dryRun' parameter is only valid with action='save'");
    });
  });
});

// =============================================================================
// TESTS: Performance
// =============================================================================

describe('performance', () => {
  let PERF_DIR: string;

  beforeEach(() => {
    PERF_DIR = createTestDir();
  });

  afterEach(() => {
    rmSync(PERF_DIR, { recursive: true, force: true });
  });

  it('500-directory scan completes in < 2s', () => {
    // Create 500 directories with ~5 files each
    for (let i = 0; i < 500; i++) {
      const dir = join(PERF_DIR, `dir-${String(i).padStart(3, '0')}`);
      mkdirSync(dir, { recursive: true });
      for (let j = 0; j < 5; j++) {
        writeFileSync(join(dir, `file-${j}.ts`), '');
      }
    }

    const start = performance.now();
    const result = scanDirectories(PERF_DIR);
    const elapsed = performance.now() - start;

    expect(Object.keys(result).length).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });

  it('1000-directory diff completes in < 100ms', () => {
    // Generate synthetic manifests
    const dirs: Record<string, { files: string[] }> = {};
    const dirsModified: Record<string, { files: string[] }> = {};
    for (let i = 0; i < 1000; i++) {
      const key = `dir-${String(i).padStart(4, '0')}`;
      const files = Array.from({ length: 10 }, (_, j) => `file-${j}.ts`);
      dirs[key] = { files };
      // Modify 2% of directories
      if (i % 50 === 0) {
        dirsModified[key] = { files: [...files, 'new-file.ts'] };
      } else {
        dirsModified[key] = { files };
      }
    }

    const start = performance.now();
    const result = computeDiff(dirs, dirsModified);
    const elapsed = performance.now() - start;

    expect(result.summary.total).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });

  it('manifest size is reasonable for 500 directories', () => {
    const dirs: Record<string, { files: string[] }> = {};
    for (let i = 0; i < 500; i++) {
      dirs[`dir-${String(i).padStart(3, '0')}`] = {
        files: Array.from({ length: 10 }, (_, j) => `file-${j}.ts`),
      };
    }

    const manifest = JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      directories: dirs,
    });

    // Should be under 100KB
    expect(Buffer.byteLength(manifest)).toBeLessThan(100 * 1024);
  });
});
