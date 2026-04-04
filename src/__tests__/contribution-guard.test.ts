import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Dynamic import for ESM module
let checkContributionGuard: (toolName: string, toolInput: Record<string, unknown>, directory: string) => { type: string; reason?: string; message?: string } | null;

// Create a temp directory that looks like the OMC project
let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `contribution-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(tempDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'oh-my-claudecode', version: '4.9.3' })
  );

  // Clear env var before each test
  delete process.env.OMC_SKIP_CONTRIBUTION_GUARD;

  // Import the module fresh
  // @ts-expect-error -- .mjs module without type declarations
  const mod = await import('../../scripts/lib/contribution-guard.mjs');
  checkContributionGuard = mod.checkContributionGuard;
});

afterEach(() => {
  delete process.env.OMC_SKIP_CONTRIBUTION_GUARD;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Cleanup best-effort
  }
});

describe('contribution-guard', () => {
  describe('P0: base branch enforcement', () => {
    it('denies gh pr create --base main', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base main --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('dev');
      expect(result!.reason).toContain('main');
    });

    it('denies gh pr create --base=main (equals syntax)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base=main --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('dev');
    });

    it('denies gh pr create --base master', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base master --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('master');
    });

    it('denies gh pr create without --base flag', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('Missing --base');
    });

    it('allows gh pr create --base dev', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base dev --title "test"' }, tempDir);
      expect(result).toBeNull();
    });

    it('allows gh pr create --base=dev (equals syntax)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base=dev --title "test"' }, tempDir);
      expect(result).toBeNull();
    });

    it('denies gh pr create -B main (shorthand flag)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create -B main --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('dev');
      expect(result!.reason).toContain('main');
    });

    it('denies gh pr create -B=master (shorthand equals syntax)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create -B=master --title "test"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('master');
    });

    it('allows gh pr create -B dev (shorthand flag)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create -B dev --title "test"' }, tempDir);
      expect(result).toBeNull();
    });

    it('allows gh pr create -B=dev (shorthand equals syntax)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create -B=dev --title "test"' }, tempDir);
      expect(result).toBeNull();
    });
  });

  describe('P1: commit message format', () => {
    it('warns on non-conventional commit message', () => {
      const result = checkContributionGuard('Bash', { command: 'git commit -m "bad message without type"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('warn');
      expect(result!.message).toContain('conventional commits');
    });

    it('allows conventional commit message', () => {
      const result = checkContributionGuard('Bash', { command: 'git commit -m "fix(hooks): correct message format"' }, tempDir);
      expect(result).toBeNull();
    });

    it('allows feat commit with scope', () => {
      const result = checkContributionGuard('Bash', { command: 'git commit -m "feat(skill): add contribution guide"' }, tempDir);
      expect(result).toBeNull();
    });

    it('allows chore commit without scope', () => {
      const result = checkContributionGuard('Bash', { command: 'git commit -m "chore: bump version"' }, tempDir);
      expect(result).toBeNull();
    });
  });

  describe('P1: PR body validation', () => {
    it('warns when PR body is missing Summary section', () => {
      const result = checkContributionGuard('Bash', {
        command: 'gh pr create --base dev --title "test" --body "no sections here"'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('warn');
      expect(result!.message).toContain('Summary');
    });

    it('allows PR body with both required sections', () => {
      const result = checkContributionGuard('Bash', {
        command: 'gh pr create --base dev --title "test" --body "## Summary\nDid thing\n## Test plan\nTested"'
      }, tempDir);
      expect(result).toBeNull();
    });
  });

  describe('common shell forms', () => {
    it('catches gh pr create with leading whitespace', () => {
      const result = checkContributionGuard('Bash', { command: '  gh pr create --base main' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('catches gh pr create in multiline command', () => {
      const result = checkContributionGuard('Bash', { command: 'echo ok\ngh pr create --base main' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('catches gh pr create with env prefix', () => {
      const result = checkContributionGuard('Bash', { command: 'GH_TOKEN=xxx gh pr create --base main' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('catches gh pr create in subshell', () => {
      const result = checkContributionGuard('Bash', { command: '(gh pr create --base main)' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('catches git commit after shell operators', () => {
      const result = checkContributionGuard('Bash', { command: 'npm test && git commit -m "bad message"' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('warn');
    });

    it('catches gh pr create after shell operators', () => {
      const result = checkContributionGuard('Bash', { command: 'npm test && gh pr create --base main' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('strips shell delimiters from branch name (e.g. main;)', () => {
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base main; echo done' }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('main');
    });
  });

  describe('guard scoping', () => {
    it('returns null for non-Bash tools', () => {
      const result = checkContributionGuard('Read', { command: 'gh pr create --base main' }, tempDir);
      expect(result).toBeNull();
    });

    it('returns null for unrelated Bash commands', () => {
      const result = checkContributionGuard('Bash', { command: 'ls -la' }, tempDir);
      expect(result).toBeNull();
    });

    it('returns null for non-OMC project directory', () => {
      const nonOmcDir = join(tmpdir(), `non-omc-${Date.now()}`);
      mkdirSync(nonOmcDir, { recursive: true });
      try {
        const result = checkContributionGuard('Bash', { command: 'gh pr create --base main' }, nonOmcDir);
        expect(result).toBeNull();
      } finally {
        rmSync(nonOmcDir, { recursive: true, force: true });
      }
    });

    it('returns null when OMC_SKIP_CONTRIBUTION_GUARD=1 (env var)', () => {
      process.env.OMC_SKIP_CONTRIBUTION_GUARD = '1';
      const result = checkContributionGuard('Bash', { command: 'gh pr create --base main' }, tempDir);
      expect(result).toBeNull();
    });

    it('returns null when OMC_SKIP_CONTRIBUTION_GUARD=1 is inline in command', () => {
      const result = checkContributionGuard('Bash', {
        command: 'OMC_SKIP_CONTRIBUTION_GUARD=1 gh pr create --base main --title "release"'
      }, tempDir);
      expect(result).toBeNull();
    });

    it('returns null when bypass has multiple env prefixes', () => {
      const result = checkContributionGuard('Bash', {
        command: 'GH_TOKEN=xxx OMC_SKIP_CONTRIBUTION_GUARD=1 gh pr create --base main'
      }, tempDir);
      expect(result).toBeNull();
    });

    it('denies when --base appears only inside --body text', () => {
      const result = checkContributionGuard('Bash', {
        command: 'gh pr create --title "test" --body "## Summary\nUse --base dev\n## Test plan\nDone"'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
      expect(result!.reason).toContain('Missing --base');
    });

    it('does not bypass when OMC_SKIP_CONTRIBUTION_GUARD=1 is in a non-assignment context', () => {
      const result = checkContributionGuard('Bash', {
        command: 'echo OMC_SKIP_CONTRIBUTION_GUARD=1 && gh pr create --base main'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('does not bypass when env var is separated by semicolon from gh command', () => {
      const result = checkContributionGuard('Bash', {
        command: 'OMC_SKIP_CONTRIBUTION_GUARD=1; gh pr create --base main'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('does not bypass when env var is applied to a different command', () => {
      const result = checkContributionGuard('Bash', {
        command: 'OMC_SKIP_CONTRIBUTION_GUARD=1 git status && gh pr create --base main'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });

    it('does not bypass when env var appears mid-string (e.g. echo argument)', () => {
      const result = checkContributionGuard('Bash', {
        command: 'echo OMC_SKIP_CONTRIBUTION_GUARD=1 gh pr create && gh pr create --base main'
      }, tempDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('deny');
    });
  });
});
