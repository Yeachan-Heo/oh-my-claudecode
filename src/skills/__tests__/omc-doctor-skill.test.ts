import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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


describe('omc-doctor skill Ralph Ruby dependency check (issue #2969)', () => {
  it('documents a narrow Ruby check with actionable Ralph guidance', () => {
    const skillPath = join(process.cwd(), 'skills', 'omc-doctor', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('Check Ralph Ruby Dependency');
    expect(content).toContain('Ruby for Ralph: MISSING');
    expect(content).toContain('Ralph workflows require Ruby');
    expect(content).toContain('sudo apt update && sudo apt install ruby-full');
    expect(content).toContain('Ralph Ruby Dependency');
  });
});
