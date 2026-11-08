import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

describe('omc-doctor skill (issue #2254)', () => {
  it('documents CLAUDE.md OMC version drift check against cached plugin version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('CLAUDE.md OMC version:');
    expect(content).toContain('OMC version source:');
    expect(content).toContain('Latest cached plugin version:');
    expect(content).toContain('VERSION DRIFT: CLAUDE.md and plugin versions differ');
    expect(content).toContain('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache');
    expect(content).toContain('VERSION MATCH: CLAUDE and plugin cache are aligned');
    expect(content).toContain('CLAUDE-*.md');
    expect(content).toContain('deterministic companion');
    expect(content).toContain('scanned deterministic CLAUDE sources');
    expect(content).not.toContain('!==');
    expect(content).toContain('If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected');
  });
});


describe('omc-doctor skill Ralph runtime prerequisites (issue #3996)', () => {
  it('documents a truthful Node/config-dir check instead of the retired Ruby check', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('Check Ralph Runtime Prerequisites');
    expect(content).toContain('node --version');
    expect(content).toContain('Ralph Runtime Prerequisites');
    // The Ruby check was a false positive (issue #3996): OMC has never used Ruby.
    expect(content).not.toMatch(/\bruby\b/i);
    expect(content).not.toContain('ruby-full');
    expect(content).not.toContain('brew install ruby');
  });
});

describe('omc-doctor skill package version diagnostic (issue #2981)', () => {
  it('checks the canonical published npm package for latest version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('npm view oh-my-claude-sisyphus version');
    expect(content).not.toContain('npm view oh-my-claudecode version');
  });
});

describe('omc-doctor skill claudeMdEnabled opt-out probe fails closed', () => {
  const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
  const content = readFileSync(skillPath, 'utf8');
  const step4 = content.slice(
    content.indexOf('### Step 4: Check CLAUDE.md'),
    content.indexOf('### Step 5: Check Ralph Runtime Prerequisites'),
  );
  const fixSection = content.slice(content.indexOf('### Fix: Missing/Outdated CLAUDE.md'));
  const probe = step4.split('\n').find((line) => line.startsWith('node -e ') && line.includes('claudeMdEnabled'));

  function runProbe(pathDirs: string[], configDir: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'PATH') env[key] = value;
    }
    env.PATH = pathDirs.join(delimiter);
    env.HOME = configDir;
    env.USERPROFILE = configDir;
    env.CLAUDE_CONFIG_DIR = configDir;
    return spawnSync(probe as string, { shell: true, env, encoding: 'utf8' });
  }

  it('continues with the CLAUDE.md checks only on the exact enabled line', () => {
    expect(step4).toContain(
      'Continue with the CLAUDE.md checks below only when the probe printed exactly `CLAUDE.md management enabled`.',
    );
    expect(step4).not.toContain('Otherwise continue');
  });

  it('skips the checks and the CLAUDE.md fix when the probe prints neither line or fails', () => {
    expect(step4).toContain('If it prints neither line, or the command fails (for example `node` is not on `PATH`');
    expect(step4).toContain('WARN - could not check the `claudeMdEnabled` opt-out');
    expect(step4).toContain('never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`');
    expect(fixSection).toContain('Skip this fix unless Step 4 printed `CLAUDE.md management enabled`');
    expect(fixSection).toContain('could not check the opt-out');
  });

  it('probe prints neither status line when node is not on PATH', () => {
    expect(probe).toBeDefined();
    const emptyBin = mkdtempSync(join(tmpdir(), 'omc-doctor-probe-nopath-'));
    const configDir = mkdtempSync(join(tmpdir(), 'omc-doctor-probe-config-'));
    try {
      const result = runProbe([emptyBin], configDir);
      expect(result.stdout).not.toContain('CLAUDE.md management enabled');
      expect(result.stdout).not.toContain('CLAUDE.md management disabled by claudeMdEnabled: false');
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('probe prints a status line when node is on PATH', () => {
    expect(probe).toBeDefined();
    const configDir = mkdtempSync(join(tmpdir(), 'omc-doctor-probe-config-'));
    try {
      const nodeDir = dirname(process.execPath);
      expect(runProbe([nodeDir], configDir).stdout.trim()).toBe('CLAUDE.md management enabled');
      writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
      expect(runProbe([nodeDir], configDir).stdout.trim()).toBe('CLAUDE.md management disabled by claudeMdEnabled: false');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
