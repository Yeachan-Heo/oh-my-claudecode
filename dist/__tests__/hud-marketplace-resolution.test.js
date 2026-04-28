import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OMC_PLUGIN_ROOT_ENV } from '../lib/env-vars.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');
const tempDirs = [];
let savedPluginRoot;
beforeEach(() => {
    savedPluginRoot = process.env[OMC_PLUGIN_ROOT_ENV];
    delete process.env[OMC_PLUGIN_ROOT_ENV];
});
afterEach(() => {
    if (savedPluginRoot === undefined)
        delete process.env[OMC_PLUGIN_ROOT_ENV];
    else
        process.env[OMC_PLUGIN_ROOT_ENV] = savedPluginRoot;
});
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
});
// plugin-setup.mjs rewrites hooks/hooks.json with an absolute node binary path
// (it always resolves the path relative to its own __dirname, ignoring CLAUDE_CONFIG_DIR).
// Restore the committed version after all tests in this file so sibling test
// suites (e.g. setup-contracts-regression) don't see a mutated working tree.
afterAll(() => {
    try {
        execFileSync('git', ['checkout', '--', 'hooks/hooks.json'], { cwd: root, stdio: 'pipe' });
    }
    catch {
        // Non-fatal: hooks.json may already be clean or git may be unavailable.
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
        expect(existsSync(join(configDir, 'hud', 'lib', 'config-dir.mjs'))).toBe(true);
        const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'));
        expect(settings.statusLine?.command).toContain(`${join(configDir, 'hud', 'omc-hud.mjs').replace(/\\/g, '/')}`);
        if (process.platform !== 'win32') {
            expect(settings.statusLine?.command).toContain('omc-hud-cache.sh');
            expect(existsSync(join(configDir, 'hud', 'omc-hud-cache.sh'))).toBe(true);
            expect(existsSync(join(configDir, 'hud', 'find-node.sh'))).toBe(true);
        }
        expect(existsSync(join(configDir, '.omc-config.json'))).toBe(true);
        const content = readFileSync(hudScriptPath, 'utf-8');
        expect(content).toContain('import { fileURLToPath, pathToFileURL } from "node:url"');
        expect(content).toContain('const { getClaudeConfigDir } = await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs")).href);');
        expect(content).toContain('await import(pathToFileURL(pluginPath).href);');
        // OMC_PLUGIN_ROOT replaced the legacy devPath branch (binary-weaving-mountain).
        expect(content).toContain('await import(pathToFileURL(envHudPath).href);');
        expect(content).toContain('await import(pathToFileURL(marketplaceHudPath).href);');
        expect(content).not.toContain('await import(pluginPath);');
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
        writeFileSync(join(marketplaceHudDir, 'index.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'marketplace-loaded');\n`);
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
    it('omc-hud.mjs surfaces dynamic import errors from OMC_PLUGIN_ROOT HUD paths', () => {
        const configDir = mkdtempSync(join(tmpdir(), 'omc-hud-import-error-'));
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
        const pluginRoot = join(configDir, 'broken-plugin-root');
        const pluginHudDir = join(pluginRoot, 'dist', 'hud');
        mkdirSync(pluginHudDir, { recursive: true });
        writeFileSync(join(pluginRoot, 'package.json'), '{"type":"module"}\n');
        writeFileSync(join(pluginHudDir, 'index.js'), "import '../platform/index.js';\n");
        const hudScriptPath = join(configDir, 'hud', 'omc-hud.mjs');
        const output = execFileSync(process.execPath, [hudScriptPath], {
            cwd: root,
            env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: configDir,
                HOME: fakeHome,
                OMC_PLUGIN_ROOT: pluginRoot,
                OMC_HUD_DISABLE_NPM_FALLBACK: '1',
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const normalized = output.replace(/\\/g, '/');
        expect(normalized).toContain('[OMC HUD] HUD import failed from');
        expect(normalized).toContain('/broken-plugin-root/dist/hud/index.js');
    });
    it('omc-hud.mjs loads a global npm install outside a Node project via npm prefix resolution', () => {
        const configDir = mkdtempSync(join(tmpdir(), 'omc-hud-global-prefix-'));
        tempDirs.push(configDir);
        const fakeHome = join(configDir, 'home');
        const outsideCwd = join(configDir, 'outside-cwd');
        const npmPrefix = join(configDir, 'global-prefix');
        mkdirSync(fakeHome, { recursive: true });
        mkdirSync(outsideCwd, { recursive: true });
        const sentinelPath = join(configDir, 'global-prefix-loaded.txt');
        const npmRoot = process.platform === 'win32'
            ? join(npmPrefix, 'node_modules')
            : join(npmPrefix, 'lib', 'node_modules');
        const npmPackageRoot = join(npmRoot, 'oh-my-claude-sisyphus');
        const npmHudDir = join(npmPackageRoot, 'dist', 'hud');
        mkdirSync(npmHudDir, { recursive: true });
        writeFileSync(join(npmPackageRoot, 'package.json'), '{"type":"module"}\n');
        writeFileSync(join(npmHudDir, 'index.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'global-prefix-loaded');\n`);
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
            cwd: outsideCwd,
            env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: configDir,
                HOME: fakeHome,
                npm_config_prefix: npmPrefix,
            },
            stdio: 'pipe',
        });
        expect(readFileSync(sentinelPath, 'utf-8')).toBe('global-prefix-loaded');
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
        writeFileSync(join(npmHudDir, 'index.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'npm-package-loaded');\n`);
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
        expect(content.indexOf('"oh-my-claude-sisyphus/dist/hud/index.js"')).toBeLessThan(content.indexOf('"oh-my-claudecode/dist/hud/index.js"'));
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
//# sourceMappingURL=hud-marketplace-resolution.test.js.map