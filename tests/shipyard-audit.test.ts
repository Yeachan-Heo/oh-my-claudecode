import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'shipyard-audit.mjs');

interface AuditFinding {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  actionable: boolean;
  evidence: string[];
  advice: string;
}

interface AuditReport {
  contractVersion: number;
  scannedRoot: string;
  findings: AuditFinding[];
  summary: { counts: Record<string, number>; verdict: string };
}

function runAudit(root: string): { status: number; report: AuditReport | null; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, report: JSON.parse(out) as AuditReport, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      report: e.stdout ? (JSON.parse(e.stdout) as AuditReport) : null,
      stderr: e.stderr ?? '',
    };
  }
}

function seedCleanYard(root: string, glossaryFile: 'GLOSSARY.md' | 'CONTEXT.md' = 'GLOSSARY.md'): void {
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Project\n\n## Project conventions\n\n- conventions\n\n## Standards index\n\n- Architecture: docs/standards/architecture.md\n',
  );
  writeFileSync(join(root, glossaryFile), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers": {}}\n');
  for (const dir of ['docs/adr', 'docs/standards', 'docs/business', 'design-system', '.omc/skills', 'scripts']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'docs', 'standards', 'architecture.md'), '# Architecture Standards\n');
}

describe('shipyard-audit script (the --check structured finding contract)', () => {
  let yard: string;

  beforeEach(() => {
    yard = mkdtempSync(join(tmpdir(), 'shipyard-audit-'));
  });

  afterEach(() => {
    if (yard && existsSync(yard)) rmSync(yard, { recursive: true, force: true });
  });

  it('exits 0 with no findings on a clean yard', () => {
    seedCleanYard(yard);
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.contractVersion).toBe(2);
    expect(report!.findings).toEqual([]);
    expect(report!.summary.verdict).toBe('clear');
  });

  it('accepts a BOM-prefixed project skill with non-empty triggers', () => {
    seedCleanYard(yard);
    writeFileSync(
      join(yard, '.omc', 'skills', 'bom-skill.md'),
      '\uFEFF---\nname: BOM Skill\ntriggers:\n  - bom\n---\nSkill body\n',
    );

    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
  });

  it('rejects an unlaid yard when both required day-one faces are absent', () => {
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    expect(report!.summary.verdict).toBe('review-recommended');
    expect(report!.findings).toEqual([
      expect.objectContaining({
        id: 'shipyard.yard.unlaid',
        evidence: ['CLAUDE.md', 'GLOSSARY.md'],
      }),
    ]);
  });

  it('requires both day-one faces while accepting only a recognizable legacy glossary', () => {
    writeFileSync(join(yard, 'GLOSSARY.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    const glossaryOnly = runAudit(yard);
    expect(glossaryOnly.status).toBe(1);
    expect(glossaryOnly.report!.findings.map((f) => f.id)).toEqual(['shipyard.yard.unlaid']);
    expect(glossaryOnly.report!.findings[0].evidence).toEqual(['CLAUDE.md']);

    rmSync(join(yard, 'GLOSSARY.md'));
    writeFileSync(join(yard, 'CLAUDE.md'), '# Project\n');
    const claudeOnly = runAudit(yard);
    expect(claudeOnly.status).toBe(1);
    expect(claudeOnly.report!.findings.map((f) => f.id)).toEqual(['shipyard.yard.unlaid']);
    expect(claudeOnly.report!.findings[0].evidence).toEqual(['GLOSSARY.md']);

    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    expect(runAudit(yard).report!.findings).toEqual([]);
  });

  it('exits 0 with zero findings on a yard seeded per the drydock two-face form (end-to-end)', () => {
    // T68 e2e: the fixture is built from drydock's own seed blocks, so the audit
    // must bless exactly what the skill text's lazy two-face seeding produces —
    // CLAUDE.md (Seed A) + GLOSSARY.md (Seed B) and nothing else.
    const DRYDOCK = readFileSync(join(REPO, 'skills', 'drydock', 'SKILL.md'), 'utf-8');
    const seedBlock = (name: string): string => {
      const pattern = `<!-- shipyard-seed-${name}:en:start -->\\n\`\`\`markdown\\n([\\s\\S]*?)\\n\`\`\`\\n<!-- shipyard-seed-${name}:en:end -->`;
      const m = DRYDOCK.match(new RegExp(pattern));
      expect(m, `drydock seed ${name} (en) not found in SKILL.md`).toBeDefined();
      return m![1];
    };
    writeFileSync(join(yard, 'CLAUDE.md'), seedBlock('a'));
    writeFileSync(join(yard, 'GLOSSARY.md'), seedBlock('b'));
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
    expect(report!.summary.verdict).toBe('clear');
  });

  it('accepts the required two-face yard without flagging absent optional surfaces', () => {
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'GLOSSARY.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.summary.verdict).toBe('clear');
    expect(report!.findings).toEqual([]);
  });

  it('checks adopted surfaces without flagging absent optional surfaces', () => {
    seedCleanYard(yard);
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.summary.verdict).toBe('clear');
    expect(report!.findings).toEqual([]);
  });

  it('on a partially adopted yard, checks only the surfaces that exist', () => {
    // Adopted: CLAUDE.md + legacy CONTEXT.md + scripts/. Everything else absent —
    // under adoption-is-declaration, absence means "not adopted", not "missing".
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    mkdirSync(join(yard, 'scripts'), { recursive: true });
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
  });

  it('still checks the integrity of an adopted surface', () => {
    // Partial yard, but the adopted GLOSSARY.md is malformed: the audit must
    // still flag it — lazy seeding removes missing-surface noise, not quality
    // gates on surfaces a yard chose to adopt.
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'GLOSSARY.md'), '# Glossary (no frontmatter)\n');
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    expect(report!.findings.some((f) => f.id === 'shipyard.document-language.missing-frontmatter')).toBe(true);
    expect(report!.findings.map((f) => f.id)).not.toContain('shipyard.surface.missing.CONTEXT-md');
  });

  it('exits 0 on a yard with only the new GLOSSARY.md name', () => {
    seedCleanYard(yard, 'GLOSSARY.md');
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
    expect(report!.summary.verdict).toBe('clear');
  });

  it('exits 0 on a yard with only the legacy CONTEXT.md name (expand semantics locked)', () => {
    seedCleanYard(yard, 'CONTEXT.md');
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
  });

  it('emits a duplicate-glossary-authority finding when both GLOSSARY.md and CONTEXT.md exist', () => {
    seedCleanYard(yard, 'GLOSSARY.md');
    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    const result = runAudit(yard);
    expect(result.status).toBe(1);
    expect(result.report!.findings.some((f) => f.id === 'shipyard.glossary.duplicate-authority')).toBe(true);

    // the duplicate-authority finding is reported even when both files have valid tags
    const findings = result.report!.findings.filter((f) => f.id === 'shipyard.glossary.duplicate-authority');
    expect(findings.length).toBe(1);
    expect(findings[0].evidence).toEqual(['GLOSSARY.md', 'CONTEXT.md']);
  });

  it('ignores an unrelated CONTEXT.md without the glossary signature', () => {
    seedCleanYard(yard, 'GLOSSARY.md');
    writeFileSync(join(yard, 'CONTEXT.md'), '# Agent context\n\nNotes for coding agents.\n');
    const beside = runAudit(yard);
    expect(beside.status).toBe(0);
    expect(beside.report!.findings).toEqual([]);

    // a lone unrelated CONTEXT.md does not satisfy the glossary surface
    rmSync(join(yard, 'GLOSSARY.md'));
    const alone = runAudit(yard);
    expect(alone.status).toBe(1);
    const ids = alone.report!.findings.map((f) => f.id);
    expect(ids).toContain('shipyard.yard.unlaid');
    expect(alone.report!.findings.find((f) => f.id === 'shipyard.yard.unlaid')?.evidence).toEqual(['GLOSSARY.md']);
    expect(ids.some((id) => id.startsWith('shipyard.document-language.'))).toBe(false);
  });

  it('recognizes a legacy CONTEXT.md glossary that predates the documentLanguage tag by its seed heading', () => {
    for (const heading of ['Glossary', '术语表', '詞彙表']) {
      rmSync(yard, { recursive: true, force: true });
      yard = mkdtempSync(join(tmpdir(), 'shipyard-audit-'));
      writeFileSync(join(yard, 'CLAUDE.md'), '# Project\n');
      writeFileSync(join(yard, 'CONTEXT.md'), `# ${heading}\n\n## term\n`);
      const alone = runAudit(yard);
      const ids = alone.report!.findings.map((f) => f.id);
      expect(ids).toContain('shipyard.document-language.missing-frontmatter');

      seedCleanYard(yard, 'GLOSSARY.md');
      writeFileSync(join(yard, 'CONTEXT.md'), `# ${heading}\n\n## term\n`);
      const beside = runAudit(yard);
      expect(beside.report!.findings.some((f) => f.id === 'shipyard.glossary.duplicate-authority')).toBe(true);
    }
  });

  it('an empty frontmatter block before the seed heading still marks a legacy glossary', () => {
    writeFileSync(join(yard, 'CLAUDE.md'), '# Project\n');
    writeFileSync(join(yard, 'CONTEXT.md'), '---\n---\n\n# Glossary\n');
    const ids = runAudit(yard).report!.findings.map((f) => f.id);
    expect(ids).toContain('shipyard.document-language.missing-tag');
  });

  it('a BOM before the frontmatter does not hide it', () => {
    seedCleanYard(yard, 'GLOSSARY.md');
    writeFileSync(join(yard, 'GLOSSARY.md'), '\uFEFF---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    expect(runAudit(yard).report!.findings).toEqual([]);
    rmSync(join(yard, 'GLOSSARY.md'));
    writeFileSync(join(yard, 'CONTEXT.md'), '\uFEFF---\ndocumentLanguage: en\n---\n\nAgent notes.\n');
    expect(runAudit(yard).report!.findings).toEqual([]);
  });

  it('a BOM or leading HTML comment before the seed heading still marks a legacy glossary', () => {
    for (const content of ['\uFEFF# Glossary\n\n## term\n', '<!-- provenance: drydock -->\n# Glossary\n\n## term\n']) {
      rmSync(yard, { recursive: true, force: true });
      yard = mkdtempSync(join(tmpdir(), 'shipyard-audit-'));
      writeFileSync(join(yard, 'CLAUDE.md'), '# Project\n');
      writeFileSync(join(yard, 'CONTEXT.md'), content);
      const ids = runAudit(yard).report!.findings.map((f) => f.id);
      expect(ids).not.toContain('shipyard.yard.unlaid');
    }
  });

  it('only a seed heading on the first non-blank line marks a legacy glossary', () => {
    seedCleanYard(yard, 'GLOSSARY.md');
    for (const content of [
      'Agent notes.\n\n```markdown\n# Glossary\n```\n',
      '<!--\n# Glossary\n-->\nAgent notes.\n',
      '# Agent context\n\n# Glossary\n',
    ]) {
      writeFileSync(join(yard, 'CONTEXT.md'), content);
      const { status, report } = runAudit(yard);
      expect(status).toBe(0);
      expect(report!.findings).toEqual([]);
    }
  });

  it('every finding carries the shared severity/confidence/actionable vocabulary', () => {
    writeFileSync(join(yard, 'CONTEXT.md'), '# Glossary (no frontmatter)\n');
    const { report } = runAudit(yard);
    expect(report!.findings.length).toBeGreaterThan(0);
    for (const f of report!.findings) {
      expect(['high', 'medium', 'low', 'info']).toContain(f.severity);
      expect(['high', 'low']).toContain(f.confidence);
      expect(typeof f.actionable).toBe('boolean');
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('reports a missing documentLanguage tag and an invalid tag distinctly on GLOSSARY.md', () => {
    for (const glossaryFile of ['GLOSSARY.md'] as const) {
      // fresh yard per iteration: a leftover GLOSSARY.md would shadow the
      // legacy name in the second pass
      rmSync(yard, { recursive: true, force: true });
      yard = mkdtempSync(join(tmpdir(), 'shipyard-audit-'));
      writeFileSync(join(yard, glossaryFile), '# Glossary (no frontmatter)\n');
      const { report } = runAudit(yard);
      expect(report!.findings.some((f) => f.id === 'shipyard.document-language.missing-frontmatter')).toBe(true);

      writeFileSync(join(yard, glossaryFile), '---\nnotLanguage: en\n---\n\n# Glossary\n');
      const second = runAudit(yard);
      expect(second.report!.findings.some((f) => f.id === 'shipyard.document-language.missing-tag')).toBe(true);

      writeFileSync(join(yard, glossaryFile), '---\ndocumentLanguage: not-a-tag!\n---\n\n# Glossary\n');
      const third = runAudit(yard);
      expect(third.report!.findings.some((f) => f.id === 'shipyard.document-language.invalid-tag')).toBe(true);
    }
  });

  it('reports an invalid documentLanguage tag on a legacy CONTEXT.md glossary', () => {
    writeFileSync(join(yard, 'CLAUDE.md'), '# Project\n');
    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: not-a-tag!\n---\n\n# Glossary\n');
    const { report } = runAudit(yard);
    expect(report!.findings.some((f) => f.id === 'shipyard.document-language.invalid-tag')).toBe(true);
    expect(report!.findings.some((f) => f.id === 'shipyard.yard.unlaid')).toBe(false);
  });

  it('reports dead paths referenced from CLAUDE.md', () => {
    seedCleanYard(yard);
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Standards index\n\n- Architecture: docs/standards/architecture.md\n- Ghost: docs/standards/does-not-exist.md\n',
    );
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    const dead = report!.findings.filter((f) => f.id.startsWith('shipyard.claude-md.dead-path'));
    expect(dead.length).toBe(1);
    expect(dead[0].evidence).toEqual(['docs/standards/does-not-exist.md']);
  });

  it('gives each dead path its own finding id and reports a repeated path once', () => {
    seedCleanYard(yard);
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n- Ghost: docs/standards/ghost-a.md\n- Ghost again: docs/standards/ghost-a.md\n- Other ghost: docs/standards/ghost-b.md\n',
    );
    const { report } = runAudit(yard);
    const dead = report!.findings.filter((f) => f.id.startsWith('shipyard.claude-md.dead-path'));
    expect(dead.map((f) => f.evidence[0]).sort()).toEqual([
      'docs/standards/ghost-a.md',
      'docs/standards/ghost-b.md',
    ]);
    // ids must be unique, or a consumer keying findings by id silently loses one
    expect(new Set(dead.map((f) => f.id)).size).toBe(dead.length);
  });

  it('ignores paths inside fenced code blocks', () => {
    seedCleanYard(yard);
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\nRun the seed:\n\n```bash\nmkdir -p docs/standards/<area>\ncat scripts/never-exists.mjs\n```\n\n~~~\ndesign-system/tokens/<name>.json\n~~~\n\n- Architecture: docs/standards/architecture.md\n',
    );
    const { status, report } = runAudit(yard);
    expect(report!.findings.filter((f) => f.id.startsWith('shipyard.claude-md.dead-path'))).toEqual([]);
    expect(status).toBe(0);
  });

  it('never emits heuristic-class findings (terms unused, standards unreferenced)', () => {
    seedCleanYard(yard);
    const { report } = runAudit(yard);
    expect(
      report!.findings.every((f) => !f.id.startsWith('shipyard.glossary') && !f.id.startsWith('shipyard.standards')),
    ).toBe(true);
  });
});
