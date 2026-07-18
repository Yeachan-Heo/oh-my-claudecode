import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'plugin-shipping-surface.mjs');
const shippingSurface = import(pathToFileURL(SCRIPT_PATH).href);
const tempRoots: string[] = [];

type FixtureOptions = {
  includeCoordinator?: boolean;
  includeMcpHelper?: boolean;
  trackCli?: boolean;
  coordinatorDigest?: string;
  coordinatorDecoyDigest?: string;
  trackedGeneratedTestPaths?: string[];
};

type Fixture = {
  root: string;
  coordinatorDigest: string;
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'omc-plugin-shipping-surface-'));
  tempRoots.push(root);

  const canonicalClaudeMd = '<!-- OMC:START -->\nfixture\n<!-- OMC:END -->\n';
  const coordinatorDigest = options.coordinatorDigest ?? createHash('sha256')
    .update(canonicalClaudeMd)
    .digest('hex');

  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });

  writeJson(join(root, 'package.json'), {
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
    bin: { fixture: './bridge/cli.cjs' },
    files: ['dist/index.js', 'bridge/claude-md-coordinator.cjs'],
  });
  writeJson(join(root, '.claude-plugin', 'plugin.json'), {
    name: 'fixture-plugin',
    version: '1.0.0',
    mcpServers: './.mcp.json',
  });
  writeJson(join(root, '.mcp.json'), {
    mcpServers: {
      fixture: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'],
      },
    },
  });
  writeFileSync(join(root, '.gitignore'), 'dist/\nbridge/\n');
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), canonicalClaudeMd);
  writeFileSync(join(root, 'dist', 'index.js'), "export { fixture } from './runtime.js';\n");
  writeFileSync(join(root, 'dist', 'runtime.js'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'bridge', 'cli.cjs'), "module.exports = require('./mcp-server.cjs');\n");
  writeFileSync(join(root, 'bridge', 'mcp-server.cjs'), "module.exports = require('./mcp-helper.cjs');\n");
  if (options.includeMcpHelper !== false) {
    writeFileSync(join(root, 'bridge', 'mcp-helper.cjs'), 'module.exports = true;\n');
  }
  if (options.includeCoordinator !== false) {
    const decoy = options.coordinatorDecoyDigest ? `// ${options.coordinatorDecoyDigest}\n` : '';
    writeFileSync(
      join(root, 'bridge', 'claude-md-coordinator.cjs'),
      `#!/usr/bin/env node\n${decoy}if (process.argv.includes('--handshake')) process.stdout.write(JSON.stringify({ schemaVersion: 1, engineVersion: '1.0.0', sourceSha256: '${coordinatorDigest}' }));\n`,
    );
  }

  for (const repoPath of options.trackedGeneratedTestPaths ?? []) {
    const filePath = join(root, repoPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'module.exports = true;\n');
  }

  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['add', '.']);
  git(root, ['add', '-f', '--', 'dist/index.js', 'dist/runtime.js', 'bridge/mcp-server.cjs']);
  if (options.trackCli !== false) git(root, ['add', '-f', '--', 'bridge/cli.cjs']);
  if (options.includeMcpHelper !== false) git(root, ['add', '-f', '--', 'bridge/mcp-helper.cjs']);
  if (options.includeCoordinator !== false) git(root, ['add', '-f', '--', 'bridge/claude-md-coordinator.cjs']);
  if ((options.trackedGeneratedTestPaths?.length ?? 0) > 0) {
    git(root, ['add', '-f', '--', ...options.trackedGeneratedTestPaths!]);
  }
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  return { root, coordinatorDigest };
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin shipping surface transaction', () => {
  it('fails closed when the declared coordinator is absent from a clean plugin checkout', () => {
    const fixture = createFixture({ includeCoordinator: false });

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'required generated runtime file is missing: bridge/claude-md-coordinator.cjs',
    );
  });

  it('fails closed when a reachable generated module is missing', () => {
    const fixture = createFixture({ includeMcpHelper: false });

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'reachable generated runtime module is missing: bridge/mcp-server.cjs -> ./mcp-helper.cjs',
    );
  });

  it('discovers an ignored and untracked generated entrypoint after a build', async () => {
    const fixture = createFixture({ trackCli: false });
    const module = await shippingSurface;

    const surface = module.inspectPluginShippingSurface(fixture.root);

    expect(surface.ignoredUntrackedRequiredPaths).toEqual(['bridge/cli.cjs']);
    expect(surface.stagePaths).toEqual(['bridge/cli.cjs']);
  });

  it('expands declared generated directories into exact runtime payload files only', async () => {
    const fixture = createFixture();
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin', version: '1.0.0', type: 'module', main: './dist/index.js',
      bin: { fixture: './bridge/cli.cjs' },
      files: ['dist', 'bridge/claude-md-coordinator.cjs'],
    });
    mkdirSync(join(fixture.root, 'dist', 'fixtures'), { recursive: true });
    writeFileSync(join(fixture.root, 'dist', 'stale.js'), 'export default true;\n');
    writeFileSync(join(fixture.root, 'dist', 'stale.js.map'), '{}\n');
    writeFileSync(join(fixture.root, 'dist', 'fixtures', 'ignored.js'), 'export default true;\n');
    writeFileSync(join(fixture.root, 'dist', 'README.txt'), 'not runtime\n');
    const module = await shippingSurface;

    const surface = module.inspectPluginShippingSurface(fixture.root);

    expect(surface.requiredPaths).toContain('dist/stale.js');
    expect(surface.requiredPaths).not.toContain('dist/stale.js.map');
    expect(surface.requiredPaths).not.toContain('dist/fixtures/ignored.js');
    expect(surface.ignoredUntrackedRequiredPaths).toEqual(['dist/stale.js']);
    expect(surface.stagePaths).toEqual(['dist/stale.js']);

    const result = run(fixture.root, 'stage');

    expect(result.status).toBe(0);
    expect(git(fixture.root, ['diff', '--cached', '--name-only']).trim()).toBe('dist/stale.js');
  });

  it('excludes tracked generated test and fixture paths from the runtime baseline', async () => {
    const fixture = createFixture({
      trackedGeneratedTestPaths: [
        'dist/__tests__/generated.test.js',
        'bridge/fixtures/non-runtime.cjs',
      ],
    });
    const module = await shippingSurface;

    const surface = module.inspectPluginShippingSurface(fixture.root);

    expect(surface.requiredPaths).not.toContain('dist/__tests__/generated.test.js');
    expect(surface.requiredPaths).not.toContain('bridge/fixtures/non-runtime.cjs');
  });

  it('discovers helper-computed generated runtime children from local constant strings and arrays', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "const root = 'bridge'; const child = ['daemon.js']; const daemon = join(root, ...child); module.exports = require(daemon);\n",
    );
    writeFileSync(join(fixture.root, 'bridge', 'daemon.js'), 'module.exports = true;\n');

    const result = run(fixture.root, 'verify');

    expect(result.status).toBe(0);
  });

  it('fails closed when a helper-computed generated runtime child is missing', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "const root = 'bridge'; const child = ['daemon.js']; const daemon = join(root, ...child); module.exports = require(daemon);\n",
    );

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('required generated runtime file is missing: bridge/daemon.js');
  });

  it('unwraps safe URL path wrappers around static generated joins', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "const child = 'daemon.js'; module.exports = require(pathToFileURL(join('bridge', child)).href);\n",
    );
    writeFileSync(join(fixture.root, 'bridge', 'daemon.js'), 'module.exports = true;\n');

    const result = run(fixture.root, 'verify');

    expect(result.status).toBe(0);
  });

  it('resolves static new URL local runtime loads relative to import metadata', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "module.exports = require(new URL('./daemon.cjs', import.meta.url));\n",
    );
    writeFileSync(join(fixture.root, 'bridge', 'daemon.cjs'), 'module.exports = true;\n');

    const result = run(fixture.root, 'verify');

    expect(result.status).toBe(0);
  });

  it('constructs and executes an exact forced staging command for closure paths only', async () => {
    const fixture = createFixture({ trackCli: false });
    const module = await shippingSurface;

    expect(module.buildStageArguments(['bridge/cli.cjs', 'bridge/mcp-server.cjs', 'bridge/cli.cjs'])).toEqual([
      'add',
      '-f',
      '--',
      'bridge/cli.cjs',
      'bridge/mcp-server.cjs',
    ]);

    const result = run(fixture.root, 'stage');

    expect(result.status).toBe(0);
    expect(git(fixture.root, ['diff', '--cached', '--name-only']).trim()).toBe('bridge/cli.cjs');
  });

  it('stages a deletion from the prior runtime closure with its desired replacement', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, 'bridge', 'mcp-server.cjs'), 'module.exports = true;\n');
    unlinkSync(join(fixture.root, 'bridge', 'mcp-helper.cjs'));

    const result = run(fixture.root, 'stage');

    expect(result.status).toBe(0);
    expect(git(fixture.root, ['diff', '--cached', '--name-only']).trim().split(/\n/)).toEqual([
      'bridge/mcp-helper.cjs',
      'bridge/mcp-server.cjs',
    ]);
  });

  it('refuses deletion of an unrelated generated artifact', () => {
    const fixture = createFixture({ trackedGeneratedTestPaths: ['bridge/unrelated.cjs'] });
    unlinkSync(join(fixture.root, 'bridge', 'unrelated.cjs'));

    const result = run(fixture.root, 'stage');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to stage unrelated generated artifacts: bridge/unrelated.cjs');
    expect(git(fixture.root, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses unrelated ignored generated extras instead of broad staging', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');

    const result = run(fixture.root, 'stage');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to stage unrelated generated artifacts: bridge/unrelated.cjs');
    expect(git(fixture.root, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses ignored untracked dist runtime extras without broad staging', () => {
    const fixture = createFixture({ trackCli: false });
    writeFileSync(join(fixture.root, 'dist', 'unrelated.js'), 'export default true;\n');

    const result = run(fixture.root, 'stage');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to stage unrelated generated artifacts: dist/unrelated.js');
    expect(git(fixture.root, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('rejects a coordinator whose embedded source digest does not match docs/CLAUDE.md', () => {
    const fixture = createFixture({ coordinatorDigest: '0'.repeat(64) });

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('coordinator source digest mismatch');
  });

  it('rejects a correct digest decoy when the active coordinator handshake is stale', () => {
    const canonicalDigest = createHash('sha256')
      .update('<!-- OMC:START -->\nfixture\n<!-- OMC:END -->\n')
      .digest('hex');
    const fixture = createFixture({
      coordinatorDigest: '0'.repeat(64),
      coordinatorDecoyDigest: canonicalDigest,
    });

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('coordinator source digest mismatch');
  });

  it('rejects initial runtime entrypoints that escape through a symlink', () => {
    const fixture = createFixture();
    rmSync(join(fixture.root, 'bridge', 'cli.cjs'));
    symlinkSync('/etc/passwd', join(fixture.root, 'bridge', 'cli.cjs'));

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not traverse a symbolic link: bridge/cli.cjs');
  });

  it('verifies an ordinary committed runtime surface without staging anything', () => {
    const fixture = createFixture();

    const result = run(fixture.root, 'verify');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 ignored-and-untracked artifact(s) await staging');
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  it('seeds the closure from recursive public package entrypoints and stages only those untracked artifacts', async () => {
    const fixture = createFixture();
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin',
      version: '1.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/public.d.ts',
      exports: {
        '.': { import: './dist/index.js', types: './dist/public.d.ts' },
        './public': ['./dist/public.js'],
      },
      bin: { fixture: './bridge/cli.cjs' },
      files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs'],
    });
    writeFileSync(join(fixture.root, 'dist', 'public.js'), 'export default true;\n');
    writeFileSync(join(fixture.root, 'dist', 'public.d.ts'), "export * from './auxiliary.js';\n");
    writeFileSync(join(fixture.root, 'dist', 'auxiliary.d.ts'), "export * from './nested.js';\n");
    writeFileSync(join(fixture.root, 'dist', 'nested.d.ts'), 'export declare const nested: true;\n');
    const module = await shippingSurface;

    const surface = module.inspectPluginShippingSurface(fixture.root);

    expect(surface.ignoredUntrackedRequiredPaths).toEqual(['dist/auxiliary.d.ts', 'dist/nested.d.ts', 'dist/public.d.ts', 'dist/public.js']);
    expect(surface.stagePaths).toEqual(['dist/auxiliary.d.ts', 'dist/nested.d.ts', 'dist/public.d.ts', 'dist/public.js']);
  });

  it('rejects missing and escaping public package entrypoints', () => {
    const fixture = createFixture();
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin', version: '1.0.0', type: 'module', main: './dist/missing.js',
      bin: { fixture: './bridge/cli.cjs' }, files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs'],
    });

    expect(run(fixture.root, 'verify').stderr).toContain('required generated runtime file is missing: dist/missing.js');

    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin', version: '1.0.0', type: 'module', main: '../outside.js',
      bin: { fixture: './bridge/cli.cjs' }, files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs'],
    });

    expect(run(fixture.root, 'verify').stderr).toContain('package.json main must stay within the package root');
  });

  it('accepts a PR diff that changes only computed runtime closure artifacts', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'bridge', 'mcp-helper.cjs'), 'module.exports = { changed: true };\n');
    git(fixture.root, ['add', '-f', '--', 'bridge/mcp-helper.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'update generated runtime helper']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('plugin shipping surface PR check verified');
  });

  it('accepts a PR deletion from the previous runtime closure', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'bridge', 'mcp-server.cjs'), 'module.exports = true;\n');
    git(fixture.root, ['add', '-f', '--', 'bridge/mcp-server.cjs']);
    git(fixture.root, ['rm', '--quiet', '--', 'bridge/mcp-helper.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'remove obsolete generated runtime helper']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('plugin shipping surface PR check verified');
  });

  it('rejects a PR diff with an out-of-closure generated artifact', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');
    git(fixture.root, ['add', '-f', '--', 'bridge/unrelated.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'add unrelated generated artifact']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: bridge/unrelated.cjs',
    );
  });

  it('does not let a base-owned generated directory bless a candidate-only runtime artifact', () => {
    const fixture = createFixture();
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin',
      version: '1.0.0',
      type: 'module',
      main: './dist/index.js',
      bin: { fixture: './bridge/cli.cjs' },
      files: ['dist', 'bridge'],
    });
    git(fixture.root, ['add', 'package.json']);
    git(fixture.root, ['commit', '--quiet', '-m', 'declare generated directories']);
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();

    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');
    git(fixture.root, ['add', '-f', '--', 'bridge/unrelated.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'add candidate-only generated artifact']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: bridge/unrelated.cjs',
    );
  });

  it('rejects changes to a base-tracked generated module that is unreachable from plugin entrypoints', () => {
    const fixture = createFixture({ trackedGeneratedTestPaths: ['dist/unreachable.js'] });
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'dist', 'unreachable.js'), 'export const fixture = "unreachable change";\n');
    git(fixture.root, ['add', '-f', '--', 'dist/unreachable.js']);
    git(fixture.root, ['commit', '--quiet', '-m', 'change unreachable generated module']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: dist/unreachable.js',
    );
  });

  it('does not let a PR-controlled package files entry bless an unrelated artifact', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin',
      version: '1.0.0',
      type: 'module',
      main: './dist/index.js',
      bin: { fixture: './bridge/cli.cjs' },
      files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs', 'bridge/unrelated.cjs'],
    });
    git(fixture.root, ['add', 'package.json']);
    git(fixture.root, ['add', '-f', '--', 'bridge/unrelated.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'attempt to bless unrelated artifact']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: bridge/unrelated.cjs',
    );
  });

  it('does not let a PR-controlled generated directory bless new runtime candidates', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'dist', 'unrelated.js'), 'export default true;\n');
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin', version: '1.0.0', type: 'module', main: './dist/index.js',
      bin: { fixture: './bridge/cli.cjs' }, files: ['dist', 'bridge/claude-md-coordinator.cjs'],
    });
    git(fixture.root, ['add', 'package.json']);
    git(fixture.root, ['add', '-f', '--', 'dist/unrelated.js']);
    git(fixture.root, ['commit', '--quiet', '-m', 'attempt generated directory blessing']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: dist/unrelated.js',
    );
  });

  it('does not let a PR-controlled package exports target bless an unrelated artifact', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'dist', 'unrelated.js'), 'export default true;\n');
    writeJson(join(fixture.root, 'package.json'), {
      name: 'fixture-plugin', version: '1.0.0', type: 'module', main: './dist/index.js',
      exports: { '.': './dist/index.js', './unrelated': './dist/unrelated.js' },
      bin: { fixture: './bridge/cli.cjs' }, files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs'],
    });
    git(fixture.root, ['add', 'package.json']);
    git(fixture.root, ['add', '-f', '--', 'dist/unrelated.js']);
    git(fixture.root, ['commit', '--quiet', '-m', 'attempt exports target blessing']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: dist/unrelated.js',
    );
  });

  it('does not bless an artifact mentioned only in a required-file comment', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'bridge', 'cli.cjs'), "// bridge/unrelated.cjs\nmodule.exports = require('./mcp-server.cjs');\n");
    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');
    git(fixture.root, ['add', '-f', '--', 'bridge/cli.cjs', 'bridge/unrelated.cjs']);
    git(fixture.root, ['commit', '--quiet', '-m', 'attempt comment path blessing']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: bridge/unrelated.cjs',
    );
  });

  it('rejects ambiguous computed local generated runtime loads', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "const name = process.argv[2]; module.exports = require(join('bridge', name));\n",
    );

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ambiguous local runtime load in bridge/cli.cjs');
  });

  it('rejects generated tests or fixtures reached by runtime code', () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.root, 'bridge', 'fixtures'), { recursive: true });
    writeFileSync(join(fixture.root, 'bridge', 'cli.cjs'), "module.exports = require('./fixtures/runtime.cjs');\n");
    writeFileSync(join(fixture.root, 'bridge', 'fixtures', 'runtime.cjs'), 'module.exports = true;\n');

    const result = run(fixture.root, 'verify');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('generated test or fixture cannot enter runtime closure: bridge/fixtures/runtime.cjs');
  });

  it('rejects a pre-staged generated extra without changing the index', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, 'dist', 'unrelated.js'), 'export default true;\n');
    git(fixture.root, ['add', '-f', '--', 'dist/unrelated.js']);
    const before = git(fixture.root, ['diff', '--cached', '--name-only']);

    const result = run(fixture.root, 'stage');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to stage unrelated generated artifacts: dist/unrelated.js');
    expect(git(fixture.root, ['diff', '--cached', '--name-only'])).toBe(before);
  });

  it('rejects malformed or missing PR base commits', () => {
    const fixture = createFixture();
    const malformed = run(fixture.root, 'check-pr', '--base', 'not-a-sha');
    const missing = run(fixture.root, 'check-pr', '--base', '0'.repeat(40));

    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain('check-pr base must be a 40-character hexadecimal commit SHA');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(`check-pr base commit is not available: ${'0'.repeat(40)}`);
  });

  it('rejects a required generated runtime artifact that is not tracked at HEAD', () => {
    const fixture = createFixture({ trackCli: false });
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'README.md'), 'head commit\n');
    git(fixture.root, ['add', 'README.md']);
    git(fixture.root, ['commit', '--quiet', '-m', 'advance head']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'required generated runtime artifacts are not tracked at HEAD: bridge/cli.cjs',
    );
  });
  it('uses the unique merge base when the supplied local base is ahead of HEAD', () => {
    const fixture = createFixture();
    const head = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    const tree = git(fixture.root, ['rev-parse', `${head}^{tree}`]).trim();
    const aheadBase = git(fixture.root, ['commit-tree', tree, '-p', head, '-m', 'base ahead']).trim();

    const result = run(fixture.root, 'check-pr', '--base', aheadBase);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`since ${head}`);
  });

  it('rejects local check-pr histories without one unique merge base', () => {
    const fixture = createFixture();
    const head = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    const tree = git(fixture.root, ['rev-parse', `${head}^{tree}`]).trim();
    const orphan = git(fixture.root, ['commit-tree', tree, '-m', 'orphan']).trim();

    expect(run(fixture.root, 'check-pr', '--base', orphan).stderr).toContain(
      'check-pr has no common merge base with HEAD',
    );

    const a1 = git(fixture.root, ['commit-tree', tree, '-p', head, '-m', 'a1']).trim();
    const b1 = git(fixture.root, ['commit-tree', tree, '-p', head, '-m', 'b1']).trim();
    const a2 = git(fixture.root, ['commit-tree', tree, '-p', a1, '-p', b1, '-m', 'a2']).trim();
    const b2 = git(fixture.root, ['commit-tree', tree, '-p', b1, '-p', a1, '-m', 'b2']).trim();
    expect(git(fixture.root, ['merge-base', '--all', a2, b2]).trim().split(/\s+/)).toHaveLength(2);
    git(fixture.root, ['checkout', '--quiet', '--detach', b2]);

    expect(run(fixture.root, 'check-pr', '--base', a2).stderr).toContain(
      'check-pr has ambiguous merge bases: 2',
    );
  });
});
