import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

describe('HUD build/load guidance', () => {
  it('session-start checks legacy hud script name and build guidance', () => {
    const content = readFileSync(join(root, 'scripts', 'session-start.mjs'), 'utf-8');
    expect(content).toContain("const hudScriptLegacy = join(hudDir, 'omc-hud.js');");
    expect(content).toContain('HUD plugin cache is not built. Run: cd');
    expect(content).toContain('npm install && npm run build');
  });

  it('plugin-setup wrapper resolves marketplace installs before fallback guidance', () => {
    const content = readFileSync(join(root, 'scripts', 'plugin-setup.mjs'), 'utf-8');
    expect(content).toContain('join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js")');
    expect(content).toContain('pathToFileURL(marketplaceHudPath).href');
    expect(content).toContain('"oh-my-claude-sisyphus/dist/hud/index.js"');
    expect(content).toContain('"oh-my-claudecode/dist/hud/index.js"');
    expect(content).toContain('Plugin installed but not built');
    expect(content).toContain('Plugin HUD load failed');
  });

  it('installer wrapper keeps latest-installed fallback context and marketplace resolution', () => {
    const content = readFileSync(join(root, 'src', 'installer', 'index.ts'), 'utf-8');
    expect(content).toContain('const latestInstalledVersion = sortedVersions[0];');
    expect(content).toContain('join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js")');
    expect(content).toContain('pathToFileURL(marketplaceHudPath).href');
    expect(content).toContain('"oh-my-claude-sisyphus/dist/hud/index.js"');
    expect(content).toContain('"oh-my-claudecode/dist/hud/index.js"');
    expect(content).toContain('Plugin HUD load failed');
  });
});
