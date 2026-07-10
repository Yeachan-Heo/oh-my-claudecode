import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const PACKAGE_ROOT = process.cwd();
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, 'package.json');

type PackageJson = {
  bin?: Record<string, string>;
  name?: string;
  version?: string;
};

type PackedPackage = {
  files: Set<string>;
  packageJson: PackageJson;
};

const CLI_BIN_TARGET = 'bin/oh-my-claudecode.js';
const SUPPORTED_CLI_ALIASES = ['oh-my-claudecode', 'omc'] as const;

let packedPackageCache: PackedPackage | null = null;
let packDirCache: string | null = null;
let tarballPathCache: string | null = null;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

function getPackedPackage(): PackedPackage {
  if (packedPackageCache) {
    return packedPackageCache;
  }

  const packageJson = readPackageJson();
  if (!packageJson.name || !packageJson.version) {
    throw new Error('package.json must define a name and version');
  }
  packDirCache = mkdtempSync(join(tmpdir(), 'omc-pack-metadata-'));

  const stdout = execFileSync('npm', ['pack', '--pack-destination', packDirCache, '--silent'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const expectedTarballName = `${packageJson.name.replace(/^@/, '').replace(/\//g, '-')}-${packageJson.version}.tgz`;
  expect([
    expectedTarballName,
    `${expectedTarballName}\n`,
    `${expectedTarballName}\r\n`,
  ]).toContain(stdout);

  const tarballName = stdout.replace(/\r?\n$/, '');
  expect(tarballName).toBe(expectedTarballName);
  expect(basename(tarballName)).toBe(tarballName);
  expect(tarballName).not.toMatch(/[\\/]/);

  tarballPathCache = join(packDirCache, tarballName);
  const files = execFileSync('tar', ['-tzf', tarballPathCache], {
    encoding: 'utf-8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(file => file.replace(/^package\//, ''));

  execFileSync('tar', [
    '-xzf',
    tarballPathCache,
    '-C',
    packDirCache,
    'package/package.json',
  ]);

  packedPackageCache = {
    files: new Set(files),
    packageJson: JSON.parse(
      readFileSync(join(packDirCache, 'package', 'package.json'), 'utf-8'),
    ) as PackageJson,
  };
  return packedPackageCache;
}

afterAll(() => {
  if (tarballPathCache) {
    rmSync(tarballPathCache, { force: true });
  }
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

  it('packs the CLI bin target and generated runtime entrypoints', () => {
    const packedFiles = getPackedPackage().files;

    expect(packedFiles.has(CLI_BIN_TARGET)).toBe(true);
    expect(packedFiles.has('dist/hooks/skill-bridge.cjs')).toBe(true);
    expect(packedFiles.has('bridge/cli.cjs')).toBe(true);
    expect(packedFiles.has('bridge/claude-md-coordinator.cjs')).toBe(true);
    expect(packedFiles.has('bridge/mcp-server.cjs')).toBe(true);
    expect(packedFiles.has('bridge/runtime-cli.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team-bridge.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team-mcp.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team.js')).toBe(true);
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
