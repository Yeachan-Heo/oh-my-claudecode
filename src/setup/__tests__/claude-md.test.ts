/**
 * Tests for src/setup/claude-md.ts
 *
 * Coverage:
 *   - All 22 numbered behaviors (Phase 1 port of setup-claude-md.sh)
 *   - H1-H15 scenario matrix (CLAUDE.md pre-state variations)
 *
 * Fixture strategy: tests build pre-state fixtures inline into a per-test
 * tmpdir (simpler than shipping static files; the one file we DO ship
 * statically is `tests/fixtures/legacy/setup-claude-md.sh.pre-refactor`
 * for the parity test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  backupIfExists,
  cleanupLegacyHooks,
  cleanupOrphanedCompanion,
  DOWNLOAD_URL,
  ensureLocalOmcGitExclude,
  ensureManagedCompanionImport,
  ensureNotSymlinkPath,
  extractOldVersion,
  installClaudeMd,
  installPreserveMode,
  loadCanonicalOmcContent,
  mergeClaudeMd,
  mergeOmcBlock,
  migrateNoMarkers,
  reportPluginStatus,
  reportVersionChange,
  resolveTargetPaths,
  stripOmcMarkers,
  validateOmcMarkers,
  validatePostWrite,
  warnLegacyHooksInSettings,
  writeWrappedOmcFile,
} from '../claude-md.js';

// ────────────────────────── test infrastructure ─────────────────────────

const START_MARKER = '<!-- OMC:START -->';
const END_MARKER = '<!-- OMC:END -->';
const IMPORT_START = '<!-- OMC:IMPORT:START -->';
const IMPORT_END = '<!-- OMC:IMPORT:END -->';
const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
const USER_CUSTOMIZATIONS_RECOVERED = '<!-- User customizations (recovered from corrupted markers) -->';
const USER_CUSTOMIZATIONS_MIGRATED = '<!-- User customizations (migrated from previous CLAUDE.md) -->';

const CANONICAL_V1 = `${START_MARKER}
<!-- OMC:VERSION:1.0.0 -->

# oh-my-claudecode v1
${END_MARKER}
`;

const CANONICAL_V2 = `${START_MARKER}
<!-- OMC:VERSION:2.0.0 -->

# oh-my-claudecode v2
${END_MARKER}
`;

/**
 * Builds a temporary fake plugin root containing `docs/CLAUDE.md` (and
 * optionally `skills/omc-reference/SKILL.md`) so `installClaudeMd()` has a
 * canonical source to read without hitting the network.
 */
function makePluginRoot(
  root: string,
  canonicalContent: string = CANONICAL_V2,
  skillContent: string = '# omc-reference skill\n',
): string {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), canonicalContent, 'utf8');
  mkdirSync(join(root, 'skills', 'omc-reference'), { recursive: true });
  writeFileSync(join(root, 'skills', 'omc-reference', 'SKILL.md'), skillContent, 'utf8');
  return root;
}

let tmpRoot: string;
let configDir: string;
let cwd: string;
let pluginRoot: string;
const logs: string[] = [];

function logger(line: string): void {
  logs.push(line);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'omc-claude-md-test-'));
  configDir = join(tmpRoot, 'config');
  cwd = join(tmpRoot, 'cwd');
  pluginRoot = makePluginRoot(join(tmpRoot, 'plugin'));
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  logs.length = 0;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function runInstall(
  overrides: Parameters<typeof installClaudeMd>[0],
): ReturnType<typeof installClaudeMd> {
  return installClaudeMd({
    configDir,
    cwd,
    pluginRoot,
    logger,
    ...overrides,
  });
}

// ─────────────────────────────── helpers ────────────────────────────────

describe('ensureNotSymlinkPath (additional helper)', () => {
  it('does nothing when path does not exist', () => {
    expect(() => ensureNotSymlinkPath(join(tmpRoot, 'nope.md'), 'CLAUDE.md')).not.toThrow();
  });

  it('does nothing when path is a regular file', () => {
    const p = join(tmpRoot, 'real.md');
    writeFileSync(p, 'hi', 'utf8');
    expect(() => ensureNotSymlinkPath(p, 'CLAUDE.md')).not.toThrow();
  });

  it('throws with exact error text when path is a symlink', () => {
    const target = join(tmpRoot, 'target.md');
    const link = join(tmpRoot, 'link.md');
    writeFileSync(target, 'x', 'utf8');
    symlinkSync(target, link);
    expect(() => ensureNotSymlinkPath(link, 'CLAUDE.md')).toThrow(
      `Refusing to write CLAUDE.md because the destination is a symlink: ${link}`,
    );
  });
});

describe('ensureManagedCompanionImport (additional helper)', () => {
  it('writes a fresh import block when target is missing', () => {
    const p = join(tmpRoot, 'base', 'CLAUDE.md');
    ensureManagedCompanionImport(p, 'CLAUDE-omc.md');
    const content = readFileSync(p, 'utf8');
    expect(content).toBe(`${IMPORT_START}\n@CLAUDE-omc.md\n${IMPORT_END}\n`);
  });

  it('appends a fresh import block after existing non-empty content', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, '# user content\n', 'utf8');
    ensureManagedCompanionImport(p, 'CLAUDE-omc.md');
    const content = readFileSync(p, 'utf8');
    expect(content).toBe(`# user content\n\n\n${IMPORT_START}\n@CLAUDE-omc.md\n${IMPORT_END}\n`);
  });

  it('refreshes an existing import block without duplicating it', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(
      p,
      `# user\n\n${IMPORT_START}\n@OLD.md\n${IMPORT_END}\n\n# more user\n`,
      'utf8',
    );
    ensureManagedCompanionImport(p, 'CLAUDE-omc.md');
    const content = readFileSync(p, 'utf8');
    expect((content.match(new RegExp(IMPORT_START, 'g')) ?? []).length).toBe(1);
    expect(content).toContain('@CLAUDE-omc.md');
    expect(content).not.toContain('@OLD.md');
    expect(content).toContain('# user');
    expect(content).toContain('# more user');
  });
});

// ───────────────────────── numbered behaviors ───────────────────────────

describe('Behavior #2 — ensureLocalOmcGitExclude', () => {
  function initGit(dir: string): void {
    const r = spawnSync('git', ['init', '-q'], { cwd: dir });
    expect(r.status).toBe(0);
  }

  it('is a no-op outside a git repository', () => {
    ensureLocalOmcGitExclude({ cwd, logger });
    expect(logs).toContain('Skipped OMC git exclude setup (not a git repository)');
  });

  it('writes the exclude block into a fresh repo (empty exclude file)', () => {
    initGit(cwd);
    ensureLocalOmcGitExclude({ cwd, logger });
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    const content = readFileSync(excludePath, 'utf8');
    expect(content).toContain('# BEGIN OMC local artifacts');
    expect(content).toContain('.omc/*');
    expect(content).toContain('!.omc/skills/');
    expect(content).toContain('!.omc/skills/**');
    expect(content).toContain('# END OMC local artifacts');
    expect(logs.at(-1)).toBe('Configured git exclude for local .omc artifacts (preserving .omc/skills/)');
  });

  it('is idempotent — second call does not duplicate the block (H14)', () => {
    initGit(cwd);
    ensureLocalOmcGitExclude({ cwd, logger });
    ensureLocalOmcGitExclude({ cwd, logger });
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    const content = readFileSync(excludePath, 'utf8');
    const count = (content.match(/# BEGIN OMC local artifacts/g) ?? []).length;
    expect(count).toBe(1);
    expect(logs).toContain('OMC git exclude already configured');
  });

  it('prepends a newline before the block when the exclude file is non-empty', () => {
    initGit(cwd);
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    writeFileSync(excludePath, '# existing rule\n*.log', 'utf8');
    ensureLocalOmcGitExclude({ cwd, logger });
    const content = readFileSync(excludePath, 'utf8');
    expect(content.startsWith('# existing rule\n*.log\n# BEGIN OMC')).toBe(true);
  });

  it('does NOT prepend a newline when the exclude file is empty', () => {
    initGit(cwd);
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    // Overwrite to empty (git init writes a default commented file; empty it).
    writeFileSync(excludePath, '', 'utf8');
    ensureLocalOmcGitExclude({ cwd, logger });
    const content = readFileSync(excludePath, 'utf8');
    expect(content.startsWith('# BEGIN OMC')).toBe(true);
  });
});

describe('Behavior #4 — resolveTargetPaths', () => {
  it('returns local paths relative to cwd', () => {
    const paths = resolveTargetPaths('local', configDir, cwd);
    expect(paths.targetPath).toBe(join(cwd, '.claude', 'CLAUDE.md'));
    expect(paths.skillTargetPath).toBe(join(cwd, '.claude', 'skills', 'omc-reference', 'SKILL.md'));
    expect(paths.companionPath).toBe(join(cwd, '.claude', 'CLAUDE-omc.md'));
  });

  it('returns global paths under configDir', () => {
    const paths = resolveTargetPaths('global', configDir, cwd);
    expect(paths.targetPath).toBe(join(configDir, 'CLAUDE.md'));
    expect(paths.skillTargetPath).toBe(join(configDir, 'skills', 'omc-reference', 'SKILL.md'));
    expect(paths.companionPath).toBe(join(configDir, 'CLAUDE-omc.md'));
  });
});

describe('Behavior #5 — install-style validation', () => {
  it('throws for invalid mode', async () => {
    await expect(
      installClaudeMd({ mode: 'nope' as unknown as 'local', configDir, cwd, pluginRoot, logger }),
    ).rejects.toThrow(/Invalid mode/);
  });

  it('throws for invalid install style', async () => {
    await expect(
      installClaudeMd({
        mode: 'global',
        installStyle: 'bogus' as unknown as 'overwrite',
        configDir,
        cwd,
        pluginRoot,
        logger,
      }),
    ).rejects.toThrow(/Invalid install style/);
  });
});

describe('Behavior #6 — extractOldVersion', () => {
  it('returns "none" when the file is missing', () => {
    expect(extractOldVersion(join(tmpRoot, 'ghost.md'))).toBe('none');
  });

  it('extracts the version from OMC:VERSION marker', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, `${START_MARKER}\n<!-- OMC:VERSION:4.2.1 -->\n...\n${END_MARKER}\n`, 'utf8');
    expect(extractOldVersion(p)).toBe('4.2.1');
  });

  it('falls back to the runtime version when file exists but lacks marker', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, '# legacy content\n', 'utf8');
    const result = extractOldVersion(p);
    // Should return some semver-looking string from the package.
    expect(result).toMatch(/^\d+\.\d+/);
    expect(result).not.toBe('none');
  });
});

describe('Behavior #7 — backupIfExists', () => {
  it('no-ops when the file is missing', () => {
    const r = backupIfExists(join(tmpRoot, 'ghost.md'), { logger });
    expect(r.backupPath).toBeNull();
    expect(r.backupDate).toBe('');
  });

  it('creates a timestamped backup copy', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, 'contents', 'utf8');
    const fixed = new Date(Date.UTC(2026, 3, 11, 12, 34, 56));
    const r = backupIfExists(p, { logger, now: fixed });
    expect(r.backupPath).not.toBeNull();
    expect(r.backupDate).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}$/);
    expect(r.backupPath).toBe(`${p}.backup.${r.backupDate}`);
    expect(existsSync(r.backupPath as string)).toBe(true);
    expect(readFileSync(r.backupPath as string, 'utf8')).toBe('contents');
    expect(logs[0]).toBe(`Backed up existing CLAUDE.md to ${r.backupPath}`);
  });
});

describe('Behavior #8 — loadCanonicalOmcContent', () => {
  it('reads from <pluginRoot>/docs/CLAUDE.md when present', async () => {
    const r = await loadCanonicalOmcContent(pluginRoot);
    expect(r.content).toContain(START_MARKER);
    expect(r.sourceLabel).toBe(join(pluginRoot, 'docs', 'CLAUDE.md'));
  });

  it('falls back to $CLAUDE_PLUGIN_ROOT/docs/CLAUDE.md when primary missing', async () => {
    const altRoot = makePluginRoot(join(tmpRoot, 'altPlugin'), CANONICAL_V1);
    const original = process.env['CLAUDE_PLUGIN_ROOT'];
    process.env['CLAUDE_PLUGIN_ROOT'] = altRoot;
    try {
      const missingRoot = join(tmpRoot, 'missing');
      const r = await loadCanonicalOmcContent(missingRoot);
      expect(r.sourceLabel).toBe(join(altRoot, 'docs', 'CLAUDE.md'));
      expect(r.content).toContain('<!-- OMC:VERSION:1.0.0 -->');
    } finally {
      if (original === undefined) delete process.env['CLAUDE_PLUGIN_ROOT'];
      else process.env['CLAUDE_PLUGIN_ROOT'] = original;
    }
  });

  it('falls back to GitHub fetch when neither path exists', async () => {
    const original = process.env['CLAUDE_PLUGIN_ROOT'];
    delete process.env['CLAUDE_PLUGIN_ROOT'];
    try {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => CANONICAL_V2,
      } as Response);
      const missingRoot = join(tmpRoot, 'missing');
      const r = await loadCanonicalOmcContent(missingRoot, { fetchImpl });
      expect(fetchImpl).toHaveBeenCalledWith(DOWNLOAD_URL);
      expect(r.sourceLabel).toBe(DOWNLOAD_URL);
      expect(r.content).toContain(START_MARKER);
    } finally {
      if (original !== undefined) process.env['CLAUDE_PLUGIN_ROOT'] = original;
    }
  });

  it('throws a descriptive error when GitHub fetch fails', async () => {
    const original = process.env['CLAUDE_PLUGIN_ROOT'];
    delete process.env['CLAUDE_PLUGIN_ROOT'];
    try {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ENETDOWN'));
      const missingRoot = join(tmpRoot, 'missing');
      await expect(loadCanonicalOmcContent(missingRoot, { fetchImpl })).rejects.toThrow(/Failed to download CLAUDE\.md/);
    } finally {
      if (original !== undefined) process.env['CLAUDE_PLUGIN_ROOT'] = original;
    }
  });
});

describe('Behavior #9 — validateOmcMarkers', () => {
  it('accepts content with both markers', () => {
    expect(() => validateOmcMarkers(`${START_MARKER}\n...\n${END_MARKER}`, 'src')).not.toThrow();
  });

  it('throws when START marker is missing', () => {
    expect(() => validateOmcMarkers(`...\n${END_MARKER}`, 'src')).toThrow(/missing required OMC markers: src/);
  });

  it('throws when END marker is missing', () => {
    expect(() => validateOmcMarkers(`${START_MARKER}\n...`, 'src')).toThrow(/missing required OMC markers/);
  });
});

describe('Behavior #10 — stripOmcMarkers', () => {
  it('returns inner content between markers (exclusive of marker lines)', () => {
    const input = `${START_MARKER}\n<!-- OMC:VERSION:1.2.3 -->\nhello\n${END_MARKER}\n`;
    const result = stripOmcMarkers(input);
    expect(result).toBe('<!-- OMC:VERSION:1.2.3 -->\nhello');
  });

  it('is idempotent — a second strip on the inner content returns it unchanged', () => {
    const input = `${START_MARKER}\nbody\n${END_MARKER}\n`;
    const once = stripOmcMarkers(input);
    expect(stripOmcMarkers(once)).toBe(once);
  });

  it('returns the input unchanged when markers are missing', () => {
    expect(stripOmcMarkers('no markers here')).toBe('no markers here');
  });
});

describe('Behavior #11 — writeWrappedOmcFile', () => {
  it('wraps content in START/END markers', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeWrappedOmcFile(p, 'inner body');
    const content = readFileSync(p, 'utf8');
    expect(content).toBe(`${START_MARKER}\ninner body\n${END_MARKER}\n`);
  });

  it('does not double-up trailing newlines when content already ends with \\n', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeWrappedOmcFile(p, 'inner body\n');
    const content = readFileSync(p, 'utf8');
    expect(content).toBe(`${START_MARKER}\ninner body\n${END_MARKER}\n`);
  });

  it('refuses to write to a symlink', () => {
    const target = join(tmpRoot, 'target.md');
    const link = join(tmpRoot, 'link.md');
    writeFileSync(target, 'x', 'utf8');
    symlinkSync(target, link);
    expect(() => writeWrappedOmcFile(link, 'body')).toThrow(/symlink/);
  });
});

describe('Behavior #12 — mergeClaudeMd / mergeOmcBlock', () => {
  it('mergeOmcBlock delegates to mergeClaudeMd', () => {
    expect(mergeOmcBlock('existing', 'omc')).toBe(mergeClaudeMd('existing', 'omc'));
  });

  it('fresh install wraps content in markers', () => {
    const result = mergeClaudeMd(null, 'body');
    expect(result).toBe(`${START_MARKER}\nbody\n${END_MARKER}\n`);
  });

  it('clean-strip branch preserves user content outside markers', () => {
    const existing = `Header\n${START_MARKER}\nold\n${END_MARKER}\nFooter`;
    const result = mergeClaudeMd(existing, 'newbody');
    expect(result).toBe(`${START_MARKER}\nnewbody\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\nHeader\nFooter`);
  });

  it('corrupted-marker recovery branch appends original content under recovery header', () => {
    const corrupted = `${START_MARKER}\nlonely start`;
    const result = mergeClaudeMd(corrupted, 'newbody');
    expect(result).toContain(USER_CUSTOMIZATIONS_RECOVERED);
    expect(result).toContain('lonely start');
    // Only one pair of markers total (recovered section has markers stripped).
    expect((result.match(new RegExp(START_MARKER, 'g')) ?? []).length).toBe(1);
  });

  it('injects explicit version marker when passed', () => {
    const result = mergeClaudeMd(null, 'body', '4.2.1');
    expect(result).toContain('<!-- OMC:VERSION:4.2.1 -->');
  });
});

describe('Behavior #13 — installPreserveMode', () => {
  it('writes companion + import block when base file is present', () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    const companionPath = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(targetPath, '# user base\n', 'utf8');
    installPreserveMode({
      targetPath,
      companionPath,
      omcContent: 'omc inner',
      backupDate: '2026-04-11_120000',
      logger,
    });
    // Companion wrapped
    expect(readFileSync(companionPath, 'utf8')).toBe(`${START_MARKER}\nomc inner\n${END_MARKER}\n`);
    // Base still has user content plus import block
    const baseContent = readFileSync(targetPath, 'utf8');
    expect(baseContent).toContain('# user base');
    expect(baseContent).toContain(IMPORT_START);
    expect(baseContent).toContain('@CLAUDE-omc.md');
    expect(baseContent).toContain(IMPORT_END);
  });

  it('backs up existing companion with the same backupDate', () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    const companionPath = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(targetPath, '# user\n', 'utf8');
    writeFileSync(companionPath, '# old companion\n', 'utf8');
    installPreserveMode({
      targetPath,
      companionPath,
      omcContent: 'v2',
      backupDate: '2026-04-11_130000',
      logger,
    });
    const backup = `${companionPath}.backup.2026-04-11_130000`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe('# old companion\n');
  });

  it('refuses when base CLAUDE.md is a symlink', () => {
    const realBase = join(configDir, 'real-base.md');
    const targetPath = join(configDir, 'CLAUDE.md');
    const companionPath = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(realBase, '# real', 'utf8');
    symlinkSync(realBase, targetPath);
    expect(() =>
      installPreserveMode({
        targetPath,
        companionPath,
        omcContent: 'v',
        backupDate: '',
        logger,
      }),
    ).toThrow(/Refusing to write base CLAUDE\.md import block because the destination is a symlink/);
  });

  it('refuses when companion CLAUDE-omc.md is a symlink', () => {
    const realComp = join(configDir, 'real-comp.md');
    const targetPath = join(configDir, 'CLAUDE.md');
    const companionPath = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(realComp, '# real comp', 'utf8');
    symlinkSync(realComp, companionPath);
    expect(() =>
      installPreserveMode({
        targetPath,
        companionPath,
        omcContent: 'v',
        backupDate: '',
        logger,
      }),
    ).toThrow(/Refusing to write OMC companion CLAUDE\.md because the destination is a symlink/);
  });
});

describe('Behavior #14 — migrateNoMarkers', () => {
  it('wraps new content and appends old as "migrated" user customizations', () => {
    const old = '# legacy content\nuser notes';
    const result = migrateNoMarkers(old, 'v2 body');
    expect(result).toContain(`${START_MARKER}\nv2 body\n${END_MARKER}`);
    expect(result).toContain(USER_CUSTOMIZATIONS_MIGRATED);
    expect(result).toContain('# legacy content');
    expect(result).toContain('user notes');
  });

  it('strips any stale OMC:IMPORT block from preserved content', () => {
    const withImport = `# user\n\n${IMPORT_START}\n@CLAUDE-omc.md\n${IMPORT_END}\n\n# more user`;
    const result = migrateNoMarkers(withImport, 'v2');
    expect(result).not.toContain(IMPORT_START);
    expect(result).toContain('# user');
    expect(result).toContain('# more user');
  });
});

describe('Behavior #15 — cleanupOrphanedCompanion', () => {
  it('no-ops when no companion exists', () => {
    cleanupOrphanedCompanion(configDir, '2026-04-11_120000', { logger });
    expect(logs).toEqual([]);
  });

  it('backs up and removes an orphaned companion', () => {
    const companion = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(companion, '# stale', 'utf8');
    cleanupOrphanedCompanion(configDir, '2026-04-11_120000', { logger });
    expect(existsSync(companion)).toBe(false);
    expect(existsSync(`${companion}.backup.2026-04-11_120000`)).toBe(true);
    expect(logs).toContain('Removed orphaned companion file from prior preserve-mode install');
  });

  it('removes without backup when no backupDate is provided', () => {
    const companion = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(companion, '# stale', 'utf8');
    cleanupOrphanedCompanion(configDir, '', { logger });
    expect(existsSync(companion)).toBe(false);
    const backups = readdirSync(configDir).filter(f => f.startsWith('CLAUDE-omc.md.backup'));
    expect(backups).toEqual([]);
  });
});

describe('Behavior #16 — validatePostWrite', () => {
  it('passes when markers are present', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, `${START_MARKER}\nx\n${END_MARKER}\n`, 'utf8');
    expect(() => validatePostWrite(p)).not.toThrow();
  });

  it('throws when a marker is missing', () => {
    const p = join(tmpRoot, 'CLAUDE.md');
    writeFileSync(p, 'no markers', 'utf8');
    expect(() => validatePostWrite(p)).toThrow(/missing required OMC markers/);
  });
});

describe('Behavior #19 — reportVersionChange', () => {
  it("prints 'Installed CLAUDE.md: <new>' when old === 'none'", () => {
    reportVersionChange('none', '4.11.4', { logger });
    expect(logs).toEqual(['Installed CLAUDE.md: 4.11.4']);
  });

  it("prints 'CLAUDE.md unchanged: <v>' when versions match", () => {
    reportVersionChange('4.11.4', '4.11.4', { logger });
    expect(logs).toEqual(['CLAUDE.md unchanged: 4.11.4']);
  });

  it("prints 'Updated CLAUDE.md: <old> -> <new>' when versions differ", () => {
    reportVersionChange('4.10.0', '4.11.4', { logger });
    expect(logs).toEqual(['Updated CLAUDE.md: 4.10.0 -> 4.11.4']);
  });
});

describe('Behavior #20 — cleanupLegacyHooks', () => {
  it('removes the four legacy hook files if present', () => {
    const hookDir = join(configDir, 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const names = [
      'keyword-detector.sh',
      'stop-continuation.sh',
      'persistent-mode.sh',
      'session-start.sh',
      // Unrelated file that should be preserved
      'other-hook.sh',
    ];
    for (const n of names) writeFileSync(join(hookDir, n), '# body\n', 'utf8');
    cleanupLegacyHooks(configDir, { logger });
    expect(existsSync(join(hookDir, 'other-hook.sh'))).toBe(true);
    for (const n of names.slice(0, 4)) {
      expect(existsSync(join(hookDir, n))).toBe(false);
    }
    expect(logs).toContain('Legacy hooks cleaned');
  });
});

describe('Behavior #21 — warnLegacyHooksInSettings', () => {
  it('emits warning when settings.json has a hooks field', () => {
    const settingsPath = join(configDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), 'utf8');
    warnLegacyHooksInSettings(settingsPath, { logger });
    expect(logs).toContain('NOTE: Found legacy hooks in settings.json. These should be removed since');
    expect(logs).toContain('the plugin now provides hooks automatically. Remove the "hooks" section');
    expect(logs).toContain(`from ${settingsPath} to prevent duplicate hook execution.`);
  });

  it('silent when settings.json has no hooks field', () => {
    const settingsPath = join(configDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ other: true }), 'utf8');
    warnLegacyHooksInSettings(settingsPath, { logger });
    expect(logs).toEqual([]);
  });

  it('silent when settings.json is missing', () => {
    warnLegacyHooksInSettings(join(configDir, 'settings.json'), { logger });
    expect(logs).toEqual([]);
  });
});

describe('Behavior #22 — reportPluginStatus', () => {
  it("prints 'Plugin verified' when settings.json mentions oh-my-claudecode", () => {
    const settingsPath = join(configDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ plugins: ['oh-my-claudecode'] }), 'utf8');
    reportPluginStatus(settingsPath, { logger });
    expect(logs).toEqual(['Plugin verified']);
  });

  it("prints 'Plugin NOT found' when settings.json does not mention it", () => {
    const settingsPath = join(configDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ plugins: [] }), 'utf8');
    reportPluginStatus(settingsPath, { logger });
    expect(logs).toEqual(['Plugin NOT found - run: claude /install-plugin oh-my-claudecode']);
  });

  it("prints 'Plugin NOT found' when settings.json is missing", () => {
    reportPluginStatus(join(configDir, 'settings.json'), { logger });
    expect(logs).toEqual(['Plugin NOT found - run: claude /install-plugin oh-my-claudecode']);
  });
});

// ─────────────────────────── H1–H15 scenarios ───────────────────────────

describe('H1 — fresh install (no existing CLAUDE.md)', () => {
  it('writes wrapped markers and reports "Installed CLAUDE.md: <v>"', async () => {
    const result = await runInstall({ mode: 'global' });
    expect(result.oldVersion).toBe('none');
    expect(existsSync(result.targetPath)).toBe(true);
    const content = readFileSync(result.targetPath, 'utf8');
    expect(content).toContain(START_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('<!-- OMC:VERSION:2.0.0 -->');
    expect(logs).toContain(`Installed CLAUDE.md: 2.0.0`);
  });
});

describe('H2 — markers-same → "CLAUDE.md unchanged: <v>"', () => {
  it('reports unchanged when current version already installed', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, `${START_MARKER}\n<!-- OMC:VERSION:2.0.0 -->\nold body\n${END_MARKER}\n`, 'utf8');
    await runInstall({ mode: 'global' });
    expect(logs).toContain('CLAUDE.md unchanged: 2.0.0');
  });
});

describe('H3 — markers-old → "Updated CLAUDE.md: X -> Y"', () => {
  it('merges and reports upgrade', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, `${START_MARKER}\n<!-- OMC:VERSION:1.0.0 -->\nbefore\n${END_MARKER}\n`, 'utf8');
    const result = await runInstall({ mode: 'global' });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(logs).toContain('Updated CLAUDE.md: 1.0.0 -> 2.0.0');
  });
});

describe('H4 — markers-new → no version guard in claude-md phase', () => {
  it('allows a downgrade from a newer installed version', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    // Installed is v9.9.9, canonical is v2.0.0 → "downgrade"
    writeFileSync(targetPath, `${START_MARKER}\n<!-- OMC:VERSION:9.9.9 -->\nnewer\n${END_MARKER}\n`, 'utf8');
    await runInstall({ mode: 'global' });
    expect(logs).toContain('Updated CLAUDE.md: 9.9.9 -> 2.0.0');
  });
});

describe('H5 — no-markers → migrate with user-customizations header', () => {
  it('migrates, wrapping new content and preserving old under the migrated header', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, '# Legacy\nUser content\n', 'utf8');
    const result = await runInstall({ mode: 'global' });
    const content = readFileSync(result.targetPath, 'utf8');
    expect(content).toContain(START_MARKER);
    expect(content).toContain(USER_CUSTOMIZATIONS_MIGRATED);
    expect(content).toContain('# Legacy');
    expect(content).toContain('User content');
  });
});

describe('H6 — corrupted markers → recovery branch preserves original content', () => {
  it('recovers when the END marker is missing', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, `${START_MARKER}\nlonely start\nuser custom`, 'utf8');
    const result = await runInstall({ mode: 'global' });
    const content = readFileSync(result.targetPath, 'utf8');
    expect(content).toContain(USER_CUSTOMIZATIONS_RECOVERED);
    expect(content).toContain('lonely start');
    expect(content).toContain('user custom');
  });
});

describe('H7 — symlink → throws with exact error text', () => {
  it('refuses to overwrite a CLAUDE.md symlink', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    const real = join(tmpRoot, 'real.md');
    writeFileSync(real, `${START_MARKER}\nbody\n${END_MARKER}\n`, 'utf8');
    symlinkSync(real, targetPath);
    await expect(runInstall({ mode: 'global' })).rejects.toThrow(
      `Refusing to write CLAUDE.md because the destination is a symlink: ${targetPath}`,
    );
  });
});

describe('H8 — companion-present + overwrite → orphan cleanup', () => {
  it('backs up and removes orphaned companion during overwrite install', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    const companionPath = join(configDir, 'CLAUDE-omc.md');
    writeFileSync(targetPath, `${START_MARKER}\n<!-- OMC:VERSION:1.0.0 -->\nold\n${END_MARKER}\n`, 'utf8');
    writeFileSync(companionPath, '# stale companion\n', 'utf8');
    await runInstall({ mode: 'global', installStyle: 'overwrite' });
    expect(existsSync(companionPath)).toBe(false);
    const backups = readdirSync(configDir).filter(f => f.startsWith('CLAUDE-omc.md.backup'));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe('H9 — preserve mode fresh (with existing no-markers base) → companion + IMPORT block', () => {
  it('creates companion and adds the import block to an existing non-markers base', async () => {
    // Preserve branch only fires when a non-markers file already exists.
    // "Fresh" here means no prior companion.
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, '# user base\n', 'utf8');
    const result = await runInstall({ mode: 'global', installStyle: 'preserve' });
    expect(result.validationPath).toBe(result.companionPath);
    expect(existsSync(result.companionPath)).toBe(true);
    const baseContent = readFileSync(targetPath, 'utf8');
    expect(baseContent).toContain('# user base');
    expect(baseContent).toContain(IMPORT_START);
    expect(baseContent).toContain('@CLAUDE-omc.md');
    expect(baseContent).toContain(IMPORT_END);
  });
});

describe('H10 — preserve mode + existing no-markers base → preserves base, writes companion', () => {
  it('leaves user content intact and wraps companion in markers', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, '# personal rules\nrespect me\n', 'utf8');
    const result = await runInstall({ mode: 'global', installStyle: 'preserve' });
    const baseContent = readFileSync(targetPath, 'utf8');
    expect(baseContent).toContain('# personal rules');
    expect(baseContent).toContain('respect me');
    const companionContent = readFileSync(result.companionPath, 'utf8');
    expect(companionContent).toContain(START_MARKER);
    expect(companionContent).toContain(END_MARKER);
  });
});

describe('H11 — preserve idempotent re-run', () => {
  it('a second preserve install does not duplicate the import block', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    writeFileSync(targetPath, '# user base\n', 'utf8');
    await runInstall({ mode: 'global', installStyle: 'preserve' });
    // After first run the base file still has no OMC:START markers (only
    // IMPORT block), so the preserve branch fires again.
    await runInstall({ mode: 'global', installStyle: 'preserve' });
    const baseContent = readFileSync(targetPath, 'utf8');
    const count = (baseContent.match(new RegExp(IMPORT_START, 'g')) ?? []).length;
    expect(count).toBe(1);
  });
});

describe('H12 — --local fresh → .claude/CLAUDE.md + omc-reference + git exclude', () => {
  it('writes .claude/CLAUDE.md, copies omc-reference skill, and configures git exclude', async () => {
    // Need a git repo for git-exclude branch to run.
    spawnSync('git', ['init', '-q'], { cwd });
    const result = await runInstall({ mode: 'local' });
    expect(result.targetPath).toBe(join(cwd, '.claude', 'CLAUDE.md'));
    expect(existsSync(result.targetPath)).toBe(true);
    expect(existsSync(result.skillTargetPath)).toBe(true);
    const excludeContent = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeContent).toContain('# BEGIN OMC local artifacts');
  });
});

describe('H13 — --local unchanged', () => {
  it('local re-install with same version reports unchanged', async () => {
    spawnSync('git', ['init', '-q'], { cwd });
    await runInstall({ mode: 'local' });
    logs.length = 0;
    await runInstall({ mode: 'local' });
    expect(logs).toContain('CLAUDE.md unchanged: 2.0.0');
  });
});

describe('H14 — --local git exclude idempotent', () => {
  it('re-running local does not duplicate the git exclude block', async () => {
    spawnSync('git', ['init', '-q'], { cwd });
    await runInstall({ mode: 'local' });
    await runInstall({ mode: 'local' });
    const excludeContent = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    const count = (excludeContent.match(/# BEGIN OMC local artifacts/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe('H15 — upgrade from pre-refactor install', () => {
  it('merges a pre-refactor-style CLAUDE.md with a legacy version marker', async () => {
    const targetPath = join(configDir, 'CLAUDE.md');
    const preRefactorContent = `${START_MARKER}
<!-- OMC:VERSION:4.8.2 -->

# oh-my-claudecode v4.8.2

## Setup
Say "setup omc".
${END_MARKER}

# My personal rules
- always answer questions directly
`;
    writeFileSync(targetPath, preRefactorContent, 'utf8');
    const result = await runInstall({ mode: 'global' });
    expect(result.oldVersion).toBe('4.8.2');
    expect(result.newVersion).toBe('2.0.0');
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath as string)).toBe(true);
    const merged = readFileSync(targetPath, 'utf8');
    expect(merged).toContain('<!-- OMC:VERSION:2.0.0 -->');
    expect(merged).toContain(USER_CUSTOMIZATIONS);
    expect(merged).toContain('# My personal rules');
    expect(merged).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
    expect(logs).toContain('Updated CLAUDE.md: 4.8.2 -> 2.0.0');
  });
});

// ─────────────── top-level installClaudeMd integration smoke ────────────

describe('installClaudeMd — end-to-end integration', () => {
  it('omc-reference skill is copied during fresh global install', async () => {
    const result = await runInstall({ mode: 'global' });
    expect(existsSync(result.skillTargetPath)).toBe(true);
    expect(readFileSync(result.skillTargetPath, 'utf8')).toContain('omc-reference skill');
  });

  it('skipOmcReferenceCopy leaves skill untouched', async () => {
    const result = await runInstall({ mode: 'global', skipOmcReferenceCopy: true });
    expect(existsSync(result.skillTargetPath)).toBe(false);
  });

  it('global mode runs legacy-hook cleanup and plugin verification', async () => {
    const hooksDir = join(configDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'keyword-detector.sh'), '# legacy\n', 'utf8');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }), 'utf8');
    await runInstall({ mode: 'global' });
    expect(existsSync(join(hooksDir, 'keyword-detector.sh'))).toBe(false);
    expect(logs).toContain('Legacy hooks cleaned');
    expect(logs).toContain('Plugin verified');
  });

  it('local mode skips legacy-hook cleanup and settings warning', async () => {
    spawnSync('git', ['init', '-q'], { cwd });
    await runInstall({ mode: 'local' });
    expect(logs).not.toContain('Legacy hooks cleaned');
  });
});
