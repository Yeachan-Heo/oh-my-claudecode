import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    files: ['dist', 'bridge', 'bridge/claude-md-coordinator.cjs'],
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

  it('refuses unrelated ignored generated extras instead of broad staging', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, 'bridge', 'unrelated.cjs'), 'module.exports = true;\n');

    const result = run(fixture.root, 'stage');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to stage unrelated generated artifacts: bridge/unrelated.cjs');
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

  it('rejects changes to a base-tracked generated module that is unreachable from plugin entrypoints', () => {
    const fixture = createFixture();
    const base = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.root, 'dist', 'runtime.js'), 'export const fixture = "unreachable change";\n');
    git(fixture.root, ['add', '-f', '--', 'dist/runtime.js']);
    git(fixture.root, ['commit', '--quiet', '-m', 'change unreachable generated module']);

    const result = run(fixture.root, 'check-pr', '--base', base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pull request changes generated artifacts outside the runtime closure: dist/runtime.js',
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

  it('rejects ambiguous computed local runtime loads', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.root, 'bridge', 'cli.cjs'),
      "const name = 'mcp-server.cjs'; module.exports = require('./' + name);\n",
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
});
