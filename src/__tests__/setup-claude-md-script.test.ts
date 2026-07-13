import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_SCRIPT = join(REPO_ROOT, 'scripts', 'setup-claude-md.sh');
const CONFIG_DIR_HELPER = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.sh');
const LEGACY_GUIDES_FIXTURE = join(REPO_ROOT, 'src', 'installer', '__tests__', 'fixtures', 'legacy-guides.json');

interface LegacyGuideFixture {
  id: string;
  lineCount: number;
  dataBase64: string;
}

function staticLegacyGuide(lineCount: number): string {
  const fixture = JSON.parse(readFileSync(LEGACY_GUIDES_FIXTURE, 'utf-8')) as { variants: LegacyGuideFixture[] };
  const variant = fixture.variants.find(candidate => candidate.lineCount === lineCount);
  if (!variant) throw new Error(`Missing static ${lineCount}-line legacy guide fixture`);
  return Buffer.from(variant.dataBase64, 'base64').toString('utf-8');
}

const LEGACY_583_LINE_GUIDE = staticLegacyGuide(583);
const LEGACY_292_LINE_GUIDE = staticLegacyGuide(292);

const tempRoots: string[] = [];
const COMMITTED_COORDINATOR = 'bridge/claude-md-coordinator.cjs';

interface CoordinatorHandshake {
  schemaVersion: number;
  engineVersion: string;
  sourceSha256: string;
}

function exportCommittedPlugin(pluginRoot: string) {
  mkdirSync(pluginRoot, { recursive: true });
  const result = spawnSync('git', ['checkout-index', '--all', `--prefix=${pluginRoot}/`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`Unable to export tracked plugin tree: ${result.stderr}`);
  }
}

function installSetupSurface(pluginRoot: string): void {
  mkdirSync(join(pluginRoot, 'scripts', 'lib'), { recursive: true });
  copyFileSync(SETUP_SCRIPT, join(pluginRoot, 'scripts', 'setup-claude-md.sh'));
  copyFileSync(CONFIG_DIR_HELPER, join(pluginRoot, 'scripts', 'lib', 'config-dir.sh'));
}

function createCommittedPluginFixture() {
  const root = mkdtempSync(join(tmpdir(), 'omc-committed-plugin-'));
  tempRoots.push(root);

  const pluginRoot = join(root, 'plugin');
  const projectRoot = join(root, 'project');
  const homeRoot = join(root, 'home');
  exportCommittedPlugin(pluginRoot);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });

  return {
    pluginRoot,
    projectRoot,
    homeRoot,
    scriptPath: join(pluginRoot, 'scripts', 'setup-claude-md.sh'),
  };
}

function coordinatorHandshake(coordinator: string): CoordinatorHandshake {
  const result = spawnSync('node', [coordinator, '--handshake'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`Coordinator handshake failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as CoordinatorHandshake;
}

// Fixture compilation exercises coordinator behavior with synthetic documents. It
// does not prove that a clean plugin checkout ships a runnable coordinator; the
// issue #3476 suite below tests that committed runtime surface.
function buildCoordinatorFixture(pluginRoot: string, claudeMdContent: string, version = '9.9.9') {
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  buildSync({
    entryPoints: [join(REPO_ROOT, 'src', 'cli', 'claude-md-coordinator.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(pluginRoot, 'bridge', 'claude-md-coordinator.cjs'),
    external: ['node:crypto', 'node:fs', 'node:path'],
    define: {
      __OMC_COORDINATOR_ENGINE_VERSION__: JSON.stringify(version),
      __OMC_COORDINATOR_SOURCE_SHA256__: JSON.stringify(createHash('sha256').update(claudeMdContent).digest('hex')),
    },
  });
  mkdirSync(join(pluginRoot, 'skills', 'omc-reference'), { recursive: true });
  writeFileSync(join(pluginRoot, 'skills', 'omc-reference', 'SKILL.md'), `---
name: omc-reference
description: Test fixture reference skill
user-invocable: false
---

# Test OMC Reference
`);
}

function createPluginFixture(claudeMdContent: string) {
  const root = mkdtempSync(join(tmpdir(), 'omc-setup-claude-md-'));
  tempRoots.push(root);

  const pluginRoot = join(root, 'plugin');
  const projectRoot = join(root, 'project');
  const homeRoot = join(root, 'home');

  mkdirSync(join(pluginRoot, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(pluginRoot, 'docs'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });

  copyFileSync(SETUP_SCRIPT, join(pluginRoot, 'scripts', 'setup-claude-md.sh'));
  copyFileSync(CONFIG_DIR_HELPER, join(pluginRoot, 'scripts', 'lib', 'config-dir.sh'));
  writeFileSync(join(pluginRoot, 'docs', 'CLAUDE.md'), claudeMdContent);
  buildCoordinatorFixture(pluginRoot, claudeMdContent);

  return {
    pluginRoot,
    projectRoot,
    homeRoot,
    scriptPath: join(pluginRoot, 'scripts', 'setup-claude-md.sh'),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
describe('setup-claude-md.sh committed plugin shipping surface (issue #3476)', () => {
  it('tracks the coordinator artifact required by plugin setup', () => {
    const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', COMMITTED_COORDINATOR], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(COMMITTED_COORDINATOR);
  });

  it('embeds the SHA-256 of the exact committed docs/CLAUDE.md bytes', () => {
    const fixture = createCommittedPluginFixture();
    const handshake = coordinatorHandshake(join(fixture.pluginRoot, COMMITTED_COORDINATOR));
    const sourceSha256 = createHash('sha256')
      .update(readFileSync(join(fixture.pluginRoot, 'docs', 'CLAUDE.md')))
      .digest('hex');

    expect(handshake.schemaVersion).toBe(1);
    expect(handshake.sourceSha256).toBe(sourceSha256);
  });

  it('runs local setup from a source-only tracked plugin checkout without a consumer build', () => {
    const fixture = createCommittedPluginFixture();
    expect(existsSync(join(fixture.pluginRoot, 'node_modules'))).toBe(false);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: { ...process.env, HOME: fixture.homeRoot },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(fixture.projectRoot, '.claude', 'CLAUDE.md'), 'utf-8'))
      .toBe(readFileSync(join(fixture.pluginRoot, 'docs', 'CLAUDE.md'), 'utf-8'));
    expect(readFileSync(join(fixture.projectRoot, '.claude', 'skills', 'omc-reference', 'SKILL.md'), 'utf-8'))
      .toBe(readFileSync(join(fixture.pluginRoot, 'skills', 'omc-reference', 'SKILL.md'), 'utf-8'));
  });

  for (const scenario of ['missing', 'stale'] as const) {
    it(`fails before local mutation when the committed coordinator is ${scenario}`, () => {
      const fixture = createCommittedPluginFixture();
      const coordinator = join(fixture.pluginRoot, COMMITTED_COORDINATOR);
      if (scenario === 'missing') {
        rmSync(coordinator);
      } else {
        writeFileSync(join(fixture.pluginRoot, 'docs', 'CLAUDE.md'), '<!-- OMC:START -->\n<!-- OMC:VERSION:stale -->\n# stale\n<!-- OMC:END -->\n');
      }

      const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
        cwd: fixture.projectRoot,
        env: { ...process.env, HOME: fixture.homeRoot },
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        scenario === 'missing'
          ? 'Active plugin root lacks the required coordinator artifact'
          : 'Coordinator handshake validation failed',
      );
      expect(existsSync(join(fixture.projectRoot, '.claude'))).toBe(false);
    });
  }

  it('uses one active cache root for the coordinator, canonical source, and engine version', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-committed-root-coherence-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const staleRoot = join(cacheBase, '0.0.1');
    const activeRoot = join(cacheBase, '0.0.2');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    exportCommittedPlugin(staleRoot);
    exportCommittedPlugin(activeRoot);
    rmSync(join(staleRoot, COMMITTED_COORDINATOR));
    writeFileSync(join(staleRoot, 'docs', 'CLAUDE.md'), '<!-- OMC:START -->\n<!-- OMC:VERSION:stale -->\n# stale root\n<!-- OMC:END -->\n');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    const result = spawnSync('bash', [join(staleRoot, 'scripts', 'setup-claude-md.sh'), 'local'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: homeRoot },
      encoding: 'utf-8',
    });

    const activeDocs = readFileSync(join(activeRoot, 'docs', 'CLAUDE.md'), 'utf-8');
    const activeHandshake = coordinatorHandshake(join(activeRoot, COMMITTED_COORDINATOR));
    expect(result.status).toBe(0);
    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toBe(activeDocs);
    expect(installed).toContain(`<!-- OMC:VERSION:${activeHandshake.engineVersion} -->`);
  });
});


describe('setup-claude-md.sh (issue #3442)', () => {
  it('installs the canonical docs/CLAUDE.md content with OMC markers', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const installedPath = join(fixture.projectRoot, '.claude', 'CLAUDE.md');
    expect(existsSync(installedPath)).toBe(true);

    const installed = readFileSync(installedPath, 'utf-8');
    expect(installed).toContain('<!-- OMC:START -->');
    expect(installed).toContain('<!-- OMC:END -->');
    expect(installed).toContain('<!-- OMC:VERSION:9.9.9 -->');
    expect(installed).toContain('# Canonical CLAUDE');

    const installedSkillPath = join(fixture.projectRoot, '.claude', 'skills', 'omc-reference', 'SKILL.md');
    expect(existsSync(installedSkillPath)).toBe(true);
    expect(readFileSync(installedSkillPath, 'utf-8')).toContain('# Test OMC Reference');
  });

  it('fails closed when a coordinator reports ok:false with exit status 0', () => {
    const canonical = `<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->
# Canonical CLAUDE
<!-- OMC:END -->
`;
    const fixture = createPluginFixture(canonical);
    const sourceSha256 = createHash('sha256').update(canonical).digest('hex');
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'claude-md-coordinator.cjs'),
      `const handshake = { schemaVersion: 1, engineVersion: "9.9.9", sourceSha256: "${sourceSha256}" };
if (process.argv[2] === "--handshake") process.stdout.write(JSON.stringify(handshake));
else process.stdout.write(JSON.stringify({ ok: false, exitCode: 0, error: "rejected" }));
`,
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: { ...process.env, HOME: fixture.homeRoot },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('ok/exit disagreement');
    expect(existsSync(join(fixture.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('fails closed when the coordinator handshake is malformed', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->
# Canonical CLAUDE
<!-- OMC:END -->
`);
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'claude-md-coordinator.cjs'),
      'if (process.argv[2] === "--handshake") process.stdout.write("not json");\n',
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: { ...process.env, HOME: fixture.homeRoot },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Coordinator handshake validation failed');
    expect(existsSync(join(fixture.projectRoot, '.claude'))).toBe(false);
  });

  it('fails closed when the coordinator handshake source hash differs from the canonical file', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->
# Canonical CLAUDE
<!-- OMC:END -->
`);
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'claude-md-coordinator.cjs'),
      'if (process.argv[2] === "--handshake") process.stdout.write(JSON.stringify({ schemaVersion: 1, engineVersion: "9.9.9", sourceSha256: "0".repeat(64) }));\n',
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: { ...process.env, HOME: fixture.homeRoot },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Coordinator handshake validation failed');
    expect(existsSync(join(fixture.projectRoot, '.claude'))).toBe(false);
  });

  it('refuses to install a canonical source that lacks OMC markers', () => {
    const fixture = createPluginFixture(`# oh-my-claudecode (OMC) v9.9.9 Summary

This is a summarized CLAUDE.md without markers.
`);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('missing required OMC markers');
    expect(existsSync(join(fixture.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('adds a local git exclude block for .omc artifacts while preserving .omc/skills', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const excludePath = join(fixture.projectRoot, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);

    const excludeContents = readFileSync(excludePath, 'utf-8');
    expect(excludeContents).toContain('# BEGIN OMC local artifacts');
    expect(excludeContents).toContain('!.omc/');
    expect(excludeContents).toContain('.omc/*');
    expect(excludeContents).toContain('!.omc/skills/');
    expect(excludeContents).toContain('!.omc/skills/**');
    expect(excludeContents).toContain('.omx/');
    expect(excludeContents).toContain('# END OMC local artifacts');
  });

  it('keeps the local git exclude block aligned with the tracked root .gitignore skill exceptions', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const repoGitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8');
    expect(repoGitignore).toContain('!.omc/');
    expect(repoGitignore).toContain('.omc/*');
    expect(repoGitignore).toContain('!.omc/skills/');
    expect(repoGitignore).toContain('!.omc/skills/**');
    expect(repoGitignore).toContain('.omx/');

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);

    const excludePath = join(fixture.projectRoot, '.git', 'info', 'exclude');
    const excludeContents = readFileSync(excludePath, 'utf-8');
    expect(excludeContents).toContain('!.omc/');
    expect(excludeContents).toContain('.omc/*');
    expect(excludeContents).toContain('!.omc/skills/');
    expect(excludeContents).toContain('!.omc/skills/**');
    expect(excludeContents).toContain('.omx/');
  });

  it('local git exclude block keeps .omc/skills trackable while ignoring sibling .omc artifacts and .omx runtime cache', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const seedExclude = join(fixture.projectRoot, '.git', 'info', 'exclude');
    writeFileSync(seedExclude, '.omc/\n');

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);

    const skillDir = join(fixture.projectRoot, '.omc', 'skills');
    const stateDir = join(fixture.projectRoot, '.omc', 'state');
    const omxStateDir = join(fixture.projectRoot, '.omx', 'state');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(omxStateDir, { recursive: true });
    writeFileSync(join(skillDir, 'example.md'), 'skill');
    writeFileSync(join(stateDir, 'example.json'), '{}');
    writeFileSync(join(omxStateDir, 'runtime.json'), '{}');

    const skillIgnore = spawnSync('git', ['check-ignore', '-v', '.omc/skills/example.md'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(skillIgnore.status).toBe(0);
    expect(skillIgnore.stdout).toContain('!.omc/skills/**');

    const stateIgnore = spawnSync('git', ['check-ignore', '-v', '.omc/state/example.json'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(stateIgnore.status).toBe(0);
    expect(stateIgnore.stdout).toContain('.omc/*');

    const omxStateIgnore = spawnSync('git', ['check-ignore', '-v', '.omx/state/runtime.json'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(omxStateIgnore.status).toBe(0);
    expect(omxStateIgnore.stdout).toContain('.omx/');

    const status = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(status.status).toBe(0);
    expect(status.stdout).not.toContain('.omx/');
    expect(status.stdout).not.toContain('.omc/state/');
    expect(status.stdout).toContain('.omc/skills/example.md');
  });

  it('updates an existing local git exclude block to ignore .omx runtime cache', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const excludePath = join(fixture.projectRoot, '.git', 'info', 'exclude');
    writeFileSync(excludePath, `# BEGIN OMC local artifacts
!.omc/
.omc/*
!.omc/skills/
!.omc/skills/**
# END OMC local artifacts
`);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);

    const excludeContents = readFileSync(excludePath, 'utf-8');
    expect(excludeContents.match(/# BEGIN OMC local artifacts/g)).toHaveLength(1);
    expect(excludeContents.match(/^\.omx\/$/gm)).toHaveLength(1);
    expect(`${result.stdout}
${result.stderr}`).toContain('Updated OMC git exclude for local OMX artifacts');
  });

  it('does not duplicate the local git exclude block on repeated local setup runs', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const firstRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(firstRun.status).toBe(0);

    const secondRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(secondRun.status).toBe(0);

    const excludeContents = readFileSync(join(fixture.projectRoot, '.git', 'info', 'exclude'), 'utf-8');
    expect(excludeContents.match(/# BEGIN OMC local artifacts/g)).toHaveLength(1);
  });

  it('removes only exact static 583/292-line legacy guides, preserves surrounding bytes, reports a byte-identical backup, and is idempotent', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->
# Canonical CLAUDE
<!-- OMC:END -->
`);
    const targetPath = join(fixture.projectRoot, '.claude', 'CLAUDE.md');
    const before = 'before legacy\r\n';
    const between = 'between legacy\r\n';
    const after = 'after legacy';
    const original = `${before}${LEGACY_583_LINE_GUIDE}${between}${LEGACY_292_LINE_GUIDE}${after}`;
    mkdirSync(join(fixture.projectRoot, '.claude'), { recursive: true });
    writeFileSync(targetPath, original, 'utf-8');

    const env = { ...process.env, HOME: fixture.homeRoot };
    const first = spawnSync('bash', [fixture.scriptPath, 'local'], { cwd: fixture.projectRoot, env, encoding: 'utf-8' });
    expect(first.status).toBe(0);
    const backup = `${first.stdout}\n${first.stderr}`.match(/Coordinator backup: (.+)/)?.[1];
    expect(backup).toBeTruthy();
    expect(readFileSync(backup!, 'utf-8')).toBe(original);

    const installed = readFileSync(targetPath, 'utf-8');
    const preservedUserBytes = `${before}${between}${after}`;
    expect(installed).toContain('<!-- OMC:START -->');
    expect(installed).toContain('<!-- User customizations -->\n' + preservedUserBytes);
    expect(installed).not.toContain(LEGACY_583_LINE_GUIDE);
    expect(installed).not.toContain(LEGACY_292_LINE_GUIDE);

    const second = spawnSync('bash', [fixture.scriptPath, 'local'], { cwd: fixture.projectRoot, env, encoding: 'utf-8' });
    expect(second.status).toBe(0);
    expect(readFileSync(targetPath, 'utf-8')).toBe(installed);
  });

  it('uses CLAUDE_CONFIG_DIR for global setup targets and plugin verification', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(join(configDir, 'hooks'), { recursive: true });
    writeFileSync(join(configDir, 'hooks', 'keyword-detector.sh'), 'legacy');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(configDir, 'skills', 'omc-reference', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(configDir, 'hooks', 'keyword-detector.sh'))).toBe(true);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Plugin verified');
    expect(`${result.stdout}\n${result.stderr}`).toContain('Preserved unverified legacy hook');
  });

  it('does not warn for third-party-only settings hooks', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        plugins: ['oh-my-claudecode'],
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'node /opt/vendor/hooks/third-party-stop.js' }],
            },
          ],
        },
      }),
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('legacy OMC hook entries');
  });

  it('warns when settings hooks reference a legacy OMC hook command', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        plugins: ['oh-my-claudecode'],
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '$HOME/.claude/hooks/keyword-detector.sh' }],
            },
          ],
        },
      }),
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('legacy OMC hook entries');
  });

  it('does not advise deleting the whole hooks section when hooks are mixed', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        plugins: ['oh-my-claudecode'],
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: 'node /opt/vendor/hooks/third-party-stop.js' },
                { type: 'command', command: '$HOME/.claude/hooks/session-start.sh' },
              ],
            },
          ],
        },
      }),
    );

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain('legacy OMC hook entries');
    expect(output).not.toContain('Remove the "hooks" section');
    expect(output).toContain('third-party hook entries can remain');
  });

  it('overwrites an existing global CLAUDE.md by default when preserve mode is not requested', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude).toContain('<!-- OMC:START -->');
    expect(baseClaude).toContain('<!-- OMC:END -->');
    expect(baseClaude).toContain('<!-- User customizations -->');
    expect(baseClaude).toContain('# User CLAUDE');
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(false);
  });

  it('preserves an existing global CLAUDE.md when preserve mode is explicitly requested', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    const companionClaude = readFileSync(join(configDir, 'CLAUDE-omc.md'), 'utf-8');

    expect(baseClaude).toContain('# User CLAUDE');
    expect(baseClaude).toContain('Keep my base config.');
    expect(baseClaude).toContain('<!-- OMC:IMPORT:START -->');
    expect(baseClaude).toContain('@CLAUDE-omc.md');
    expect(baseClaude).toContain('<!-- OMC:IMPORT:END -->');
    expect(baseClaude).not.toContain('<!-- OMC:START -->');

    expect(companionClaude).toContain('<!-- OMC:START -->');
    expect(companionClaude).toContain('<!-- OMC:END -->');
    expect(companionClaude).toContain('<!-- OMC:VERSION:9.9.9 -->');
    expect(companionClaude).toContain('# Canonical CLAUDE');
  });

  it('updates the preserved companion file idempotently without duplicating the managed import block', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const env = {
      ...process.env,
      HOME: fixture.homeRoot,
      CLAUDE_CONFIG_DIR: configDir,
    };

    const first = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(first.status).toBe(0);

    const second = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(second.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude.match(/<!-- OMC:IMPORT:START -->/g)).toHaveLength(1);
    expect(baseClaude.match(/@CLAUDE-omc\.md/g)).toHaveLength(1);
    expect(readFileSync(join(configDir, 'CLAUDE-omc.md'), 'utf-8')).toContain('<!-- OMC:VERSION:9.9.9 -->');
  });

  it('cleans up orphaned companion file when switching from preserve to overwrite mode', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const env = {
      ...process.env,
      HOME: fixture.homeRoot,
      CLAUDE_CONFIG_DIR: configDir,
    };

    // Run 1: preserve mode — creates companion + import block
    const first = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(first.status).toBe(0);
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(true);
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8')).toContain('<!-- OMC:IMPORT:START -->');

    // Run 2: overwrite mode (default) — must clean up companion and import block
    const second = spawnSync('bash', [fixture.scriptPath, 'global', 'overwrite'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(second.status).toBe(0);

    // Companion file must be removed
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(false);

    // CLAUDE.md must have OMC markers inline, not an import block
    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude).toContain('<!-- OMC:START -->');
    expect(baseClaude).toContain('<!-- OMC:END -->');
    expect(baseClaude).not.toContain('<!-- OMC:IMPORT:START -->');
    expect(baseClaude).not.toContain('@CLAUDE-omc.md');

    // User content should be preserved
    expect(baseClaude).toContain('# User CLAUDE');
  });

  it('refuses preserve mode when the companion path is a symlink', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const realTarget = join(fixture.homeRoot, 'outside-target.md');
    writeFileSync(realTarget, 'outside target');
    symlinkSync(realTarget, join(configDir, 'CLAUDE-omc.md'));

    const result = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Refusing symlink');
    expect(readFileSync(realTarget, 'utf-8')).toBe('outside target');
  });
});

describe('setup-claude-md.sh stale CLAUDE_PLUGIN_ROOT resolution', () => {
  it('does not prefer a newer cache directory when it is missing required plugin assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-invalid-newer-cache-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newerInvalid = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    // Newer directory exists but is missing docs/CLAUDE.md
    mkdirSync(newerInvalid, { recursive: true });

    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'oh-my-claudecode@omc': [
          {
            installPath: oldVersion,
            version: '4.8.2',
          },
        ],
      }),
    );

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(join(homeRoot, '.claude', 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.8.2 -->');
    expect(installed).toContain('# Old Version');
  });

  it('ignores non-semver cache directories when selecting latest fallback version', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-ignore-non-semver-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const suffixedInvalid = join(cacheBase, '4.10.0.tmp');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n# Old\n<!-- OMC:END -->\n`);
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(join(newVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n# New\n<!-- OMC:END -->\n`);
    installSetupSurface(newVersion);
    buildCoordinatorFixture(newVersion, readFileSync(join(newVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.9.0');

    // Should be ignored by strict semver selection.
    mkdirSync(suffixedInvalid, { recursive: true });
    writeFileSync(join(suffixedInvalid, 'junk.txt'), 'not a plugin root');

    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(homeRoot, '.claude', 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    // No installed_plugins.json => fallback scan path
    const result = spawnSync('bash', [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).not.toContain('4.10.0.tmp');
  });

  it('prefers newer cache version when installed_plugins.json points to an existing but stale older version', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-json-old-version-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    // Script runs from old version path
    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    const staleMutationSentinel = join(root, 'stale-launcher-mutated');
    const oldSetupPath = join(oldVersion, 'scripts', 'setup-claude-md.sh');
    writeFileSync(
      oldSetupPath,
      readFileSync(oldSetupPath, 'utf-8').replace(
        'ensure_local_omc_git_exclude() {',
        `ensure_local_omc_git_exclude() { touch "${staleMutationSentinel}";`,
      ),
    );
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    // Newer cache version exists
    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`,
    );
    installSetupSurface(newVersion);
    buildCoordinatorFixture(newVersion, readFileSync(join(newVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.9.0');

    // installed_plugins.json still points at the old but existing path
    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'oh-my-claudecode@omc': [
          {
            installPath: oldVersion,
            version: '4.8.2',
          },
        ],
      }),
    );

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).toContain('# New Version');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
    expect(existsSync(staleMutationSentinel)).toBe(false);
  });

  it('uses docs/CLAUDE.md from the active version in installed_plugins.json, not the stale script location', () => {
    // Simulate: script lives at old version (4.8.2), but installed_plugins.json points to new version (4.9.0)
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-root-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    // Create old version (where the script will be copied)
    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    // Create new version (the active one)
    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`,
    );
    installSetupSurface(newVersion);
    buildCoordinatorFixture(newVersion, readFileSync(join(newVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.9.0');

    // Create installed_plugins.json pointing to the new version
    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'oh-my-claudecode@omc': [
          {
            installPath: newVersion,
            version: '4.9.0',
          },
        ],
      }),
    );

    // Create project dir and settings.json (needed for plugin verification)
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    // Run the OLD version's script — it should resolve to the NEW version's docs/CLAUDE.md
    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    // Should contain the NEW version, not the old one
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).toContain('# New Version');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });

  it('uses docs/CLAUDE.md from the active version when installed_plugins.json wraps plugins under a plugins key', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-wrapped-root-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`,
    );
    installSetupSurface(newVersion);
    buildCoordinatorFixture(newVersion, readFileSync(join(newVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.9.0');

    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'oh-my-claudecode@omc': [
            {
              installPath: newVersion,
              version: '4.9.0',
            },
          ],
        },
      }),
    );

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).toContain('# New Version');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });

  it('falls back to scanning cache for latest version when installed_plugins.json is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-fallback-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    // Create old version (where the script lives)
    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old\n<!-- OMC:END -->\n`,
    );
    buildCoordinatorFixture(oldVersion, readFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.8.2');

    // Create new version (no installed_plugins.json, relies on cache scan)
    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New\n<!-- OMC:END -->\n`,
    );
    installSetupSurface(newVersion);
    buildCoordinatorFixture(newVersion, readFileSync(join(newVersion, 'docs', 'CLAUDE.md'), 'utf-8'), '4.9.0');

    // No installed_plugins.json — fallback to cache scan
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });
});
