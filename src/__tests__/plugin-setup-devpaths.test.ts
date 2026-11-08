import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');
const PLUGIN_SETUP_PATH = join(PACKAGE_ROOT, 'scripts', 'plugin-setup.mjs');
const HUD_WRAPPER_TEMPLATE = join(PACKAGE_ROOT, 'scripts', 'lib', 'hud-wrapper-template.txt');

/**
 * Plan binary-weaving-mountain replaced the brittle hardcoded `devPaths`
 * + `OMC_DEV=1` branch with a single `process.env.OMC_PLUGIN_ROOT` resolution
 * step set automatically by `omc --plugin-dir <path>`.
 *
 * This test guards the migration: the dev-paths array must be GONE from
 * both install paths, and the new env-var step must be present in the
 * shared wrapper template.
 */
describe('HUD wrapper devPaths removal (binary-weaving-mountain)', () => {
  it('plugin-setup.mjs no longer contains an inline devPaths array', () => {
    const content = readFileSync(PLUGIN_SETUP_PATH, 'utf-8');
    expect(content).not.toMatch(/const devPaths\s*=\s*\[/);
    expect(content).not.toContain('Workspace/oh-my-claudecode/dist/hud/index.js');
    expect(content).not.toContain('OMC_DEV');
  });

  it('shared HUD wrapper template exists and uses OMC_PLUGIN_ROOT', () => {
    expect(existsSync(HUD_WRAPPER_TEMPLATE)).toBe(true);
    const content = readFileSync(HUD_WRAPPER_TEMPLATE, 'utf-8');
    expect(content).toContain('OMC_PLUGIN_ROOT');
    expect(content).toContain('dist/hud/index.js');
    expect(content).not.toContain('OMC_DEV');
    expect(content).not.toContain('Workspace/oh-my-claudecode');
    expect(content).not.toContain('projects/oh-my-claudecode');
  });
});
