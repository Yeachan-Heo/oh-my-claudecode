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

  it('should use --hostname flag for enterprise GitHub support in ownership verification', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // The gh api command for repository ownership verification should use --hostname flag
    // to respect the repository context, especially for enterprise GitHub
    expect(skillBody).toMatch(/gh api --hostname "\$\{GITHUB_HOST\}" "repos\/\$\{HEAD_REPO\}"/);
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

  it('should verify merge base integrity', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // The script must pin the original merge base
    expect(skillBody).toContain('ORIGINAL_MERGE_BASE=');
    // Must verify it hasn't moved after rewriting
    expect(skillBody).toContain('CURRENT_MERGE_BASE=$(git merge-base');
    expect(skillBody).toContain('base branch advanced');
    expect(skillBody).toMatch(/if \[ "\$\{CURRENT_MERGE_BASE\}" != "\$\{ORIGINAL_MERGE_BASE\}" \]/);
  });

  it('should verify patch integrity against base', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // Must snapshot the original three-dot patch
    expect(skillBody).toContain('ORIGINAL_PATCH=$(mktemp)');
    expect(skillBody).toContain('git diff');
    // Must verify patch hasn't changed
    expect(skillBody).toContain('REWRITTEN_PATCH=$(mktemp)');
    expect(skillBody).toContain('diff -u');
    expect(skillBody).toContain('the PR\'s patch against its base changed');
  });

  it('should verify SSH URL normalization handles host aliases', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // The awk regex must handle git@host-alias: style URLs
    expect(skillBody).toMatch(/sub\(\/\^\(\(https\?/);
    // Should normalize git@ prefix for SSH URLs
    expect(skillBody).toContain('git@');
  });

  it('should reject push on repository owner mismatch', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // Must extract expected owner from HEAD_REPO
    expect(skillBody).toContain('EXPECTED_OWNER=');
    expect(skillBody).toContain('cut -d/ -f1');
    // Must get actual owner from repository query
    expect(skillBody).toContain('ACTUAL_OWNER=');
    // Must compare them exactly
    expect(skillBody).toMatch(/if \[ "\$\{ACTUAL_OWNER\}" != "\$\{EXPECTED_OWNER\}" \]/);
    expect(skillBody).toContain('Repository owner mismatch');
  });

  it('should use --force-with-lease to protect against concurrent updates', () => {
    const skillBody = readFileSync(skillPath, 'utf8');
    // Must pin the exact pre-rewrite OID
    expect(skillBody).toContain('--force-with-lease=');
    expect(skillBody).toContain('${HEAD_OID}');
    // Must qualify destination as refs/heads to prevent tag matches
    expect(skillBody).toContain('refs/heads/${HEAD_REF}');
  });
});
