import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('omc-doctor skill (issue #2254)', () => {
  it('documents CLAUDE.md OMC version drift check against cached plugin version', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('CLAUDE.md OMC version:');
    expect(content).toContain('Latest cached plugin version:');
    expect(content).toContain('VERSION DRIFT: CLAUDE.md and plugin versions differ');
    expect(content).toContain('If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected');
  });
});
