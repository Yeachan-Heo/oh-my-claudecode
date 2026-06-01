import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const PACKAGE_ROOT = process.cwd();
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, 'package.json');

type PackageJson = {
  bin?: Record<string, string>;
  version?: string;
};

type NpmPackDryRunEntry = {
  path: string;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunEntry[];
};

const CLI_BIN_TARGET = 'bin/oh-my-claudecode.js';
const SUPPORTED_CLI_ALIASES = ['oh-my-claudecode', 'omc'] as const;

let packedFilesCache: Set<string> | null = null;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

function getPackedFiles(): Set<string> {
  if (packedFilesCache) {
    return packedFilesCache;
  }

  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
  });
  const results = JSON.parse(stdout) as NpmPackDryRunResult[];
  packedFilesCache = new Set((results[0]?.files ?? []).map(file => file.path));
  return packedFilesCache;
}

function expectedNpmShimNames(binName: string): string[] {
  return [binName, `${binName}.cmd`, `${binName}.ps1`];
}

describe('npm package bin surface regression', () => {
  it('publishes both long and short OMC command aliases to the same CLI entrypoint', () => {
    const packageJson = readPackageJson();

    for (const alias of SUPPORTED_CLI_ALIASES) {
      expect(packageJson.bin?.[alias]).toBe(CLI_BIN_TARGET);
    }
  });

  it('packs the shared CLI bin target and bundled bridge implementation', () => {
    const packedFiles = getPackedFiles();

    expect(packedFiles.has(CLI_BIN_TARGET)).toBe(true);
    expect(packedFiles.has('bridge/cli.cjs')).toBe(true);
  });

  it('executes the shared CLI bin wrapper', () => {
    const stdout = execFileSync(process.execPath, [CLI_BIN_TARGET, '--version'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
    }).trim();

    expect(stdout).toBe(readPackageJson().version);
  });

  it('models npm shim generation for POSIX and Windows command names without installing globally', () => {
    const packageJson = readPackageJson();
    const binNames = Object.entries(packageJson.bin ?? {})
      .filter(([, target]) => target === CLI_BIN_TARGET)
      .map(([name]) => name)
      .sort();

    expect(binNames).toEqual([...SUPPORTED_CLI_ALIASES].sort());
    expect(Object.fromEntries(binNames.map(name => [name, expectedNpmShimNames(name)]))).toEqual({
      'oh-my-claudecode': ['oh-my-claudecode', 'oh-my-claudecode.cmd', 'oh-my-claudecode.ps1'],
      omc: ['omc', 'omc.cmd', 'omc.ps1'],
    });
  });

  it('keeps the packed package metadata aligned with the source bin aliases and installed npm shims', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'omc-pack-metadata-'));

    try {
      const tarballName = execFileSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf-8',
      }).trim();
      execFileSync('tar', ['-xzf', join(packDir, basename(tarballName)), '-C', packDir, 'package/package.json']);

      const packedPackageJson = JSON.parse(
        readFileSync(join(packDir, 'package', 'package.json'), 'utf-8'),
      ) as PackageJson;

      for (const alias of SUPPORTED_CLI_ALIASES) {
        expect(packedPackageJson.bin?.[alias]).toBe(CLI_BIN_TARGET);
      }

      const installPrefix = join(packDir, 'install');
      execFileSync('npm', ['install', '--prefix', installPrefix, join(packDir, basename(tarballName)), '--silent'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf-8',
      });

      for (const alias of SUPPORTED_CLI_ALIASES) {
        const shimName = process.platform === 'win32' ? `${alias}.cmd` : alias;
        const stdout = execFileSync(join(installPrefix, 'node_modules', '.bin', shimName), ['--version'], {
          encoding: 'utf-8',
        }).trim();
        expect(stdout).toBe(readPackageJson().version);
      }
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
