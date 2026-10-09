import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

function seedCleanYard(root: string): void {
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Project\n\n## Project conventions\n\n- conventions\n\n## Standards index\n\n- Architecture: docs/standards/architecture.md\n',
  );
  writeFileSync(join(root, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
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
    expect(report!.findings).toEqual([]);
    expect(report!.summary.verdict).toBe('clear');
  });

  it('exits 0 with no findings on an empty directory (absence is not a claim)', () => {
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.summary.verdict).toBe('clear');
    expect(report!.findings).toEqual([]);
  });

  it('exits 0 with no missing-surface findings on a minimal two-surface yard', () => {
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'GLOSSARY.md'), '# Glossary\n');
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.summary.verdict).toBe('clear');
    expect(report!.findings.filter((f) => f.id.startsWith('shipyard.surface.missing'))).toEqual([]);
  });

  it('checks all surfaces of a full nine-surface yard without missing-surface findings', () => {
    seedCleanYard(yard);
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.summary.verdict).toBe('clear');
    expect(report!.findings.filter((f) => f.id.startsWith('shipyard.surface.missing'))).toEqual([]);
  });

  it('on a partially adopted yard, checks only the surfaces that exist', () => {
    // Adopted: CLAUDE.md + CONTEXT.md + scripts/. Everything else absent —
    // under adoption-is-declaration, absence means "not adopted", not "missing".
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
    mkdirSync(join(yard, 'scripts'), { recursive: true });
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings.filter((f) => f.id.startsWith('shipyard.surface.missing'))).toEqual([]);
  });

  it('still checks the integrity of an adopted surface', () => {
    // Partial yard, but the adopted CONTEXT.md is malformed: the audit must
    // still flag it — lazy seeding removes missing-surface noise, not quality
    // gates on surfaces a yard chose to adopt.
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Project conventions\n\n- conventions\n',
    );
    writeFileSync(join(yard, 'CONTEXT.md'), '# Glossary (no frontmatter)\n');
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    expect(report!.findings.some((f) => f.id === 'shipyard.document-language.missing-frontmatter')).toBe(true);
    expect(report!.findings.filter((f) => f.id.startsWith('shipyard.surface.missing'))).toEqual([]);
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

  it('reports a missing documentLanguage tag and an invalid tag distinctly', () => {
    writeFileSync(join(yard, 'CONTEXT.md'), '# Glossary (no frontmatter)\n');
    const { report } = runAudit(yard);
    expect(report!.findings.some((f) => f.id === 'shipyard.document-language.missing-frontmatter')).toBe(true);

    writeFileSync(join(yard, 'CONTEXT.md'), '---\nnotLanguage: en\n---\n\n# Glossary\n');
    const second = runAudit(yard);
    expect(second.report!.findings.some((f) => f.id === 'shipyard.document-language.missing-tag')).toBe(true);

    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: not-a-tag!\n---\n\n# Glossary\n');
    const third = runAudit(yard);
    expect(third.report!.findings.some((f) => f.id === 'shipyard.document-language.invalid-tag')).toBe(true);
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
