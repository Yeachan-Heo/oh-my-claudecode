import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const repoRoot = new URL('../../..', import.meta.url);
const sessionStartScript = new URL('scripts/session-start.mjs', repoRoot);

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-lazycodex-session-start-'));
  tempRoots.push(root);
  return root;
}

function makeFetchPreload(root: string): string {
  const preload = join(root, 'fetch-preload.mjs');
  writeFileSync(
    preload,
    "globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '99.99.99' }) });\n",
  );
  return preload;
}

function runSessionStart(params: {
  readonly env?: Readonly<Record<string, string>>;
  readonly config?: unknown;
  readonly setup?: (paths: { readonly configDir: string; readonly cwd: string }) => void;
} = {}): {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly configDir: string;
  readonly updateCachePath: string;
} {
  const root = makeTempRoot();
  const home = join(root, 'home');
  const configDir = join(home, '.claude');
  const cwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (params.config !== undefined) {
    writeFileSync(
      join(configDir, '.omc-config.json'),
      JSON.stringify(params.config),
    );
  }
  params.setup?.({ configDir, cwd });

  const result = spawnSync(
    process.execPath,
    ['--import', makeFetchPreload(root), sessionStartScript.pathname],
    {
      cwd,
      input: JSON.stringify({ cwd, session_id: 'sid-t4' }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: repoRoot.pathname,
        ...params.env,
      },
      timeout: 10_000,
    },
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    configDir,
    updateCachePath: join(configDir, '.omc', 'update-check.json'),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('LazyCodex policy gates in the real SessionStart update path', () => {
  it('does not run the update probe without LazyCodex opt-in', () => {
    // Given / When
    const result = runSessionStart();

    // Then
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('[OMC UPDATE AVAILABLE]');
    expect(existsSync(result.updateCachePath)).toBe(false);
  });

  it('does not mutate old plugin cache versions without LazyCodex global-mutation opt-in', () => {
    // Given / When
    const result = runSessionStart({
      setup: ({ configDir }) => {
        const cacheBase = join(configDir, 'plugins', 'cache', 'lazycc', 'lazycc');
        mkdirSync(join(cacheBase, '1.0.0'), { recursive: true });
        mkdirSync(join(cacheBase, '2.0.0'), { recursive: true });
        mkdirSync(join(cacheBase, '3.0.0'), { recursive: true });
      },
    });

    // Then
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(lstatSync(join(
      result.configDir,
      'plugins',
      'cache',
      'lazycc',
      'lazycc',
      '1.0.0',
    )).isSymbolicLink()).toBe(false);
  });

  it('does not run the update probe with explicit false env values', () => {
    // Given / When
    const result = runSessionStart({
      env: {
        OMC_LAZYCODEX_AUTO_UPDATE: 'false',
        OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION: 'false',
        OMC_LAZYCODEX_TELEMETRY: 'false',
      },
    });

    // Then
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('[OMC UPDATE AVAILABLE]');
    expect(existsSync(result.updateCachePath)).toBe(false);
  });

  it('runs the update probe when LazyCodex auto-update is explicitly opted in', () => {
    // Given / When
    const result = runSessionStart({
      config: {
        lazycodex: {
          autoUpdate: true,
        },
      },
    });

    // Then
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[OMC UPDATE AVAILABLE]');
    expect(existsSync(result.updateCachePath)).toBe(true);
  });
});
