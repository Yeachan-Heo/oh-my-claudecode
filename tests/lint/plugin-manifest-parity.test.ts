/**
 * Doc-lint: the Claude Code plugin manifest's skills array and the installed
 * skills tree must list exactly the same set — no missing declarations
 * (marketplace users lose the skill) and no phantom entries.
 *
 * Added after a review pass caught a shipped skill directory absent from the
 * manifest; this test makes that class of omission fail CI.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const MANIFEST = join(REPO_ROOT, '.claude-plugin', 'plugin.json');

function installedSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function declaredSkillDirs(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const entries: string[] = manifest.skills ?? [];
  return entries
    .map((entry: string) => entry.replace(/^\.\//, '').replace(/\/$/, '').replace(/^skills\//, ''))
    .sort();
}

describe('plugin manifest / skills tree parity', () => {
  it('declares exactly the installed skill directories', () => {
    const installed = installedSkillDirs();
    const declared = declaredSkillDirs();
    expect(declared).toEqual(installed);
  });

  it('declares each skill as a skills/ path with trailing slash', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    for (const entry of manifest.skills ?? []) {
      expect(entry, `entry ${entry}`).toMatch(/^\.\/skills\/[a-z0-9-]+\/$/);
    }
  });
});
