import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const skillPath = join(root, 'skills', 'make-pr-easy-to-review', 'SKILL.md');
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('make-pr-easy-to-review skill', () => {
  it('should extract skill metadata from SKILL.md', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    expect(skillBody).toContain('name: make-pr-easy-to-review');
    expect(skillBody).toContain('description:');
  });

  it('should reference wrapUntrustedCliResponse for security boundary', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // The security note must reference the wrapping function
    expect(skillBody).toContain('wrapUntrustedCliResponse');
    expect(skillBody).toContain('src/agents/prompt-helpers.ts');
    // Should warn about embedded instructions in PR content
    expect(skillBody).toContain('embedded instructions');
    expect(skillBody).toContain('untrusted');
  });

  it('should define N variable before using it in snapshot refs', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // N must be extracted from the PR argument and validated before use in pr-head-${N}
    expect(skillBody).toMatch(/N="\$\{BASH_REMATCH\[/);
    expect(skillBody).toMatch(/if ! \[\[ "\$\{N\}" =~ \^/);
    // Should use N in git fetch command
    expect(skillBody).toContain('pr-head-${N}');
  });

  it('should use -R flag for enterprise GitHub support in ownership verification', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // The gh api command for repository ownership verification should use -R flag
    // to respect the repository context, especially for enterprise GitHub
    expect(skillBody).toMatch(/gh api -R "\$\{HEAD_REPO\}" "repos\/\$\{HEAD_REPO\}"/);
  });

  it('should verify merge base and tree identity before force-push', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // Must pin the original merge base
    expect(skillBody).toContain('ORIGINAL_MERGE_BASE');
    // Must check that merge base hasn't moved
    expect(skillBody).toContain('CURRENT_MERGE_BASE');
    expect(skillBody).toContain('base branch advanced');
    // Must verify tree equality
    expect(skillBody).toContain('ORIGINAL_TREE');
    expect(skillBody).toContain('--force-with-lease');
  });

  it('should verify repository owner before force-push', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // Must verify owner matches expected before any force-push
    expect(skillBody).toContain('EXPECTED_OWNER');
    expect(skillBody).toContain('ACTUAL_OWNER');
    expect(skillBody).toContain('Repository owner mismatch');
    expect(skillBody).toContain('exit 1');
  });

  it('should handle enterprise GitHub hosts in PR lookups', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // All gh pr view commands should use -R flag to maintain repository context
    // This is especially important for enterprise GitHub servers
    expect(skillBody).toMatch(/gh pr view "\$\{N\}" \$\{TARGET_REPO:\+-R "\$\{TARGET_REPO\}"\}/);
    // Should derive GITHUB_HOST from GITHUB_SERVER_URL
    expect(skillBody).toContain('GITHUB_SERVER_URL');
    expect(skillBody).toContain('GITHUB_HOST');
  });
});
