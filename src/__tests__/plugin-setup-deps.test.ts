import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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
    const installMatches = scriptContent.match(/npm install[^'"]+/g) || [];
    expect(installMatches.length).toBeGreaterThan(0);
    expect(installMatches.some(m => m.includes('--ignore-scripts'))).toBe(true);
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

  it('patches installed package hook commands so they start with an absolute node path under an empty PATH', () => {
    if (process.platform === 'win32') {
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-setup-installed-'));
    let tarballPath: string | undefined;
    try {
      const projectDir = join(tempRoot, 'project');
      const configDir = join(tempRoot, 'claude');
      const pathNodeDir = join(tempRoot, 'bin');
      const pathNode = join(pathNodeDir, 'node');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      mkdirSync(pathNodeDir, { recursive: true });
      symlinkSync(process.execPath, pathNode);

      const packOutput = execFileSync('npm', ['pack', '--json'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      });
      const packed = JSON.parse(packOutput) as Array<{ readonly filename: string }>;
      tarballPath = resolve(PACKAGE_ROOT, packed[0]?.filename ?? '');
      expect(tarballPath).not.toBe(PACKAGE_ROOT);

      execFileSync('npm', ['install', '--prefix', projectDir, '--omit=dev', '--ignore-scripts', tarballPath], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      });

      const pluginRoot = join(projectDir, 'node_modules', 'lazycc');
      execFileSync(process.execPath, [join(pluginRoot, 'scripts', 'plugin-setup.mjs')], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          PATH: `${pathNodeDir}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
      });

      const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const commands = Object.values(hooksJson.hooks)
        .flatMap((groups) => groups)
        .flatMap((group) => group.hooks)
        .map((hook) => hook.command);
      const command = commands.find((candidate) => candidate.includes('lazycodex-compat-hook.mjs'));

      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((candidate) => candidate.startsWith(`"${pathNode}" `))).toBe(true);
      expect(command).toBeDefined();

      const runtime = spawnSync('/bin/sh', ['-c', command ?? ''], {
        cwd: projectDir,
        env: {
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          HOME: process.env.HOME ?? tempRoot,
          PATH: '',
        },
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'installed-empty-path-test',
          cwd: projectDir,
          prompt: 'ordinary packaged prompt',
        }),
        encoding: 'utf8',
      });

      expect(runtime.status).toBe(0);
      expect(runtime.stderr).toBe('');
      expect(JSON.parse(runtime.stdout)).toMatchObject({
        continue: true,
        lazycodexCompat: {
          normalized: {
            eventName: 'UserPromptSubmit',
            portableEventId: 'prompt-submitted',
          },
        },
      });
    } finally {
      if (tarballPath) {
        rmSync(tarballPath, { force: true });
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120000);
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
