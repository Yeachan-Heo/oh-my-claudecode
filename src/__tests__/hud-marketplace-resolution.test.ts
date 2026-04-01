import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('HUD marketplace resolution', () => {
  it('omc-hud.mjs converts absolute HUD paths to file URLs before dynamic imports', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'omc-hud-wrapper-'));
    tempDirs.push(configDir);

    const fakeHome = join(configDir, 'home');
    mkdirSync(fakeHome, { recursive: true });

    execFileSync(process.execPath, [join(root, 'scripts', 'plugin-setup.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    const hudScriptPath = join(configDir, 'hud', 'omc-hud.mjs');
    expect(existsSync(hudScriptPath)).toBe(true);

    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')) as {
      statusLine?: { command?: string };
    };
    expect(settings.statusLine?.command).toContain(`${join(configDir, 'hud', 'omc-hud.mjs').replace(/\\/g, '/')}`);
    expect(existsSync(join(configDir, '.omc-config.json'))).toBe(true);

    const content = readFileSync(hudScriptPath, 'utf-8');
    expect(content).toContain('import { pathToFileURL } from "node:url"');
    expect(content).toContain('await import(pathToFileURL(pluginPath).href);');
    expect(content).toContain('await import(pathToFileURL(devPath).href);');
    expect(content).toContain('await import(pathToFileURL(marketplaceHudPath).href);');
    expect(content).not.toContain('await import(pluginPath);');
    expect(content).not.toContain('await import(devPath);');
    expect(content).not.toContain('await import(marketplaceHudPath);');
  });

  it('omc-hud.mjs loads a marketplace install when plugin cache is unavailable', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'omc-hud-marketplace-'));
    tempDirs.push(configDir);

    const fakeHome = join(configDir, 'home');
    mkdirSync(fakeHome, { recursive: true });

    const sentinelPath = join(configDir, 'marketplace-loaded.txt');
    const marketplaceRoot = join(configDir, 'plugins', 'marketplaces', 'omc');
    const marketplaceHudDir = join(marketplaceRoot, 'dist', 'hud');
    mkdirSync(marketplaceHudDir, { recursive: true });
    writeFileSync(join(marketplaceRoot, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(marketplaceHudDir, 'index.js'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'marketplace-loaded');\n`
    );

    execFileSync(process.execPath, [join(root, 'scripts', 'plugin-setup.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    const hudScriptPath = join(configDir, 'hud', 'omc-hud.mjs');
    expect(existsSync(hudScriptPath)).toBe(true);

    execFileSync(process.execPath, [hudScriptPath], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    expect(readFileSync(sentinelPath, 'utf-8')).toBe('marketplace-loaded');
  });

  it('omc-hud.mjs loads the published npm package name before the branded fallback', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'omc-hud-npm-package-'));
    tempDirs.push(configDir);

    const fakeHome = join(configDir, 'home');
    mkdirSync(fakeHome, { recursive: true });

    const sentinelPath = join(configDir, 'npm-package-loaded.txt');
    const npmPackageRoot = join(configDir, 'node_modules', 'oh-my-claude-sisyphus');
    const npmHudDir = join(npmPackageRoot, 'dist', 'hud');
    mkdirSync(npmHudDir, { recursive: true });
    writeFileSync(join(npmPackageRoot, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(npmHudDir, 'index.js'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'npm-package-loaded');\n`
    );

    execFileSync(process.execPath, [join(root, 'scripts', 'plugin-setup.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    const hudScriptPath = join(configDir, 'hud', 'omc-hud.mjs');
    expect(existsSync(hudScriptPath)).toBe(true);

    const content = readFileSync(hudScriptPath, 'utf-8');
    expect(content).toContain('"oh-my-claude-sisyphus/dist/hud/index.js"');
    expect(content).toContain('"oh-my-claudecode/dist/hud/index.js"');
    expect(content.indexOf('"oh-my-claude-sisyphus/dist/hud/index.js"')).toBeLessThan(
      content.indexOf('"oh-my-claudecode/dist/hud/index.js"')
    );

    execFileSync(process.execPath, [hudScriptPath], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      stdio: 'pipe',
    });

    expect(readFileSync(sentinelPath, 'utf-8')).toBe('npm-package-loaded');
  });
});
