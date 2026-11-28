/**
 * Only *.instructions.md files under .github/instructions are rules. The
 * directory check compared against a forward-slash path, so on Windows, where
 * path.join() builds backslash paths, every .md file in the directory was
 * injected. Listed in ci.yml `test-windows` so a Windows runner exercises it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { findRuleFiles } from './finder.js';

describe('findRuleFiles in .github/instructions', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-gh-instructions-'));
    mkdirSync(join(root, '.git'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps only *.instructions.md files', () => {
    const dir = join(root, '.github', 'instructions');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'coding.instructions.md'), '# rule');
    writeFileSync(join(dir, 'nested', 'tests.instructions.md'), '# rule');
    writeFileSync(join(dir, 'README.md'), '# not a rule');
    writeFileSync(join(dir, 'notes.mdc'), '# not a rule');
    const currentFile = join(root, 'index.ts');
    writeFileSync(currentFile, '');

    const names = findRuleFiles(root, currentFile)
      .filter((candidate) => !candidate.isGlobal)
      .map((candidate) => basename(candidate.path))
      .sort();

    expect(names).toEqual(['coding.instructions.md', 'tests.instructions.md']);
  });
});
