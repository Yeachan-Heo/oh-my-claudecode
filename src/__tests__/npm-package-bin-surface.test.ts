import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  PLUGIN_JSON_PATH,
  listSourceControlledPackageFiles,
  readMcpServersFromPath,
  readPluginMcpServers,
  referencesRootMcpConfig,
  referencesStandardHooksManifest,
  type McpServerConfig,
  type PluginJson,
} from './npm-package-surface-helpers.js';

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
  pluginJson: PluginJson;
  mcpServers: Record<string, McpServerConfig>;
  startedWithoutGeneratedBundles: boolean;
};

const CLI_BIN_TARGET = 'bin/oh-my-claudecode.js';
const SUPPORTED_CLI_ALIASES = ['oh-my-claudecode', 'omc'] as const;
const GENERATED_BRIDGE_FILES = new Set([
  'bridge/claude-md-coordinator.cjs',
  'bridge/cli.cjs',
  'bridge/mcp-server.cjs',
  'bridge/runtime-cli.cjs',
  'bridge/team-bridge.cjs',
  'bridge/team-mcp.cjs',
  'bridge/team.js',
]);

let packedPackageCache: PackedPackage | null = null;
let packedPackageError: unknown = null;
let packedPackageInitialized = false;
let fixtureRootCache: string | null = null;
let packDirCache: string | null = null;
let packWorkspaceCache: string | null = null;
let tarballPathCache: string | null = null;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

function createIsolatedPackWorkspace(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });

  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: PACKAGE_ROOT, encoding: 'utf-8' },
  )
    .split('\0')
    .filter(Boolean);

  for (const relativePath of files) {
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      normalized === '.gjc' ||
      normalized.startsWith('.gjc/') ||
      normalized === '.omc' ||
      normalized.startsWith('.omc/') ||
      GENERATED_BRIDGE_FILES.has(normalized) ||
      normalized === 'dist' ||
      normalized.startsWith('dist/') ||
      normalized.endsWith('.tgz')
    ) {
      continue;
    }

    const destination = join(workspacePath, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(PACKAGE_ROOT, relativePath), destination, {
      dereference: false,
      preserveTimestamps: true,
    });
  }

  symlinkSync(
    join(PACKAGE_ROOT, 'node_modules'),
    join(workspacePath, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function getPackedPackage(): PackedPackage {
  if (packedPackageInitialized) {
    if (packedPackageError !== null) {
      throw packedPackageError;
    }
    if (!packedPackageCache) {
      throw new Error('npm pack fixture initialized without a result');
    }
    return packedPackageCache;
  }
  packedPackageInitialized = true;

  try {
    const packageJson = readPackageJson();
    if (!packageJson.name || !packageJson.version) {
      throw new Error('package.json must define a name and version');
    }
    fixtureRootCache = mkdtempSync(join(tmpdir(), 'omc-pack-fixture-'));
    packWorkspaceCache = join(fixtureRootCache, 'workspace');
    packDirCache = join(fixtureRootCache, 'packed');
    createIsolatedPackWorkspace(packWorkspaceCache);
    const startedWithoutGeneratedBundles = [...GENERATED_BRIDGE_FILES].every(
      (file) => !existsSync(join(packWorkspaceCache!, file)),
    );
    mkdirSync(packDirCache, { recursive: true });

    const stdout = execFileSync(
      'npm',
      ['pack', '--pack-destination', packDirCache, '--silent'],
      {
        cwd: packWorkspaceCache,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
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
      .map((file) => file.replace(/^package\//, ''));

    execFileSync('tar', [
      '-xzf',
      tarballPathCache,
      '-C',
      packDirCache,
      'package/package.json',
      'package/.claude-plugin/plugin.json',
      'package/.mcp.json',
      'package/agents',
      'package/bridge/cli.cjs',
      'package/bridge/runtime-cli.cjs',
      'package/bridge/team.js',
    ]);

    const extractedPackageRoot = join(packDirCache, 'package');
    packedPackageCache = {
      files: new Set(files),
      packageJson: JSON.parse(
        readFileSync(join(extractedPackageRoot, 'package.json'), 'utf-8'),
      ) as PackageJson,
      pluginJson: JSON.parse(
        readFileSync(
          join(extractedPackageRoot, '.claude-plugin', 'plugin.json'),
          'utf-8',
        ),
      ) as PluginJson,
      mcpServers: readMcpServersFromPath(
        join(extractedPackageRoot, '.mcp.json'),
      ),
      startedWithoutGeneratedBundles,
    };
    return packedPackageCache;
  } catch (error) {
    packedPackageError = error;
    throw error;
  }
}

afterAll(() => {
  if (fixtureRootCache) {
    rmSync(fixtureRootCache, { recursive: true, force: true });
  }
});

// Build the single lifecycle tarball during file setup so individual assertions
// retain the repository-wide 30-second test budget. Any setup failure still
// aborts this file and is cached to prevent a second pack attempt.
const packedPackageFixture = getPackedPackage();

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
    const packedFiles = packedPackageFixture.files;

    expect(packedFiles.has(CLI_BIN_TARGET)).toBe(true);
    expect(packedFiles.has('dist/hooks/skill-bridge.cjs')).toBe(true);
    expect(packedFiles.has('bridge/cli.cjs')).toBe(true);
    expect(packedFiles.has('bridge/claude-md-coordinator.cjs')).toBe(true);
    expect(packedFiles.has('bridge/mcp-server.cjs')).toBe(true);
    expect(packedFiles.has('bridge/runtime-cli.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team-bridge.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team-mcp.cjs')).toBe(true);
    expect(packedFiles.has('bridge/team.js')).toBe(true);
    expect(packedFiles.has('bridge/gyoshu_bridge.py')).toBe(true);
    expect(packedFiles.has('bridge/run-mcp-server.sh')).toBe(true);
  });

  it('rebuilds recovery CLI surfaces from source without committed bundles', () => {
    expect(packedPackageFixture.startedWithoutGeneratedBundles).toBe(true);

    const packedCli = join(packDirCache!, 'package', 'bridge', 'cli.cjs');
    const apiHelp = execFileSync(
      process.execPath,
      [packedCli, 'team', 'api', '--help'],
      { cwd: tmpdir(), encoding: 'utf-8' },
    );

    expect(apiHelp).toContain('recover-worker');
    expect(apiHelp).toContain('write-task-checkpoint');
    expect(apiHelp).toContain('read-recovery-result');

    const resultHelp = execFileSync(
      process.execPath,
      [packedCli, 'team', 'api', 'read-recovery-result', '--help'],
      { cwd: tmpdir(), encoding: 'utf-8' },
    );
    expect(resultHelp).toContain('team_name');
    expect(resultHelp).toContain('request_id');
  });

  it('packs the complete source-controlled plugin and hook payload', () => {
    const packedFiles = packedPackageFixture.files;
    const missing = listSourceControlledPackageFiles().filter(
      (file) => !packedFiles.has(file),
    );

    expect(missing).toEqual([]);
  });

  it('keeps packed plugin and MCP manifests wired to exact standard entrypoints', () => {
    const sourcePluginJson = JSON.parse(
      readFileSync(PLUGIN_JSON_PATH, 'utf-8'),
    ) as PluginJson;

    expect(packedPackageFixture.pluginJson).toEqual(sourcePluginJson);
    expect(
      referencesStandardHooksManifest(packedPackageFixture.pluginJson.hooks),
    ).toBe(false);
    expect(
      referencesRootMcpConfig(packedPackageFixture.pluginJson.mcpServers),
    ).toBe(true);

    expect(packedPackageFixture.mcpServers).toEqual(readPluginMcpServers());
    expect(Object.values(packedPackageFixture.mcpServers)).toEqual([
      {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'],
      },
    ]);
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
    const { packageJson: packedPackageJson } = packedPackageFixture;

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
