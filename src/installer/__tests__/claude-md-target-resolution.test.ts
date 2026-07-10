import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const originalHome = process.env.HOME;

let tempRoot: string;
let testClaudeDir: string;
let testHomeDir: string;

async function loadInstaller() {
  vi.resetModules();
  return import('../index.js');
}

describe('install() CLAUDE.md target resolution', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-claude-target-'));
    testClaudeDir = join(tempRoot, 'global-claude');
    testHomeDir = join(tempRoot, 'home');

    mkdirSync(testClaudeDir, { recursive: true });
    mkdirSync(testHomeDir, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
    process.env.HOME = testHomeDir;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });

    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }

    if (originalPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }

    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('updates ~/.claude/CLAUDE.md even when ~/CLAUDE.md exists', async () => {
    const configClaudePath = join(testClaudeDir, 'CLAUDE.md');
    const homeClaudePath = join(testHomeDir, 'CLAUDE.md');

    writeFileSync(homeClaudePath, '# Home CLAUDE\nkeep me\n');
    writeFileSync(
      configClaudePath,
      '<!-- OMC:START -->\n<!-- OMC:VERSION:0.0.1 -->\n# Old OMC\nstale installer content\n<!-- OMC:END -->\n',
    );

    const { install, VERSION } = await loadInstaller();
    const result = install({
      force: true,
      skipClaudeCheck: true,
      skipHud: true,
    });

    const updatedConfig = readFileSync(configClaudePath, 'utf-8');

    expect(result.success).toBe(true);
    expect(updatedConfig).toContain(`<!-- OMC:VERSION:${VERSION} -->`);
    expect(updatedConfig).not.toContain('stale installer content');
    expect(readFileSync(homeClaudePath, 'utf-8')).toBe('# Home CLAUDE\nkeep me\n');

    const backups = readdirSync(testClaudeDir).filter(name => name.startsWith('CLAUDE.md.backup.'));
    expect(backups).toHaveLength(1);
  });

  it('shrinks a CLAUDE.md bloated with a legacy pre-marker guide (does not grow)', async () => {
    const configClaudePath = join(testClaudeDir, 'CLAUDE.md');
    const legacyGuide = readFileSync(
      new URL('./fixtures/legacy-guide-583.md', import.meta.url),
      'utf-8',
    ).replace(/\n+$/, '');

    // Simulate a pre-marker upgrade artifact: current marker block on top, the
    // 583-line legacy guide preserved as "user customizations", plus a real
    // user include that must survive.
    const bloated =
      '<!-- OMC:START -->\n<!-- OMC:VERSION:0.0.1 -->\n# Old OMC\n<!-- OMC:END -->\n\n' +
      `<!-- User customizations -->\n${legacyGuide}\n\n@RTK.md\n`;
    writeFileSync(configClaudePath, bloated);

    const { install } = await loadInstaller();
    const result = install({ force: true, skipClaudeCheck: true, skipHud: true });

    const updated = readFileSync(configClaudePath, 'utf-8');

    expect(result.success).toBe(true);
    expect(updated.length).toBeLessThan(bloated.length); // shrinks, never grows
    expect(updated).not.toContain('You are a CONDUCTOR, not a performer');
    expect(updated).toContain('@RTK.md'); // real user content preserved

    const backups = readdirSync(testClaudeDir).filter(name => name.startsWith('CLAUDE.md.backup.'));
    expect(backups).toHaveLength(1); // original safely backed up before overwrite
  });

  it('preserves project-scoped behavior by skipping global CLAUDE.md writes', async () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(tempRoot, 'project', '.claude', 'plugins', 'oh-my-claudecode');
    writeFileSync(join(testHomeDir, 'CLAUDE.md'), '# Home CLAUDE\nkeep me\n');

    const { install } = await loadInstaller();
    const result = install({
      force: true,
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(testClaudeDir, 'CLAUDE.md'))).toBe(false);
  });
});
