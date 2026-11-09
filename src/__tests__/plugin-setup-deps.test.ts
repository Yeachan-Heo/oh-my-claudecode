import { describe, it, expect } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookPrefixForPlatform, normalizeHookCommand, normalizeHooksDataForPlatform, UNIX_HOOK_PREFIX, windowsExecArgs } from '../../scripts/lib/hook-command-normalizer.mjs';

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

  it('checks for the better-sqlite3 native binding separately', () => {
    expect(scriptContent).toContain("'better-sqlite3'");
    expect(scriptContent).toContain("'better_sqlite3.node'");
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

  it('rebuilds better-sqlite3 when its native binding is missing', () => {
    expect(scriptContent).toContain('npm rebuild better-sqlite3');
    expect(scriptContent).toContain('Could not build better-sqlite3 native binding');
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

  it('reports a failed native rebuild while completing with the owner-file fallback', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-setup-fallback-'));
    const configDir = join(packageRoot, 'claude');
    const fakeHome = join(packageRoot, 'home');
    const fakeBin = join(packageRoot, 'bin');
    mkdirSync(join(packageRoot, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(packageRoot, 'hooks'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules', 'commander'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    cpSync(PLUGIN_SETUP_PATH, join(packageRoot, 'scripts', 'plugin-setup.mjs'));
    for (const file of ['config-dir.mjs', 'config-dir.sh', 'hook-command-normalizer.mjs', 'hud-cache-wrapper.sh', 'hud-wrapper-template.mjs', 'hud-wrapper-template.txt']) {
      cpSync(join(PACKAGE_ROOT, 'scripts', 'lib', file), join(packageRoot, 'scripts', 'lib', file));
    }
    cpSync(join(PACKAGE_ROOT, 'scripts', 'find-node.sh'), join(packageRoot, 'scripts', 'find-node.sh'));
    cpSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), join(packageRoot, 'hooks', 'hooks.json'));
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(packageRoot, 'package.json'));
    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho simulated rebuild failure >&2\nexit 17\n');
    chmodSync(fakeNpm, 0o755);

    try {
      const output = execFileSync(process.execPath, [join(packageRoot, 'scripts', 'plugin-setup.mjs')], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      });

      expect(output).toContain('Could not build better-sqlite3 native binding');
      expect(output).toContain('State mutation will use the file-lock fallback');
      expect(output).toContain('Setup complete with file-lock fallback');
      expect(output).not.toContain('native binding built successfully');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
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


describe('plugin-setup.mjs never probes Ruby (issue #3996)', () => {
  const scriptContent = existsSync(PLUGIN_SETUP_PATH)
    ? readFileSync(PLUGIN_SETUP_PATH, 'utf-8')
    : '';

  it('does not probe Ruby or claim Ralph requires it', () => {
    expect(scriptContent).not.toMatch(/\bruby\b/i);
    expect(scriptContent).not.toContain('checkRalphRubyDependency');
    expect(scriptContent).not.toContain('execFileSync');
    expect(scriptContent).not.toContain('ruby-full');
    expect(scriptContent).not.toContain('brew install ruby');
  });
});

describe('plugin-setup.mjs hook command portability', () => {
  // Exercises the real normalizer rather than a copy of it. A duplicated mirror
  // of these rules previously let the manifest and the patcher drift apart
  // (#4042): the manifest can be corrected while the patcher silently rewrites
  // it back on the next plugin setup.
  const scriptContent = existsSync(PLUGIN_SETUP_PATH)
    ? readFileSync(PLUGIN_SETUP_PATH, 'utf-8')
    : '';
  const UNIX_PREFIX: string = UNIX_HOOK_PREFIX;

  function patchCommand(cmd: string, prefix = UNIX_PREFIX): string {
    return normalizeHookCommand(cmd, prefix) as string;
  }

  it('selects direct node only on win32 and find-node bootstrap elsewhere', () => {
    expect(scriptContent).toContain("process.platform === 'win32'");
    expect(scriptContent).toContain('direct node exec');
    expect(scriptContent).toContain('find-node.sh run.cjs');
    expect(scriptContent).toContain('normalizeHooksDataForPlatform');
  });

  it('leaves the canonical sh+find-node+run.cjs command unchanged', () => {
    const canonical =
      `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs`;
    expect(patchCommand(canonical)).toBe(canonical);
  });

  it('normalizes legacy sh "${CLAUDE_PLUGIN_ROOT}/..." form to the canonical prefix', () => {
    const legacy =
      'sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/keyword-detector.mjs"';
    const result = patchCommand(legacy);
    expect(result).toBe(
      `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs`,
    );
  });

  it('normalizes bare "node run.cjs" form (node on PATH) to the find-node bootstrap', () => {
    const bare =
      'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-start.mjs';
    const result = patchCommand(bare);
    expect(result).toBe(
      `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-start.mjs`,
    );
  });

  it('keeps source hook commands portable with sh rather than absolute /bin/sh', () => {
    const source =
      `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs`;

    expect(source).not.toContain('/bin/sh');
    expect(patchCommand(source)).toBe(source);
  });

  it('self-heals an absolute node path baked in at publish time', () => {
    const absolute =
      '"/opt/hostedtoolcache/node/20.0.0/x64/bin/node" "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs';
    const result = patchCommand(absolute);
    expect(result).toBe(
      `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs`,
    );
  });

  it('keeps generated SessionEnd hooks native-Windows safe without sh', () => {
    const data = {
      hooks: {
        SessionEnd: [{ hooks: [
          { command: 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs' },
          { command: 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/wiki-session-end.mjs' },
        ] }],
      },
    };
    normalizeHooksDataForPlatform(data, 'win32');
    const hooks = data.hooks.SessionEnd[0].hooks;
    expect(hooks[0]).toMatchObject({ command: 'node', args: windowsExecArgs('session-end.mjs') });
    expect(hooks[1]).toMatchObject({ command: 'node', args: windowsExecArgs('wiki-session-end.mjs') });
    expect(JSON.stringify(hooks)).not.toContain('find-node.sh');
    expect(JSON.stringify(hooks)).not.toMatch(/(?:^|\s)sh(?:\s|")/);
  });

  it('normalizes every bundled hook to exec form on Windows', () => {
    const hooksJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string; args?: string[] }> }>>;
    };
    normalizeHooksDataForPlatform(hooksJson, 'win32');
    const hooks = Object.entries(hooksJson.hooks).flatMap(([event, groups]) =>
      groups.flatMap(group => group.hooks.map(hook => ({ event, hook }))),
    );

    expect(hooks.length).toBeGreaterThan(0);
    for (const { event, hook } of hooks) {
      expect(hook.command, event).toBe('node');
      expect(hook.args?.[0], event).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs');
      expect(hook.args?.[1], event).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/.+\.mjs$/);
      expect(JSON.stringify(hook), event).not.toContain('find-node.sh');
      expect(JSON.stringify(hook), event).not.toContain('/bin/sh');
    }
  });

  it('repairs every bundled exec hook to find-node on Unix/macOS', () => {
    const hooksJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string; args?: string[] }> }>>;
    };
    normalizeHooksDataForPlatform(hooksJson, 'linux');
    const hooks = Object.entries(hooksJson.hooks).flatMap(([event, groups]) =>
      groups.flatMap(group => group.hooks.map(hook => ({ event, hook }))),
    );

    expect(hooks.length).toBeGreaterThan(0);
    for (const { event, hook } of hooks) {
      expect(hook.command, event).toMatch(/^sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/find-node\.sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/run\.cjs /);
      expect(hook.command, event).toContain('"${CLAUDE_PLUGIN_ROOT}"/scripts/');
      expect(hook.command, event).not.toContain('/bin/sh');
      expect(hook.args, event).toBeUndefined();
    }
  });

  it('does not rewrite the source hooks manifest when run from a repository checkout', () => {
    const hooksJsonPath = join(PACKAGE_ROOT, 'hooks', 'hooks.json');
    const before = readFileSync(hooksJsonPath, 'utf-8');
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-setup-source-hooks-'));

    try {
      const configDir = join(tempRoot, 'claude');
      const fakeHome = join(tempRoot, 'home');
      mkdirSync(configDir, { recursive: true });
      mkdirSync(fakeHome, { recursive: true });

      execFileSync(process.execPath, [PLUGIN_SETUP_PATH], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          HOME: fakeHome,
        },
        stdio: 'pipe',
      });

      expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(before);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes current sh find-node commands to exec form on Windows', () => {
    const data = {
      hooks: {
        SessionEnd: [{ hooks: [{
          command: 'sh "${CLAUDE_PLUGIN_ROOT}"/scripts/find-node.sh "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs',
        }] }],
      },
    };
    expect(normalizeHooksDataForPlatform(data, 'win32')).toBe(true);
    expect(data.hooks.SessionEnd[0].hooks[0]).toMatchObject({
      command: 'node',
      args: windowsExecArgs('session-end.mjs'),
    });
  });

  it.runIf(process.platform !== 'win32')('executes a Unix hook command with minimal PATH by resolving Volta-managed node', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-min-path-hook-'));
    try {
      const tempHome = join(tempRoot, 'home');
      const tempBin = join(tempRoot, 'bin');
      const voltaBin = join(tempHome, '.volta', 'bin');
      mkdirSync(tempBin, { recursive: true });
      mkdirSync(voltaBin, { recursive: true });
      mkdirSync(join(tempHome, '.claude'), { recursive: true });

      symlinkSync('/bin/sh', join(tempBin, 'sh'));

      const argsFile = join(tempRoot, 'node-args.txt');
      const fakeNode = join(voltaBin, 'node');
      writeFileSync(
        fakeNode,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMC_FAKE_NODE_ARGS"\n',
      );
      chmodSync(fakeNode, 0o755);

      const command = `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/keyword-detector.mjs --smoke`;

      execFileSync('/bin/sh', ['-c', command], {
        env: {
          HOME: tempHome,
          PATH: tempBin,
          CLAUDE_PLUGIN_ROOT: PACKAGE_ROOT,
          OMC_FAKE_NODE_ARGS: argsFile,
        },
        stdio: 'pipe',
      });

      const args = readFileSync(argsFile, 'utf-8').trim().split('\n');
      expect(args[0]).toBe(join(PACKAGE_ROOT, 'scripts', 'run.cjs'));
      expect(args[1]).toBe(join(PACKAGE_ROOT, 'scripts', 'keyword-detector.mjs'));
      expect(args[2]).toBe('--smoke');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('prefers concrete nvm node over a stale executable shim on PATH', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-min-path-nvm-'));
    try {
      const tempHome = join(tempRoot, 'home');
      const tempBin = join(tempRoot, 'bin');
      const asdfBin = join(tempHome, '.asdf', 'shims');
      const nvmBin = join(tempHome, '.nvm', 'versions', 'node', 'v22.14.0', 'bin');
      mkdirSync(tempBin, { recursive: true });
      mkdirSync(asdfBin, { recursive: true });
      mkdirSync(nvmBin, { recursive: true });
      mkdirSync(join(tempHome, '.claude'), { recursive: true });

      symlinkSync('/bin/sh', join(tempBin, 'sh'));

      writeFileSync(join(asdfBin, 'node'), '#!/bin/sh\nexit 127\n');
      chmodSync(join(asdfBin, 'node'), 0o755);

      const argsFile = join(tempRoot, 'node-args.txt');
      const fakeNode = join(nvmBin, 'node');
      writeFileSync(
        fakeNode,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMC_FAKE_NODE_ARGS"\n',
      );
      chmodSync(fakeNode, 0o755);

      const command = `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs`;
      execFileSync('/bin/sh', ['-c', command], {
        env: {
          HOME: tempHome,
          PATH: `${tempBin}:${asdfBin}`,
          CLAUDE_PLUGIN_ROOT: PACKAGE_ROOT,
          OMC_FAKE_NODE_ARGS: argsFile,
        },
        stdio: 'pipe',
      });

      const args = readFileSync(argsFile, 'utf-8').trim().split('\n');
      expect(args[0]).toBe(join(PACKAGE_ROOT, 'scripts', 'run.cjs'));
      expect(args[1]).toBe(join(PACKAGE_ROOT, 'scripts', 'session-end.mjs'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('prefers concrete nvm node over a stale stored nodeBinary shim', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-stored-shim-'));
    try {
      const tempHome = join(tempRoot, 'home');
      const tempBin = join(tempRoot, 'bin');
      const asdfBin = join(tempHome, '.asdf', 'shims');
      const nvmBin = join(tempHome, '.nvm', 'versions', 'node', 'v22.14.0', 'bin');
      const claudeDir = join(tempHome, '.claude');
      mkdirSync(tempBin, { recursive: true });
      mkdirSync(asdfBin, { recursive: true });
      mkdirSync(nvmBin, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });

      symlinkSync('/bin/sh', join(tempBin, 'sh'));

      const staleShim = join(asdfBin, 'node');
      writeFileSync(staleShim, '#!/bin/sh\nexit 127\n');
      chmodSync(staleShim, 0o755);
      writeFileSync(join(claudeDir, '.omc-config.json'), JSON.stringify({ nodeBinary: staleShim }));

      const argsFile = join(tempRoot, 'node-args.txt');
      const fakeNode = join(nvmBin, 'node');
      writeFileSync(
        fakeNode,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMC_FAKE_NODE_ARGS"\n',
      );
      chmodSync(fakeNode, 0o755);

      const command = `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs`;
      execFileSync('/bin/sh', ['-c', command], {
        env: {
          HOME: tempHome,
          PATH: tempBin,
          CLAUDE_PLUGIN_ROOT: PACKAGE_ROOT,
          OMC_FAKE_NODE_ARGS: argsFile,
        },
        stdio: 'pipe',
      });

      const args = readFileSync(argsFile, 'utf-8').trim().split('\n');
      expect(args[0]).toBe(join(PACKAGE_ROOT, 'scripts', 'run.cjs'));
      expect(args[1]).toBe(join(PACKAGE_ROOT, 'scripts', 'session-end.mjs'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the Windows hook command direct-node and shell-wrapper free', () => {
    const data = {
      hooks: { SessionEnd: [{ hooks: [{ command: `${UNIX_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs` }] }] },
    };
    normalizeHooksDataForPlatform(data, 'win32');
    const hook = data.hooks.SessionEnd[0].hooks[0];

    expect(hook).toMatchObject({ command: 'node', args: windowsExecArgs('session-end.mjs') });
    expect(JSON.stringify(hook)).not.toContain('find-node.sh');
    expect(hook.command).not.toMatch(/(?:^|\s)sh(?:\s|$)/);
    expect(JSON.stringify(hook)).not.toContain('/bin/sh');
  });

  // Regression coverage for #4042. The bare `$CLAUDE_PLUGIN_ROOT` form depends on
  // a POSIX shell expanding an environment variable. The Windows prefix runs
  // `node` with no shell in front of it, so there the plugin root never expands
  // and session start fails loading `<drive>:\scripts\run.cjs`. Claude Code
  // substitutes the braced form itself, and under `sh` both forms expand
  // identically, so braced is the only spelling that works on every platform.
  describe('braced ${CLAUDE_PLUGIN_ROOT} placeholder (#4042)', () => {
    const BARE_ROOT = /\$CLAUDE_PLUGIN_ROOT/;

    function bundledHooks(): Array<{ event: string; command: string; args?: string[] }> {
      const hooksJson = JSON.parse(
        readFileSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), 'utf-8'),
      ) as { hooks: Record<string, Array<{ hooks: Array<{ command?: string; args?: string[] }> }>> };
      return Object.entries(hooksJson.hooks).flatMap(([event, groups]) =>
        groups.flatMap(group =>
          group.hooks
            .filter((hook): hook is { command: string; args?: string[] } => typeof hook.command === 'string')
            .map(hook => ({ event, command: hook.command, args: hook.args })),
        ),
      );
    }

    function invocationText(hook: { command: string; args?: string[] }): string {
      return [hook.command, ...(hook.args ?? [])].join(' ');
    }

    it('ships no bare $CLAUDE_PLUGIN_ROOT in the bundled manifest', () => {
      const hooks = bundledHooks();
      expect(hooks.length).toBeGreaterThan(0);
      for (const hook of hooks) {
        const text = invocationText(hook);
        expect(text, hook.event).toContain('${CLAUDE_PLUGIN_ROOT}');
        expect(text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ''), hook.event).not.toMatch(BARE_ROOT);
        expect(hook.command, hook.event).toBe('node');
      }
    });

    it('emits the braced form from both platform outputs', () => {
      const unix = hookPrefixForPlatform('linux');
      const windows = windowsExecArgs('keyword-detector.mjs').join(' ');
      for (const text of [unix, windows]) {
        expect(text).toContain('${CLAUDE_PLUGIN_ROOT}');
        expect(text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '')).not.toMatch(BARE_ROOT);
      }
    });

    it('never normalizes a manifest command back to the bare form', () => {
      // The defect this guards: correcting hooks.json alone was undone because
      // plugin-setup.mjs re-normalized every command to the bare spelling.
      const hooksJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
      for (const platform of ['win32', 'linux'] as const) {
        const copy = structuredClone(hooksJson);
        normalizeHooksDataForPlatform(copy, platform);
        for (const groups of Object.values(copy.hooks) as Array<Array<{ hooks: Array<{ command: string; args?: string[] }> }>>) {
          for (const group of groups) {
            for (const hook of group.hooks) {
              const text = invocationText(hook);
              expect(text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ''), platform).not.toMatch(BARE_ROOT);
            }
          }
        }
      }
    });

    it('repairs a bare command and is idempotent on the result', () => {
      const data = {
        hooks: {
          SessionStart: [{ hooks: [{
            command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-start.mjs',
          }] }],
        },
      };

      expect(normalizeHooksDataForPlatform(data, 'win32')).toBe(true);
      expect(data.hooks.SessionStart[0].hooks[0]).toMatchObject({
        command: 'node',
        args: windowsExecArgs('session-start.mjs'),
      });
      expect(normalizeHooksDataForPlatform(data, 'win32')).toBe(false);
    });
  });
});
