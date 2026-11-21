import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { blockOf, ROOT, scriptText, skillAndGuide } from '../../__tests__/helpers/omc-doctor-cache-fixture.js';

describe('omc-doctor skill (issue #2254)', () => {
  it('documents CLAUDE.md OMC version drift check against cached plugin version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    // The lines are printed by the claude-md-version command of scripts/omc-doctor.mjs; the skill names them in its rules.
    expect(scriptText).toContain("console.log('CLAUDE.md OMC version:'");
    expect(scriptText).toContain('OMC version source:');
    expect(scriptText).toContain('Latest cached plugin version:');
    expect(scriptText).toContain('VERSION DRIFT: CLAUDE.md and plugin versions differ');
    expect(scriptText).toContain('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache');
    expect(scriptText).toContain('VERSION MATCH: CLAUDE and plugin cache are aligned');
    expect(scriptText).toContain('CLAUDE-*.md');
    expect(scriptText).toContain('scanned deterministic CLAUDE sources');
    expect(content).toContain('CLAUDE-*.md');
    expect(content).toContain('deterministic companion');
    expect(content).toContain('Latest cached plugin version');
    expect(skillAndGuide).not.toContain('!==');
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
    expect(skillAndGuide).not.toMatch(/\bruby\b/i);
    expect(skillAndGuide).not.toContain('ruby-full');
    expect(skillAndGuide).not.toContain('brew install ruby');
  });
});

describe('omc-doctor skill package version diagnostic (issue #2981)', () => {
  it('checks the canonical published npm package for latest version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(scriptText).toContain("const view = ['view', 'oh-my-claude-sisyphus', 'version'];");
    expect(scriptText).not.toContain("'view', 'oh-my-claudecode', 'version'");
    expect(scriptText).not.toContain('npm view oh-my-claudecode version');
    expect(skillAndGuide).not.toContain("'view', 'oh-my-claudecode', 'version'");
    expect(skillAndGuide).not.toContain('npm view oh-my-claudecode version');
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
  // The probe is the shell block of the skill that runs the claude-md-optout command of the script: the locator line and the call.
  const probe = blockOf('claude-md-optout');

  function runProbe(pathDirs: string[], configDir: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'PATH') env[key] = value;
    }
    env.PATH = pathDirs.join(delimiter);
    env.HOME = configDir;
    env.USERPROFILE = configDir;
    env.CLAUDE_CONFIG_DIR = configDir;
    env.CLAUDE_PLUGIN_ROOT = ROOT;
    env.OMC_PLUGIN_ROOT = '';
    return spawnSync('/bin/bash', ['-c', probe], { env, encoding: 'utf8' });
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

  // The probe is a bash block (the locator line is bash), so these two cases run where bash does, not on Windows runners.
  it.skipIf(process.platform === 'win32')('probe prints neither status line when node is not on PATH', () => {
    expect(probe).toBeDefined();
    const emptyBin = mkdtempSync(join(tmpdir(), 'omc-doctor-probe-nopath-'));
    const configDir = mkdtempSync(join(tmpdir(), 'omc-doctor-probe-config-'));
    try {
      const result = runProbe([emptyBin], configDir);
      expect(result.stdout).not.toContain('CLAUDE.md management enabled');
      expect(result.stdout).not.toContain('CLAUDE.md management disabled by claudeMdEnabled: false');
      // The locator found the script (the plugin root is this checkout); it is the call of node that failed.
      expect(result.stdout).not.toContain('plugin files not found');
      expect(result.stderr).toContain('node');
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('probe prints a status line when node is on PATH', () => {
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
