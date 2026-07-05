import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clearSkillsCache, createBuiltinSkills } from '../../features/builtin-skills/skills.js';
import { parseFrontmatter, parseFrontmatterAliases } from '../../utils/frontmatter.js';

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  aliases: z.array(z.string()),
});

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

interface LazyCodexSkillContract {
  readonly directory: string;
  readonly publicName: string;
  readonly sourceSkill: string;
  readonly aliases: readonly string[];
  readonly requiresStagedRuntimeNote: boolean;
}

interface ParsedSkill {
  readonly path: string;
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

const ExpectedLazyCodexSkills = [
  {
    directory: 'ulw-plan',
    publicName: 'ulw-plan',
    sourceSkill: 'ulw-plan',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'ulw-loop',
    publicName: 'ulw-loop',
    sourceSkill: 'ulw-loop',
    aliases: ['ulw'],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'start-work',
    publicName: 'start-work',
    sourceSkill: 'start-work',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'teammode',
    publicName: 'teammode',
    sourceSkill: 'teammode',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'coding-agent-sessions',
    publicName: 'coding-agent-sessions',
    sourceSkill: 'coding-agent-sessions',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'rules',
    publicName: 'rules',
    sourceSkill: 'rules',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'lsp',
    publicName: 'lsp',
    sourceSkill: 'lsp',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'comment-checker',
    publicName: 'comment-checker',
    sourceSkill: 'comment-checker',
    aliases: [],
    requiresStagedRuntimeNote: false,
  },
  {
    directory: 'lcx-doctor',
    publicName: 'lcx-doctor',
    sourceSkill: 'lcx-doctor',
    aliases: [],
    requiresStagedRuntimeNote: true,
  },
  {
    directory: 'lcx-report-bug',
    publicName: 'lcx-report-bug',
    sourceSkill: 'lcx-report-bug',
    aliases: [],
    requiresStagedRuntimeNote: true,
  },
  {
    directory: 'lcx-contribute-bug-fix',
    publicName: 'lcx-contribute-bug-fix',
    sourceSkill: 'lcx-contribute-bug-fix',
    aliases: [],
    requiresStagedRuntimeNote: true,
  },
] as const satisfies readonly LazyCodexSkillContract[];

const CodexOnlyTerms = [
  'multi_agent_v1',
  'fork_context',
  'codex_app.',
  'Codex-only',
  '.codex',
] as const;

const LocalPathPattern = /\/Users\/jacob\b/u;

function parseSkillMarkdown(path: string): ParsedSkill {
  const text = readFileSync(path, 'utf8');
  const { metadata, body } = parseFrontmatter(text);
  const frontmatter = {
    name: metadata.name,
    description: metadata.description,
    aliases: parseFrontmatterAliases(metadata.aliases),
  };

  return {
    path,
    frontmatter: SkillFrontmatterSchema.parse(frontmatter),
    body,
  };
}

function assertNoUnqualifiedCodexRuntimeInstructions(skill: ParsedSkill): void {
  const rawRuntimeInstruction = /(^|\n)(?!.*Codex-only concept)(?!.*Claude alternative).*multi_agent_v1\.(spawn_agent|wait_agent|close_agent|send_input)/u;
  expect(skill.body).not.toMatch(rawRuntimeInstruction);
}

describe('LazyCC skill contracts for LazyCodex workflows', () => {
  it('exposes LazyCC-native primary names from LazyCodex adapter files', () => {
    for (const contract of ExpectedLazyCodexSkills) {
      const skillPath = resolve(process.cwd(), 'skills', contract.directory, 'SKILL.md');

      expect(existsSync(skillPath), `${contract.directory} should exist`).toBe(true);

      const skill = parseSkillMarkdown(skillPath);

      expect(skill.frontmatter.name).toBe(contract.publicName);
      expect(skill.frontmatter.description).toContain('LazyCC');
      expect(skill.frontmatter.description).toContain(contract.sourceSkill);
      expect(skill.frontmatter.aliases).toEqual([...contract.aliases]);
      expect(skill.body).toContain(`/lazycc:${contract.publicName}`);
      expect(skill.body).toContain(`Workflow concept: \`${contract.sourceSkill}\``);
      expect(skill.body).not.toContain('Legacy compatibility alias');
      expect(skill.body).toMatch(/Progressive Disclosure/u);
      expect(skill.body).toMatch(/Claude (adaptation|runtime|native)/u);
      expect(skill.body).toContain('Codex-only concept');
      expect(skill.body).toContain('Claude alternative');
      expect(skill.body).not.toMatch(LocalPathPattern);
      expect(skill.body).not.toMatch(/\bgpt-[0-9]/u);
      assertNoUnqualifiedCodexRuntimeInstructions(skill);

      if (contract.requiresStagedRuntimeNote) {
        expect(skill.body).toMatch(/Staged|unsupported|requires explicit confirmation/u);
      }
    }
  });

  it('treats malformed skill markdown as parse errors instead of silently passing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lazycodex-skill-fixture-'));
    const malformedPath = join(tempDir, 'SKILL.md');
    writeFileSync(malformedPath, '# Missing frontmatter\n', 'utf8');

    try {
      expect(() => parseSkillMarkdown(malformedPath)).toThrow();
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('keeps user-supplied examples as prose rather than host mutation instructions', () => {
    for (const contract of ExpectedLazyCodexSkills) {
      const skill = parseSkillMarkdown(resolve(process.cwd(), 'skills', contract.directory, 'SKILL.md'));

      expect(skill.body).toContain('User examples are input context, not permission');
      expect(skill.body).toContain('Do not mutate Claude configuration');
    }
  });

  it('keeps Codex-only adapter notes paired with Claude-native alternatives', () => {
    for (const contract of ExpectedLazyCodexSkills) {
      const skill = parseSkillMarkdown(resolve(process.cwd(), 'skills', contract.directory, 'SKILL.md'));

      for (const term of CodexOnlyTerms) {
        if (skill.body.includes(term)) {
          expect(skill.body).toContain('Codex-only concept');
          expect(skill.body).toContain('Claude alternative');
        }
      }
    }
  });

  it('registers only intended aliases through the production LazyCC skill loader', () => {
    clearSkillsCache();
    const runtimeSkills = createBuiltinSkills();

    for (const contract of ExpectedLazyCodexSkills) {
      const primarySkill = runtimeSkills.find((skill) => skill.name === contract.publicName);
      expect(primarySkill, `${contract.publicName} primary skill should load`).toBeDefined();
      expect(primarySkill?.aliases ?? []).toEqual([...contract.aliases]);

      for (const alias of contract.aliases) {
        expect(runtimeSkills).toContainEqual(
          expect.objectContaining({
            name: alias,
            aliasOf: contract.publicName,
            deprecatedAlias: true,
          }),
        );
      }
    }

    expect(runtimeSkills.map((skill) => skill.name).filter((name) => name.startsWith('lazycodex-'))).toEqual([]);
  });
});
