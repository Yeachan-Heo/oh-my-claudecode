import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');
const PLUGIN_SETUP_PATH = join(PACKAGE_ROOT, 'scripts', 'plugin-setup.mjs');
/**
 * Tests for plugin-setup.mjs dependency installation logic (issue #1113).
 *
 * The plugin cache directory does not include node_modules because npm publish
 * strips it.  plugin-setup.mjs must detect the missing dependencies and run
 * `npm install --omit=dev --ignore-scripts` to restore them.
 */
describe('plugin-setup.mjs dependency installation', () => {
    it('script file exists', () => {
        expect(existsSync(PLUGIN_SETUP_PATH)).toBe(true);
    });
    const scriptContent = existsSync(PLUGIN_SETUP_PATH)
        ? readFileSync(PLUGIN_SETUP_PATH, 'utf-8')
        : '';
    it('imports execSync from child_process', () => {
        expect(scriptContent).toMatch(/import\s*\{[^}]*execSync[^}]*\}\s*from\s*['"]node:child_process['"]/);
    });
    it('checks for node_modules/commander as dependency sentinel', () => {
        expect(scriptContent).toContain("node_modules', 'commander'");
    });
    it('runs npm install with --omit=dev flag', () => {
        expect(scriptContent).toContain('npm install --omit=dev --ignore-scripts');
    });
    it('uses --ignore-scripts to prevent recursive setup', () => {
        // --ignore-scripts must be present to avoid re-triggering plugin-setup.mjs
        const installMatch = scriptContent.match(/npm install[^'"]+/);
        expect(installMatch).not.toBeNull();
        expect(installMatch[0]).toContain('--ignore-scripts');
    });
    it('sets a timeout on execSync to avoid hanging', () => {
        expect(scriptContent).toMatch(/timeout:\s*\d+/);
    });
    it('skips install when node_modules/commander already exists', () => {
        // The script should have a conditional branch that logs "already present"
        expect(scriptContent).toContain('Runtime dependencies already present');
    });
    it('wraps install in try/catch for graceful failure', () => {
        // The install should be wrapped in try/catch so setup continues on failure
        expect(scriptContent).toContain('Could not install dependencies');
    });
});
describe('package.json prepare script removal', () => {
    const pkgPath = join(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    it('does not have a prepare script', () => {
        // prepare was removed to prevent the "prepare trap" where npm install
        // in the plugin cache directory triggers tsc (which requires devDependencies)
        expect(pkg.scripts.prepare).toBeUndefined();
    });
    it('has prepublishOnly with build step', () => {
        // The build step moved from prepare to prepublishOnly so it only runs
        // before npm publish, not on npm install in consumer contexts
        expect(pkg.scripts.prepublishOnly).toContain('npm run build');
    });
});
//# sourceMappingURL=plugin-setup-deps.test.js.map