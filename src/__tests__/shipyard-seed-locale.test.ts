import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSkillFile } from '../hooks/learner/parser.js';

const ROOT = join(__dirname, '..', '..');
const DRYDOCK = readFileSync(join(ROOT, 'skills', 'drydock', 'SKILL.md'), 'utf-8');

/** Extract the first fenced ```markdown block after a marker line. */
function fencedBlockAfter(src: string, marker: string): string {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const start = src.indexOf('```markdown', idx);
  if (start === -1) throw new Error(`no fenced block after marker: ${marker}`);
  const bodyStart = start + '```markdown'.length;
  const end = src.indexOf('\n```', bodyStart);
  if (end === -1) throw new Error('unterminated fenced block');
  return src.slice(bodyStart, end).trim();
}

const SEED_A_EN = fencedBlockAfter(DRYDOCK, 'Seed A — CLAUDE.md, en');
const SEED_A_ZH = fencedBlockAfter(DRYDOCK, 'Seed A — zh companion');
const SEED_B_EN = fencedBlockAfter(DRYDOCK, 'Seed B — CONTEXT.md, en');
const SEED_B_ZH = fencedBlockAfter(DRYDOCK, 'Seed B — CONTEXT.md, zh');

describe('shipyard seed locale contract', () => {
  it('renders exactly one language per selected seed (companion not emitted)', () => {
    // en block: no CJK, canonical en headings
    expect(SEED_A_EN).toContain('## Project conventions');
    expect(SEED_A_EN).not.toMatch(/[\u{4e00}-\u{9fff}]/u);
    // zh block: CJK headings, no en headings
    expect(SEED_A_ZH).toContain('## 项目约定');
    expect(SEED_A_ZH).not.toContain('## Project conventions');
  });

  it('zh companion preserves byte-stable structural tokens', () => {
    for (const token of [
      'docs/standards/architecture.md',
      'docs/adr/',
      '/oh-my-claudecode:launch',
      'plan → execute → review → verify',
      'ADR-0001',
      '.omc/skills/',
    ]) {
      expect(SEED_A_ZH).toContain(token);
    }
  });

  it('durable language tag ships in the Seed B frontmatter (en and zh)', () => {
    expect(SEED_B_EN).toContain('language: en');
    expect(SEED_B_ZH).toContain('language: zh-Hans');
  });

  it('drydock documents the deterministic resolution order', () => {
    for (const marker of [
      'Explicit human override in the current request',
      'Durable tag',
      'Ambiguity branch',
      'ask once',
      'bare `zh` is not a valid tag',
    ]) {
      expect(DRYDOCK).toContain(marker);
    }
  });

  it('launch reads the durable tag and never re-infers', () => {
    const LAUNCH = readFileSync(join(ROOT, 'skills', 'launch', 'SKILL.md'), 'utf-8');
    expect(LAUNCH).toContain('Durable tag');
    expect(LAUNCH).toContain('never from hidden conversation state');
    expect(LAUNCH).toContain('launch never re-infers');
    expect(LAUNCH).toContain('agents are language-agnostic');
  });

  it('a non-Latin project-skill seed with a literal id parses with a stable id', () => {
    const localized = [
      '---',
      'id: project-release-check',
      'name: 发布就绪检查',
      'description: Apply this repository\'s release readiness rules',
      'triggers:',
      '  - "project release check"',
      '---',
      '',
      '# Project Release Check',
      '',
      'Follow the repository-specific release checklist and report evidence.',
    ].join('\n');

    const parsed = parseSkillFile(localized);
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.metadata.id).toBe('project-release-check');
    expect(parsed.metadata.name).toBe('发布就绪检查');
  });

  it('documents the hazard: a localized name without a literal id derives an empty id', () => {
    // this is WHY Seed F mandates the literal id — the parser strips non-[a-z0-9-] from name
    const localizedNoId = [
      '---',
      'name: 发布就绪检查',
      'description: Apply this repository\'s release readiness rules',
      'triggers:',
      '  - "project release check"',
      '---',
    ].join('\n');

    const parsed = parseSkillFile(localizedNoId);
    expect(parsed.metadata.id).toBe('');
  });
});
