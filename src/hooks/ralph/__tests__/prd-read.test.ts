import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrdFromPath } from '../prd.js';

const PRD = {
  project: 'demo',
  branchName: 'feat/demo',
  description: 'a demo PRD',
  userStories: [
    {
      id: 'S1',
      title: 'story one',
      description: 'does a thing',
      acceptanceCriteria: ['it works'],
      priority: 1,
      passes: false,
    },
  ],
};

function writePrd(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-prd-read-'));
  const path = join(dir, 'prd.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('readPrdFromPath', () => {
  it('reads a prd.json saved without a BOM', () => {
    const result = readPrdFromPath(writePrd(JSON.stringify(PRD, null, 2)));
    expect(result.error).toBeUndefined();
    expect(result.prd?.userStories).toHaveLength(1);
  });

  it('reads a prd.json saved as UTF-8 with BOM', () => {
    // Editors on Windows prepend U+FEFF, which JSON.parse rejects. The stories in a
    // prd.json are hand-edited, so the file comes back through an editor.
    const result = readPrdFromPath(writePrd(`\uFEFF${JSON.stringify(PRD, null, 2)}`));
    expect(result.error).toBeUndefined();
    expect(result.prd?.userStories).toHaveLength(1);
  });

  it('keeps a U+FEFF that is inside a string value', () => {
    const withMark = { ...PRD, description: `a\uFEFFb` };
    const result = readPrdFromPath(writePrd(`\uFEFF${JSON.stringify(withMark, null, 2)}`));
    expect(result.error).toBeUndefined();
    expect(result.prd?.description).toBe(`a\uFEFFb`);
  });

  it('still reports genuinely malformed JSON', () => {
    const result = readPrdFromPath(writePrd('{ not json'));
    expect(result.error).toBeDefined();
    expect(result.prd).toBeUndefined();
  });
});
