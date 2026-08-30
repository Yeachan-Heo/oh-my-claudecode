import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findMatchingSkills, loadAllSkills } from '../hooks/learner/loader.js';
import { parseSkillFile } from '../hooks/learner/parser.js';

const ROOT = join(__dirname, '..', '..');
const DRYDOCK = readFileSync(join(ROOT, 'skills', 'drydock', 'SKILL.md'), 'utf-8');
const LAUNCH = readFileSync(join(ROOT, 'skills', 'launch', 'SKILL.md'), 'utf-8');

interface DocumentLanguageContract {
  authority: { path: string; frontmatterKey: string };
  canonicalSources: string[];
  askOn: string[];
  tagPattern: string;
  seedCompanionPrefixes: Record<string, 'en' | 'zh-Hans' | 'zh-Hant'>;
  stableTokens: string[];
}

interface LanguageEvidence {
  tag: string;
  confidence: 'high' | 'low';
  mixed?: boolean;
}

type LanguageResolution =
  | { kind: 'resolved'; tag: string; authority: 'explicit' | 'persisted' | 'inferred' }
  | { kind: 'ask'; reason: 'missing' | 'mixed' | 'conflict' | 'low-confidence' | 'invalid-explicit' | 'script-ambiguous' };

function documentLanguageContract(): DocumentLanguageContract {
  const block = DRYDOCK.match(/<!-- shipyard-document-language-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- shipyard-document-language-contract:end -->/)?.[1];
  if (!block) throw new Error('missing document language contract');
  return JSON.parse(block) as DocumentLanguageContract;
}

function normalizeLanguageTag(input: string): string | null {
  const parts = input.trim().split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const normalized = [parts[0].toLowerCase(), ...parts.slice(1).map((part) => {
    if (/^[A-Za-z]{4}$/.test(part)) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
    return part;
  })].join('-');
  return new RegExp(documentLanguageContract().tagPattern).test(normalized) ? normalized : null;
}

function isScriptAmbiguousChinese(input: string): boolean {
  const parts = input.trim().split('-');
  return parts[0]?.toLowerCase() === 'zh' && !parts.some((part) => /^(?:Hans|Hant)$/i.test(part));
}

function resolveDocumentLanguage(input: {
  explicit?: string;
  persisted?: string;
  sources?: Partial<Record<string, LanguageEvidence>>;
}): LanguageResolution {
  const contract = documentLanguageContract();
  if (input.explicit !== undefined) {
    if (isScriptAmbiguousChinese(input.explicit)) return { kind: 'ask', reason: 'script-ambiguous' };
    const tag = normalizeLanguageTag(input.explicit);
    return tag ? { kind: 'resolved', tag, authority: 'explicit' } : { kind: 'ask', reason: 'invalid-explicit' };
  }
  if (input.persisted !== undefined) {
    if (isScriptAmbiguousChinese(input.persisted)) return { kind: 'ask', reason: 'script-ambiguous' };
    const tag = normalizeLanguageTag(input.persisted);
    if (tag) return { kind: 'resolved', tag, authority: 'persisted' };
  }
  const evidence = contract.canonicalSources.map((path) => input.sources?.[path]).filter((entry): entry is LanguageEvidence => entry !== undefined);
  if (evidence.length === 0) return { kind: 'ask', reason: 'missing' };
  if (evidence.some((entry) => entry.mixed)) return { kind: 'ask', reason: 'mixed' };
  if (evidence.some((entry) => entry.confidence !== 'high')) return { kind: 'ask', reason: 'low-confidence' };
  if (evidence.some((entry) => isScriptAmbiguousChinese(entry.tag))) return { kind: 'ask', reason: 'script-ambiguous' };
  const tags = evidence.map((entry) => normalizeLanguageTag(entry.tag));
  if (tags.some((tag) => tag === null)) return { kind: 'ask', reason: 'low-confidence' };
  const unique = new Set(tags as string[]);
  return unique.size === 1
    ? { kind: 'resolved', tag: [...unique][0], authority: 'inferred' }
    : { kind: 'ask', reason: 'conflict' };
}

function renderSeed(seed: 'a' | 'b', tag: 'en' | 'zh-Hans' | 'zh-Hant'): string {
  const block = DRYDOCK.match(new RegExp(
    `<!-- shipyard-seed-${seed}:${tag}:start -->` +
    '\\s*```markdown\\s*([\\s\\S]*?)\\s*```\\s*' +
    `<!-- shipyard-seed-${seed}:${tag}:end -->`,
  ))?.[1];
  if (!block) throw new Error(`missing seed ${seed}:${tag}`);
  return block;
}

function companionForTag(tag: string): 'en' | 'zh-Hans' | 'zh-Hant' {
  const contract = documentLanguageContract();
  const prefix = Object.keys(contract.seedCompanionPrefixes)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => tag === candidate || tag.startsWith(`${candidate}-`));
  if (!prefix) throw new Error(`no seed companion for ${tag}`);
  return contract.seedCompanionPrefixes[prefix];
}

function renderResolvedSeed(seed: 'a' | 'b', tag: string): string {
  const companion = companionForTag(tag);
  const rendered = renderSeed(seed, companion);
  return seed === 'b' ? rendered.replace(`documentLanguage: ${companion}`, `documentLanguage: ${tag}`) : rendered;
}

function projectSkillSeed(): string {
  const block = DRYDOCK.match(/```markdown\n(---\nid: project-release-check[\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error('missing project-skill seed');
  return block;
}

describe('shipyard document-language behavior contract', () => {
  it('resolves explicit and persisted authority before source inference', () => {
    expect(resolveDocumentLanguage({
      explicit: 'ZH-hant',
      persisted: 'en',
      sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high' } },
    })).toEqual({ kind: 'resolved', tag: 'zh-Hant', authority: 'explicit' });
    expect(resolveDocumentLanguage({
      persisted: 'zh-hans',
      sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high' } },
    })).toEqual({ kind: 'resolved', tag: 'zh-Hans', authority: 'persisted' });
    expect(resolveDocumentLanguage({
      persisted: 'not_a_tag',
      sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high' } },
    })).toEqual({ kind: 'resolved', tag: 'en', authority: 'inferred' });
    expect(resolveDocumentLanguage({
      persisted: 'zh-CN',
      sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high' } },
    })).toEqual({ kind: 'ask', reason: 'script-ambiguous' });
    expect(resolveDocumentLanguage({ persisted: 'zh' })).toEqual({ kind: 'ask', reason: 'script-ambiguous' });
  });

  it('infers only from unanimous high-confidence canonical sources', () => {
    const contract = documentLanguageContract();
    expect(contract.authority).toEqual({ path: 'CONTEXT.md', frontmatterKey: 'documentLanguage' });
    expect(contract.canonicalSources).toEqual(['CLAUDE.md', 'README.md']);
    expect(resolveDocumentLanguage({
      sources: {
        'CLAUDE.md': { tag: 'en', confidence: 'high' },
        'README.md': { tag: 'EN', confidence: 'high' },
      },
    })).toEqual({ kind: 'resolved', tag: 'en', authority: 'inferred' });
    expect(resolveDocumentLanguage({
      sources: { 'README.md': { tag: 'zh-Hans', confidence: 'high' } },
    })).toEqual({ kind: 'resolved', tag: 'zh-Hans', authority: 'inferred' });
  });

  it.each([
    [{}, { kind: 'ask', reason: 'missing' }],
    [{ explicit: 'not_a_tag' }, { kind: 'ask', reason: 'invalid-explicit' }],
    [{ explicit: 'zh' }, { kind: 'ask', reason: 'script-ambiguous' }],
    [{ sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high', mixed: true } } }, { kind: 'ask', reason: 'mixed' }],
    [{ sources: { 'CLAUDE.md': { tag: 'fr', confidence: 'low' } } }, { kind: 'ask', reason: 'low-confidence' }],
    [{ sources: { 'CLAUDE.md': { tag: 'zh-CN', confidence: 'high' } } }, { kind: 'ask', reason: 'script-ambiguous' }],
    [{ sources: { 'CLAUDE.md': { tag: 'en', confidence: 'high' }, 'README.md': { tag: 'zh-Hans', confidence: 'high' } } }, { kind: 'ask', reason: 'conflict' }],
    [{ sources: { 'CLAUDE.md': { tag: 'zh-Hans', confidence: 'high' }, 'README.md': { tag: 'zh-Hant', confidence: 'high' } } }, { kind: 'ask', reason: 'conflict' }],
  ] as const)('asks once instead of guessing from ambiguous evidence %#', (input, expected) => {
    expect(resolveDocumentLanguage(input)).toEqual(expected);
  });

  it('renders exactly one companion while preserving byte-stable tokens', () => {
    const rendered = { en: renderSeed('a', 'en'), 'zh-Hans': renderSeed('a', 'zh-Hans'), 'zh-Hant': renderSeed('a', 'zh-Hant') };
    const headings = { en: '## Project conventions', 'zh-Hans': '## 项目约定', 'zh-Hant': '## 專案約定' };
    for (const [tag, output] of Object.entries(rendered)) {
      expect(output).toContain(headings[tag as keyof typeof headings]);
      for (const [otherTag, otherHeading] of Object.entries(headings)) {
        if (otherTag !== tag) expect(output).not.toContain(otherHeading);
      }
      expect(output).toContain('# <Project> — Agent & Human Shipyard');
      expect(output).toContain('/oh-my-claudecode:launch');
      expect(output).toContain('plan → execute → review → verify');
      expect(output).toContain('CONTEXT.md');
      expect(renderSeed('b', tag as keyof typeof rendered)).toContain(`documentLanguage: ${tag}`);
      expect(renderSeed('b', tag as keyof typeof rendered)).toContain('## <term>');
    }
  });

  it('maps region-qualified Chinese tags to one script companion and preserves the full tag', () => {
    expect(resolveDocumentLanguage({ explicit: 'zh-hans-cn' })).toEqual({
      kind: 'resolved', tag: 'zh-Hans-CN', authority: 'explicit',
    });
    expect(resolveDocumentLanguage({ explicit: 'zh-hant-tw' })).toEqual({
      kind: 'resolved', tag: 'zh-Hant-TW', authority: 'explicit',
    });
    expect(renderResolvedSeed('a', 'zh-Hans-CN')).toContain('## 项目约定');
    expect(renderResolvedSeed('a', 'zh-Hans-CN')).not.toContain('## 專案約定');
    expect(renderResolvedSeed('a', 'zh-Hant-TW')).toContain('## 專案約定');
    expect(renderResolvedSeed('a', 'zh-Hant-TW')).not.toContain('## 项目约定');
    expect(renderResolvedSeed('b', 'zh-Hans-CN')).toContain('documentLanguage: zh-Hans-CN');
    expect(renderResolvedSeed('b', 'zh-Hant-TW')).toContain('documentLanguage: zh-Hant-TW');
  });

  it('keeps Launch stateless and resolves language before any authoring phase', () => {
    const contract = documentLanguageContract();
    expect(contract.askOn).toEqual(expect.arrayContaining(['invalid-explicit', 'script-ambiguous']));
    expect(LAUNCH.indexOf('Before reading a supplied spec')).toBeLessThan(LAUNCH.indexOf('## Phase 1'));
    expect(LAUNCH).toContain('without hidden conversation state');
    expect(LAUNCH).toContain(`\`${contract.authority.path}\` frontmatter`);
    expect(LAUNCH).toContain(`\`${contract.authority.frontmatterKey}\``);
    for (const token of ['blockedBy', 'blocked_by', 'plan', 'execute', 'review', 'verify', 'ready-for-agent']) {
      expect(contract.stableTokens).toContain(token);
      expect(LAUNCH).toContain(token);
    }
  });

  it('loads and matches a CRLF non-Latin project skill by stable ASCII id', () => {
    const localized = projectSkillSeed()
      .replace('name: project-release-check', 'name: 项目发布检查')
      .replace("description: Apply this repository's release readiness rules", 'description: 应用本仓库的发布就绪规则')
      .replace('  - "project release check"', '  - "项目发布检查"')
      .replace(/\n/g, '\r\n');
    expect(localized).toContain('id: project-release-check');
    expect(localized).toContain('name: 项目发布检查');
    expect(localized).toContain('description: 应用本仓库的发布就绪规则');
    expect(localized).toContain('triggers:\r\n');
    expect(parseSkillFile(localized).metadata).toMatchObject({
      id: 'project-release-check',
      name: '项目发布检查',
      triggers: ['项目发布检查'],
    });

    const projectRoot = mkdtempSync(join(tmpdir(), 'omc-drydock-localized-seed-'));
    try {
      const skillsDir = join(projectRoot, '.omc', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'project-release-check.md'), localized, 'utf8');
      const loaded = loadAllSkills(projectRoot).find((skill) => skill.metadata.id === 'project-release-check');
      expect(loaded?.metadata.name).toBe('项目发布检查');
      expect(loaded?.metadata.triggers).toEqual(['项目发布检查']);
      expect(findMatchingSkills('请执行项目发布检查', projectRoot).map((skill) => skill.metadata.id)).toContain('project-release-check');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
