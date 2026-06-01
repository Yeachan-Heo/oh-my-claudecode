import { afterAll, describe, expect, it } from 'vitest';
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

type NpmPackEntry = {
  path: string;
};

type NpmPackResult = {
  filename?: string;
  files?: NpmPackEntry[];
};

type PackedPackage = {
  files: Set<string>;
  packageJson: PackageJson;
};

const CLI_BIN_TARGET = 'bin/oh-my-claudecode.js';
const SUPPORTED_CLI_ALIASES = ['oh-my-claudecode', 'omc'] as const;

let packedPackageCache: PackedPackage | null = null;
let packDirCache: string | null = null;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

function getPackedPackage(): PackedPackage {
  if (packedPackageCache) {
    return packedPackageCache;
  }

  packDirCache = mkdtempSync(join(tmpdir(), 'omc-pack-metadata-'));
  const stdout = execFileSync(
    'npm',
    ['pack', '--pack-destination', packDirCache, '--json'],
    {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
    },
  );
  const results = JSON.parse(stdout) as NpmPackResult[];
  const tarballName = results[0]?.filename;

  if (!tarballName) {
    throw new Error('npm pack did not report a tarball filename');
  }

  execFileSync('tar', [
    '-xzf',
    join(packDirCache, basename(tarballName)),
    '-C',
    packDirCache,
    'package/package.json',
  ]);

  packedPackageCache = {
    files: new Set((results[0]?.files ?? []).map((file) => file.path)),
    packageJson: JSON.parse(
      readFileSync(join(packDirCache, 'package', 'package.json'), 'utf-8'),
    ) as PackageJson,
  };
  return packedPackageCache;
}

afterAll(() => {
  if (packDirCache) {
    rmSync(packDirCache, { recursive: true, force: true });
  }
});

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
    const packedFiles = getPackedPackage().files;

    expect(packedFiles.has(CLI_BIN_TARGET)).toBe(true);
    expect(packedFiles.has('bridge/cli.cjs')).toBe(true);
  });

  it('executes the shared CLI bin wrapper', () => {
    const stdout = execFileSync(
      process.execPath,
      [CLI_BIN_TARGET, '--version'],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf-8',
      },
    ).trim();

    expect(stdout).toBe(readPackageJson().version);
  });

  it('models npm shim generation for POSIX and Windows command names without installing globally', () => {
    const packageJson = readPackageJson();
    const binNames = Object.entries(packageJson.bin ?? {})
      .filter(([, target]) => target === CLI_BIN_TARGET)
      .map(([name]) => name)
      .sort();

    expect(binNames).toEqual([...SUPPORTED_CLI_ALIASES].sort());
    expect(
      Object.fromEntries(
        binNames.map((name) => [name, expectedNpmShimNames(name)]),
      ),
    ).toEqual({
      'oh-my-claudecode': [
        'oh-my-claudecode',
        'oh-my-claudecode.cmd',
        'oh-my-claudecode.ps1',
      ],
      omc: ['omc', 'omc.cmd', 'omc.ps1'],
    });
  });

  it('keeps the packed package metadata aligned with the source bin aliases and installed npm shims', () => {
    const { packageJson: packedPackageJson } = getPackedPackage();

    for (const alias of SUPPORTED_CLI_ALIASES) {
      expect(packedPackageJson.bin?.[alias]).toBe(CLI_BIN_TARGET);
    }

    const packedBinNames = Object.entries(packedPackageJson.bin ?? {})
      .filter(([, target]) => target === CLI_BIN_TARGET)
      .map(([name]) => name)
      .sort();

    expect(packedBinNames).toEqual([...SUPPORTED_CLI_ALIASES].sort());
    expect(
      Object.fromEntries(
        packedBinNames.map((name) => [name, expectedNpmShimNames(name)]),
      ),
    ).toEqual({
      'oh-my-claudecode': [
        'oh-my-claudecode',
        'oh-my-claudecode.cmd',
        'oh-my-claudecode.ps1',
      ],
      omc: ['omc', 'omc.cmd', 'omc.ps1'],
    });
  });
});
