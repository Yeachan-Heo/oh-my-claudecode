/**
 * Tests for the HUD wrapper's resolution order, with focus on the new
 * `OMC_PLUGIN_ROOT` env-var step (highest priority).
 *
 * Plan: binary-weaving-mountain.
 *
 * Strategy: write the wrapper template (which is the same byte-for-byte string
 * the installer would write to <configDir>/hud/omc-hud.mjs) into a tmp dir,
 * stage a sibling `lib/config-dir.mjs` and a fake `dist/hud/index.js` marker,
 * then spawn `node <tmp>/omc-hud.mjs` with controlled env + stdin and assert
 * which resolution branch fired (via stdout marker).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';

const CACHE_STUB_MARKER = 'FROM_CACHE_STUB_99_99_99';

/**
 * Build an isolated CLAUDE_CONFIG_DIR with a stub HUD at
 * `<configDir>/plugins/cache/omc/oh-my-claudecode/99.99.99/dist/hud/index.js`.
 * Used to pin the cache-fallback step (step 2 in the wrapper) so tests can
 * assert the wrapper actually executed that branch instead of accidentally
 * matching a globally-installed npm fallback (step 4).
 */
function makeStubConfigDir(rootDir: string): string {
  const configDir = join(rootDir, 'isolated-config');
  const stubDir = join(
    configDir,
    'plugins', 'cache', 'omc', 'oh-my-claudecode', '99.99.99', 'dist', 'hud',
  );
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'index.js'),
    `process.stdout.write(${JSON.stringify(CACHE_STUB_MARKER + '\n')});\n`,
    'utf8',
  );
  return configDir;
}

/**
 * Minimal env that scrubs PATH/NODE_PATH so the wrapper's
 * `getGlobalNodeModuleRoots()` cannot reach a globally-installed
 * `oh-my-claude-sisyphus` and silently satisfy the npm fallback step.
 */
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: tmpdir(),
    NODE_PATH: '',
    ...extra,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATE_TXT = join(REPO_ROOT, 'scripts', 'lib', 'hud-wrapper-template.txt');
const CONFIG_DIR_MJS = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.mjs');

const STDIN_PAYLOAD = JSON.stringify({
  transcript_path: '/dev/null',
  cwd: '/tmp',
  model: { id: 'claude' },
  context_window: 200000,
});

interface StagedWrapper {
  dir: string;
  wrapperPath: string;
  fakePluginRoot: string; // a separate dir with `dist/hud/index.js`
}

function stage(): StagedWrapper {
  const dir = mkdtempSync(join(tmpdir(), 'omc-hud-wrapper-'));
  const libDir = join(dir, 'lib');
  mkdirSync(libDir, { recursive: true });

  // Stage the sibling config-dir.mjs that the wrapper imports.
  copyFileSync(CONFIG_DIR_MJS, join(libDir, 'config-dir.mjs'));

  // Write the wrapper itself (same content the installer emits).
  const wrapperPath = join(dir, 'omc-hud.mjs');
  const body = readFileSync(TEMPLATE_TXT, 'utf8');
  writeFileSync(wrapperPath, body, 'utf8');

  // Build a fake plugin root with a marker dist/hud/index.js.
  const fakePluginRoot = join(dir, 'fake-plugin-root');
  const fakeHudDir = join(fakePluginRoot, 'dist', 'hud');
  mkdirSync(fakeHudDir, { recursive: true });
  writeFileSync(
    join(fakeHudDir, 'index.js'),
    'process.stdout.write("FROM_OMC_PLUGIN_ROOT\\n");\n',
    'utf8',
  );

  return { dir, wrapperPath, fakePluginRoot };
}

function runWrapper(wrapperPath: string, env: Record<string, string | undefined>) {
  // Sanitize env: drop undefined keys.
  const finalEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') finalEnv[k] = v;
  }
  return spawnSync(process.execPath, [wrapperPath], {
    input: STDIN_PAYLOAD,
    encoding: 'utf8',
    env: finalEnv,
    timeout: 15000,
  });
}

describe('HUD wrapper — OMC_PLUGIN_ROOT resolution', () => {
  let staged: StagedWrapper | null = null;

  beforeEach(() => {
    staged = stage();
  });
  afterEach(() => {
    if (staged) {
      rmSync(staged.dir, { recursive: true, force: true });
      staged = null;
    }
  });

  it('case 1: OMC_PLUGIN_ROOT set + dist/hud/index.js exists → loads from there', () => {
    const s = staged!;
    // Point CLAUDE_CONFIG_DIR at a non-existent dir so cache/marketplace branches
    // cannot accidentally fire.
    const isolatedConfig = join(s.dir, 'isolated-config');
    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: isolatedConfig,
      [OMC_PLUGIN_ROOT_ENV]: s.fakePluginRoot,
    }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FROM_OMC_PLUGIN_ROOT');
    // Pin: step 1 (OMC_PLUGIN_ROOT) fired, not the cache stub.
    expect(result.stdout).not.toContain(CACHE_STUB_MARKER);
  });

  it('case 2: OMC_PLUGIN_ROOT set but dist/hud/index.js missing → falls through to cache step', () => {
    const s = staged!;
    const isolatedConfig = makeStubConfigDir(s.dir);
    // pluginRoot has no dist/hud/index.js
    const emptyRoot = join(s.dir, 'empty-root');
    mkdirSync(emptyRoot, { recursive: true });
    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: isolatedConfig,
      [OMC_PLUGIN_ROOT_ENV]: emptyRoot,
    }));
    expect(result.status).toBe(0);
    // Pin: step 1 fell through, step 2 (cache) fired.
    expect(result.stdout).not.toContain('FROM_OMC_PLUGIN_ROOT');
    expect(result.stdout).toContain(CACHE_STUB_MARKER);
    expect(result.stderr ?? '').not.toMatch(/Error|throw/i);
  });

  it('case 3: OMC_PLUGIN_ROOT unset → cache step (step 2) fires', () => {
    const s = staged!;
    const isolatedConfig = makeStubConfigDir(s.dir);
    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: isolatedConfig,
      // OMC_PLUGIN_ROOT intentionally omitted
    }));
    expect(result.status).toBe(0);
    // Pin: step 1 skipped (env unset), step 2 (cache) fired.
    expect(result.stdout).not.toContain('FROM_OMC_PLUGIN_ROOT');
    expect(result.stdout).toContain(CACHE_STUB_MARKER);
    expect(result.stderr ?? '').not.toMatch(/Error|throw/i);
  });

  it('case 4: OMC_PLUGIN_ROOT points at a non-existent dir → cache step fires', () => {
    const s = staged!;
    const isolatedConfig = makeStubConfigDir(s.dir);
    const ghostRoot = join(s.dir, 'does-not-exist-anywhere');
    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: isolatedConfig,
      [OMC_PLUGIN_ROOT_ENV]: ghostRoot,
    }));
    expect(result.status).toBe(0);
    // Pin: step 1 fell through (ghost path), step 2 (cache) fired.
    expect(result.stdout).not.toContain('FROM_OMC_PLUGIN_ROOT');
    expect(result.stdout).toContain(CACHE_STUB_MARKER);
    expect(result.stderr ?? '').not.toMatch(/Error|throw/i);
  });

  it('case 6: cache step is semver-aware — stable beats prerelease with same [M.m.p]', () => {
    const s = staged!;
    const configDir = join(s.dir, 'isolated-config-semver');
    const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    // Two versions: 1.0.0-alpha (should lose) and 1.0.0 (should win).
    // A naive localeCompare(numeric) sort places "1.0.0-alpha" > "1.0.0" and picks the prerelease.
    const stableDir = join(cacheBase, '1.0.0', 'dist', 'hud');
    const preDir = join(cacheBase, '1.0.0-alpha', 'dist', 'hud');
    mkdirSync(stableDir, { recursive: true });
    mkdirSync(preDir, { recursive: true });
    writeFileSync(
      join(stableDir, 'index.js'),
      'process.stdout.write("FROM_STABLE_1_0_0\\n");\n',
      'utf8',
    );
    writeFileSync(
      join(preDir, 'index.js'),
      'process.stdout.write("FROM_PRERELEASE_1_0_0_ALPHA\\n");\n',
      'utf8',
    );

    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: configDir,
      // OMC_PLUGIN_ROOT intentionally omitted → cache step fires
    }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FROM_STABLE_1_0_0');
    expect(result.stdout).not.toContain('FROM_PRERELEASE_1_0_0_ALPHA');
  });

  it('case 7: cache step orders prerelease tags numerically — rc.10 beats rc.2', () => {
    const s = staged!;
    const configDir = join(s.dir, 'isolated-config-pre-numeric');
    const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    // Two prerelease-only versions with the same [M.m.p]. A naive localeCompare
    // without { numeric: true } places "rc.2" above "rc.10".
    const rc10Dir = join(cacheBase, '1.0.0-rc.10', 'dist', 'hud');
    const rc2Dir = join(cacheBase, '1.0.0-rc.2', 'dist', 'hud');
    mkdirSync(rc10Dir, { recursive: true });
    mkdirSync(rc2Dir, { recursive: true });
    writeFileSync(
      join(rc10Dir, 'index.js'),
      'process.stdout.write("FROM_RC_10\\n");\n',
      'utf8',
    );
    writeFileSync(
      join(rc2Dir, 'index.js'),
      'process.stdout.write("FROM_RC_2\\n");\n',
      'utf8',
    );

    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: configDir,
    }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FROM_RC_10');
    expect(result.stdout).not.toContain('FROM_RC_2');
  });

  it('case 8: cache step falls back to older built version when latest built version fails to import', () => {
    const s = staged!;
    const configDir = join(s.dir, 'isolated-config-cache-fallback');
    const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');

    const latestBrokenDir = join(cacheBase, '4.11.3', 'dist', 'hud');
    const olderWorkingDir = join(cacheBase, '4.11.2', 'dist', 'hud');
    mkdirSync(latestBrokenDir, { recursive: true });
    mkdirSync(olderWorkingDir, { recursive: true });

    writeFileSync(
      join(latestBrokenDir, 'index.js'),
      'throw new Error("BROKEN_4_11_3");\n',
      'utf8',
    );
    writeFileSync(
      join(olderWorkingDir, 'index.js'),
      'process.stdout.write("FROM_OLDER_WORKING_VERSION\\n");\n',
      'utf8',
    );

    const result = runWrapper(s.wrapperPath, scrubbedEnv({
      CLAUDE_CONFIG_DIR: configDir,
      // OMC_PLUGIN_ROOT intentionally omitted → cache step fires
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FROM_OLDER_WORKING_VERSION');
    expect(result.stderr ?? '').not.toMatch(/Error|throw/i);
  });

  it('case 5: symmetry — installer source and plugin-setup.mjs both produce identical wrapper text', async () => {
    // Both consumers must read the same byte-for-byte template body.
    const txt = readFileSync(TEMPLATE_TXT, 'utf8');

    // (a) plugin-setup.mjs path: import buildHudWrapper() from the .mjs entrypoint
    const tplMod = await import(
      /* @vite-ignore */ `file://${join(REPO_ROOT, 'scripts', 'lib', 'hud-wrapper-template.mjs')}`
    );
    const fromMjs = tplMod.buildHudWrapper();

    // (b) installer/index.ts path: it does `readFileSync(...txt, 'utf8')` directly
    const fromInstaller = readFileSync(TEMPLATE_TXT, 'utf8');

    expect(fromMjs).toBe(txt);
    expect(fromInstaller).toBe(txt);
    expect(fromMjs).toBe(fromInstaller);

    // Spot-check: critical invariants of the new wrapper
    expect(txt).toContain('OMC_PLUGIN_ROOT');
    expect(txt).not.toContain('OMC_DEV');
    expect(txt).not.toContain('Workspace/oh-my-claudecode');
    expect(txt).not.toContain('projects/oh-my-claudecode');
  });
});

describe('HUD wrapper — fixture sanity', () => {
  it('the template txt file exists in the repo', () => {
    expect(existsSync(TEMPLATE_TXT)).toBe(true);
  });
});
