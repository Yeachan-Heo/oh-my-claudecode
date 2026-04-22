import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const initScript = join(root, 'skills', 'stack-provision', 'scripts', 'init.mjs');
const provisionScript = join(root, 'skills', 'stack-provision', 'scripts', 'provision.mjs');
const fixedNow = '2026-04-21T00:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-stack-provision-workflow-'));
  tempDirs.push(dir);
  return dir;
}

function run(script: string, args: string[]) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OMC_STACK_PROVISION_NOW: fixedNow,
    },
  });
  return JSON.parse(output);
}

function runFailure(script: string, args: string[]) {
  try {
    execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMC_STACK_PROVISION_NOW: fixedNow,
      },
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected command to fail');
}

function writeSkill(skillRoot: string, slug: string, name: string, description: string, body: string) {
  const dir = join(skillRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
}

function sha256(content: string) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

describe('stack-provision executable workflow', () => {
  it('discovers local and indexed candidates, then reviews, promotes, verifies, and rolls back', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const installedRoot = join(tempDir, 'installed-skills');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const targetSkillRoot = join(tempDir, 'target-skills');

    writeSkill(
      installedRoot,
      'supabase-postgres-best-practices',
      'supabase-postgres-best-practices',
      'Supabase Postgres database performance and security patterns.',
      'Use Postgres indexes, RLS, database testing, auth security, and Supabase observability.',
    );
    writeSkill(
      bundledRoot,
      'next-visual-system',
      'next-visual-system',
      'Next.js React Tailwind component-architecture testing visual-regression plus visual-creative visual QA and image generation patterns.',
      'Covers Next.js component architecture, visual-regression, image-generation, typography, and motion.',
    );
    const githubSkill = join(tempDir, 'github-skill', 'SKILL.md');
    mkdirSync(join(tempDir, 'github-skill'), { recursive: true });
    writeFileSync(
      githubSkill,
      [
        '---',
        'name: github-next-testing',
        'description: GitHub-hosted Next.js Playwright testing skill.',
        '---',
        '',
        'Next.js testing, Playwright visual-regression, frontend testing.',
      ].join('\n'),
      'utf8',
    );

    const skillsShIndex = join(tempDir, 'skills-sh.json');
    const pluginMarketplaceIndex = join(tempDir, 'plugin-marketplace.json');
    const githubIndex = join(tempDir, 'github-index.json');
    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'supabase-security-pack',
          description: 'Supabase auth security and Postgres database testing.',
          url: 'https://skills.sh/example/supabase-security-pack',
          install_cmd: 'npx skillsadd example/supabase-security-pack',
          tags: ['supabase', 'postgres', 'security'],
        },
      ]),
      'utf8',
    );
    writeFileSync(
      pluginMarketplaceIndex,
      JSON.stringify([
        {
          name: 'figma-visual-plugin',
          description: 'Plugin marketplace visual creative workflow for typography, generated assets, and visual QA.',
          ref: 'figma-visual-plugin@example',
          tags: ['visual', 'typography', 'image-generation'],
        },
      ]),
      'utf8',
    );
    writeFileSync(
      githubIndex,
      JSON.stringify([
        {
          name: 'github-next-testing',
          description: 'GitHub skill for Next.js testing and visual regression.',
          url: 'https://github.com/example/github-next-testing',
          content_path: githubSkill,
          tags: ['next.js', 'testing', 'visual-regression'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'next.js, react, tailwind, supabase, postgres, playwright, typography',
      '--surfaces=frontend-engineering,visual-creative',
      '--creative-intent=custom visuals and generated objects',
      '--run-id=workflow-run',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'workflow-run');

    const discovery = run(provisionScript, [
      'discover',
      runDir,
      '--sources=installed,bundled,skills-sh,plugin-marketplace,github',
      '--installed-root',
      installedRoot,
      '--bundled-root',
      bundledRoot,
      '--skills-sh-index',
      skillsShIndex,
      '--plugin-marketplace-index',
      pluginMarketplaceIndex,
      '--github-index',
      githubIndex,
      '--json',
    ]);

    expect(discovery.candidates).toBeGreaterThanOrEqual(5);
    expect(discovery.coverage_summary.covered_cells).toBeGreaterThan(0);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates.map((candidate: { source: string }) => candidate.source)).toEqual(
      expect.arrayContaining([
        'installed-skill',
        'bundled-skill',
        'skills-sh',
        'plugin-marketplace',
        'github',
      ]),
    );

    const approvalIds = candidates.candidates
      .filter((candidate: { source: string }) =>
        ['bundled-skill', 'github', 'plugin-marketplace'].includes(candidate.source),
      )
      .map((candidate: { candidate_id: string }) => candidate.candidate_id)
      .join(',');

    const review = run(provisionScript, [
      'review',
      runDir,
      '--approve',
      approvalIds,
      '--approved-by=tester',
      '--json',
    ]);

    expect(review.approved).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(runDir, 'install-plan.json'))).toBe(true);
    expect(existsSync(join(runDir, 'review-decision.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'review.md'), 'utf8')).toContain('#### Preview');
    expect(readFileSync(join(runDir, 'review.md'), 'utf8')).toContain('Covers Next.js component architecture');

    const promotion = run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--json',
    ]);

    expect(promotion.status).toBe('success');
    expect(promotion.installed).toBeGreaterThanOrEqual(1);
    expect(promotion.quarantined).toBeGreaterThanOrEqual(0);
    expect(promotion.pending_user_actions).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    expect(manifest.pending_user_actions[0].source).toBe('plugin-marketplace');
    for (const item of manifest.installed) {
      expect(existsSync(item.target_path)).toBe(true);
    }

    const verification = run(provisionScript, [
      'verify',
      runDir,
      '--json',
    ]);
    expect(verification.status).toBe('success');

    const rollback = run(provisionScript, [
      'rollback',
      runDir,
      '--json',
    ]);
    expect(rollback.status).toBe('rolled_back');

    const rolledBackManifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    expect(rolledBackManifest.status).toBe('rolled_back');
    for (const item of manifest.installed) {
      expect(existsSync(item.target_path)).toBe(false);
    }
  });

  it('defaults local discovery and promotion to the current project skill directories', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const projectRoot = join(tempDir, 'project');

    writeSkill(
      join(projectRoot, 'skills'),
      'react-component-architecture',
      'react-component-architecture',
      'React component architecture skill for frontend-engineering components and design-system implementation.',
      'Covers React component architecture, shadcn registry review, accessibility, and Storybook visual testing.',
    );
    writeSkill(
      join(projectRoot, '.claude', 'skills'),
      'current-project-frontend',
      'current-project-frontend',
      'React frontend-engineering component-architecture skill installed in the current project .claude skills directory.',
      'Covers React frontend-engineering component-architecture, shadcn registry review, and accessibility.',
    );

    run(initScript, [
      'react, shadcn',
      '--surfaces=frontend-engineering',
      '--aspects=component-architecture',
      '--run-id=project-scoped-defaults',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'project-scoped-defaults');

    run(provisionScript, [
      'discover',
      runDir,
      '--project-root',
      projectRoot,
      '--sources=installed,bundled',
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates.map((candidate: { source: string }) => candidate.source)).toEqual(
      expect.arrayContaining(['installed-skill', 'bundled-skill']),
    );
    expect(candidates.candidates.every((candidate: { path: string | null }) =>
      !candidate.path || candidate.path.startsWith(projectRoot),
    )).toBe(true);

    run(provisionScript, [
      'review',
      runDir,
      '--approve-local',
      '--critic-verdict=approve',
      '--json',
    ]);
    run(provisionScript, [
      'promote',
      runDir,
      '--project-root',
      projectRoot,
      '--json',
    ]);

    expect(
      existsSync(join(projectRoot, '.claude', 'skills', 'omc-provisioned', 'react-component-architecture', 'SKILL.md')),
    ).toBe(true);
  });

  it('does not parse local plugin skill caches even when plugin source is requested', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const pluginRoot = join(tempDir, 'plugin-cache');

    writeSkill(
      pluginRoot,
      'visual-verdict',
      'visual-verdict',
      'Visual-creative visual QA screenshot verdict loop for generated assets.',
      'Covers visual-creative, visual-qa, image-generation, illustration, iconography, and motion.',
    );

    run(initScript, [
      'visual qa',
      '--surfaces=visual-creative',
      '--aspects=visual-qa',
      '--run-id=plugin-source-disabled',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'plugin-source-disabled');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=plugin',
      '--plugin-root',
      pluginRoot,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates).toHaveLength(0);
    expect(candidates.warnings).toEqual(
      expect.arrayContaining([
        'plugin skipped: local plugin skill caches are disabled for stack-provision discovery',
      ]),
    );
  });

  it('discovers configured marketplace registry sources from source indexes', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const agentskillIndex = join(tempDir, 'agentskill-sh.json');

    writeFileSync(
      agentskillIndex,
      JSON.stringify([
        {
          name: 'agentskill-product-visual-system',
          description: 'React shadcn Tailwind component architecture visual-creative visual-qa skill.',
          url: 'https://agentskill.sh/skills/product-visual-system',
          updated_at: fixedNow,
          license: 'MIT',
          quality_score: 92,
          security_score: 97,
          tags: ['react', 'shadcn', 'component-architecture', 'visual-creative', 'visual-qa'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'react, shadcn, tailwind',
      '--surfaces=frontend-engineering,visual-creative',
      '--aspects=component-architecture,visual-qa',
      '--run-id=registry-source-index',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'registry-source-index');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=agentskill-sh',
      `--source-index=agentskill-sh=${agentskillIndex}`,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const candidate = candidates.candidates.find((item: { slug: string }) =>
      item.slug === 'agentskill-product-visual-system',
    );
    expect(candidate.source).toBe('agentskill-sh');
    expect(candidate.source_quality.signals).toEqual(
      expect.arrayContaining([
        'external-index',
        'registered-marketplace',
        'specialized-platform',
        'high-quality-score',
        'high-security-score',
      ]),
    );
    expect(candidate.install).toMatchObject({
      kind: 'external-command',
      command: '/learn agentskill-product-visual-system',
    });
    expect(candidate.covered_aspects).toEqual(
      expect.arrayContaining(['component-architecture', 'visual-qa']),
    );
  });

  it('adds indexed registry sources to the selected discovery sources', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const agentskillIndex = join(tempDir, 'agentskill-sh.json');
    mkdirSync(bundledRoot, { recursive: true });

    writeFileSync(
      agentskillIndex,
      JSON.stringify([
        {
          ref: '@omc/product-visual-system',
          name: 'Product Visual System',
          description: 'React shadcn Tailwind component architecture visual-creative visual-qa skill.',
          url: 'https://agentskill.sh/skills/product-visual-system',
          updated_at: fixedNow,
          license: 'MIT',
          quality_score: 91,
          security_score: 96,
          tags: ['react', 'shadcn', 'component-architecture', 'visual-creative', 'visual-qa'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'react, shadcn, tailwind',
      '--surfaces=frontend-engineering,visual-creative',
      '--aspects=component-architecture,visual-qa',
      '--run-id=registry-source-auto-include',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'registry-source-auto-include');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      `--source-index=agentskill-sh=${agentskillIndex}`,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.sources).toEqual(['bundled', 'agentskill-sh']);
    const candidate = candidates.candidates.find((item: { source: string }) =>
      item.source === 'agentskill-sh',
    );
    expect(candidate.install.command).toBe('/learn @omc/product-visual-system');
  });

  it('shortlists marketplace discovery and blocks download candidates without content checksums', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const skillsShIndex = join(tempDir, 'skills-sh.json');

    writeFileSync(
      skillsShIndex,
      JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
        name: `next-download-testing-${index}`,
        description: 'Next.js frontend testing and Playwright visual-regression.',
        url: `https://skills.sh/example/next-download-testing-${index}`,
        skill_md_url: `https://skills.sh/example/next-download-testing-${index}/SKILL.md`,
        updated_at: fixedNow,
        license: 'MIT',
        tags: ['next.js', 'testing', 'visual-regression'],
      }))),
      'utf8',
    );

    run(initScript, [
      'next.js, playwright',
      '--surfaces=frontend-engineering',
      '--aspects=testing',
      '--run-id=download-checksum-required',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'download-checksum-required');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=skills-sh',
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.selection_summary.discovered_candidates).toBe(5);
    expect(candidates.candidates).toHaveLength(3);
    expect(candidates.candidates[0].install.kind).toBe('download-skill');
    expect(candidates.candidates[0].risk_flags).toEqual(
      expect.arrayContaining(['missing-content-checksum', 'strict-gate:checksum_invalid']),
    );
    expect(candidates.candidates[0].strict_gate.install_allowed).toBe(false);
  });

  it('promotes download-skill candidates only when fetched content matches expected sha256', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const targetSkillRoot = join(tempDir, 'target-skills');
    const skillsShIndex = join(tempDir, 'skills-sh.json');
    const content = [
      '---',
      'name: verified-next-testing',
      'description: Next.js frontend testing and visual-regression.',
      '---',
      '',
      'Use Playwright visual-regression tests for Next.js components.',
      '',
    ].join('\n');

    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'verified-next-testing',
          description: 'Next.js frontend testing and Playwright visual-regression.',
          url: 'https://skills.sh/example/verified-next-testing',
          skill_md_url: `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`,
          sha256: sha256(content),
          updated_at: fixedNow,
          license: 'MIT',
          tags: ['next.js', 'testing', 'visual-regression'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'next.js, playwright',
      '--surfaces=frontend-engineering',
      '--aspects=testing',
      '--run-id=verified-download',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'verified-download');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=skills-sh',
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates[0].checksum_valid).toBe(true);
    expect(candidates.candidates[0].strict_gate.install_allowed).toBe(true);

    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--critic-verdict=approve',
      '--json',
    ]);
    const promotion = run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--network',
      '--json',
    ]);

    expect(promotion.status).toBe('success');
    expect(promotion.installed).toBe(1);
    expect(readFileSync(join(targetSkillRoot, 'verified-next-testing', 'SKILL.md'), 'utf8')).toBe(content);
  });

  it('rejects download-skill content when the fetched checksum does not match review', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const targetSkillRoot = join(tempDir, 'target-skills');
    const skillsShIndex = join(tempDir, 'skills-sh.json');
    const content = [
      '---',
      'name: tampered-next-testing',
      'description: Next.js frontend testing and visual-regression.',
      '---',
      '',
      'Original reviewed content.',
      '',
    ].join('\n');
    const fetchedContent = content.replace('Original reviewed content.', 'Tampered downloaded content.');

    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'tampered-next-testing',
          description: 'Next.js frontend testing and Playwright visual-regression.',
          url: 'https://skills.sh/example/tampered-next-testing',
          skill_md_url: `data:text/markdown;charset=utf-8,${encodeURIComponent(fetchedContent)}`,
          sha256: sha256(content),
          updated_at: fixedNow,
          license: 'MIT',
          tags: ['next.js', 'testing', 'visual-regression'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'next.js, playwright',
      '--surfaces=frontend-engineering',
      '--aspects=testing',
      '--run-id=tampered-download',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'tampered-download');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=skills-sh',
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--critic-verdict=approve',
      '--json',
    ]);

    const promotion = run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--network',
      '--json',
    ]);
    expect(promotion.status).toBe('failed');
    expect(promotion.errors.join('\n')).toContain('downloaded skill checksum mismatch');
    expect(existsSync(join(targetSkillRoot, 'tampered-next-testing', 'SKILL.md'))).toBe(false);
  });

  it('blocks promotion unless the review decision is approved', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');

    writeSkill(
      bundledRoot,
      'next-testing',
      'next-testing',
      'Next.js frontend testing and visual-regression.',
      'Next.js React testing visual-regression Playwright.',
    );

    run(initScript, [
      'next.js, react, playwright',
      '--run-id=blocked-run',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'blocked-run');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);
    const review = run(provisionScript, [
      'review',
      runDir,
      '--reject',
      '--json',
    ]);

    expect(review.approved).toBe(0);
    expect(runFailure(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      join(tempDir, 'target-skills'),
      '--json',
    ])).toContain('review confirmation is not approved');
  });

  it('uses structured metadata and aspect-specific packs to avoid false testing coverage', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');

    writeSkill(
      bundledRoot,
      'flutter-reducing-app-size',
      'flutter-reducing-app-size',
      'Flutter performance and app-size optimization.',
      'This body deliberately mentions Flutter testing, but body text is not discovery metadata.',
    );
    writeSkill(
      bundledRoot,
      'flutter-testing',
      'flutter-testing',
      'Flutter testing for widget and integration tests.',
      'This body deliberately mentions performance, but body text is not discovery metadata.',
    );

    run(initScript, [
      'flutter, riverpod',
      '--surfaces=mobile',
      '--aspects=testing,performance',
      '--run-id=structured-matching',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'structured-matching');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const reducing = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'flutter-reducing-app-size',
    );
    const testing = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'flutter-testing',
    );

    expect(reducing.covered_aspects).toEqual(['performance']);
    expect(testing.covered_aspects).toEqual(['testing']);

    const coverage = JSON.parse(readFileSync(join(runDir, 'coverage.json'), 'utf8'));
    expect(coverage.cells).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'mobile',
          technology: 'riverpod',
          aspect: 'performance',
        }),
      ]),
    );
  });

  it('chooses the best candidate per cell using cell score instead of global score', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');

    writeSkill(
      bundledRoot,
      'flutter-kitchen-sink',
      'flutter-kitchen-sink',
      'Flutter architecture navigation state offline-data platform-apis accessibility security observability testing performance.',
      'Broad mobile guidance.',
    );
    writeSkill(
      bundledRoot,
      'flutter-testing',
      'flutter-testing',
      'Flutter testing for widget and integration tests.',
      'Focused testing guidance.',
    );

    run(initScript, [
      'flutter',
      '--surfaces=mobile',
      '--run-id=per-cell-ranking',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'per-cell-ranking');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const broad = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'flutter-kitchen-sink',
    );
    const focused = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'flutter-testing',
    );
    expect(broad.score).toBeGreaterThan(focused.score);

    const coverage = JSON.parse(readFileSync(join(runDir, 'coverage.json'), 'utf8'));
    const testingCell = coverage.cells.find((cell: { surface: string; technology: string; aspect: string }) =>
      cell.surface === 'mobile' && cell.technology === 'flutter' && cell.aspect === 'testing',
    );
    expect(testingCell.best_candidate_id).toBe(focused.candidate_id);
  });

  it('ranks professional external guidance above weaker local matches', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');

    writeSkill(
      bundledRoot,
      'postgres-local-performance',
      'postgres-local-performance',
      'Postgres performance tips.',
      'Local lightweight Postgres performance notes.',
    );

    const skillsShIndex = join(tempDir, 'skills-sh.json');
    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'official-postgres-performance',
          description: 'Postgres performance query optimization indexes and database profiling.',
          url: 'https://www.postgresql.org/docs/current/performance-tips.html',
          tags: ['postgres', 'performance', 'database'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'postgres',
      '--surfaces=backend',
      '--aspects=performance',
      '--run-id=professional-source-ranking',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'professional-source-ranking');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled,skills-sh',
      '--bundled-root',
      bundledRoot,
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const official = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'official-postgres-performance',
    );
    const local = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'postgres-local-performance',
    );
    expect(official.source_quality.signals).toEqual(
      expect.arrayContaining(['external-index', 'professional-domain']),
    );
    expect(official.score).toBeGreaterThan(local.score);

    const coverage = JSON.parse(readFileSync(join(runDir, 'coverage.json'), 'utf8'));
    const performanceCell = coverage.cells.find((cell: { surface: string; technology: string; aspect: string }) =>
      cell.surface === 'backend' && cell.technology === 'postgres' && cell.aspect === 'performance',
    );
    expect(performanceCell.best_candidate_id).toBe(official.candidate_id);
  });

  it('scores official UI and visual sources for frontend capability discovery', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const skillsShIndex = join(tempDir, 'skills-sh.json');

    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'shadcn-component-system',
          description: 'shadcn UI component architecture, accessibility, design tokens, visual-creative, and visual-qa.',
          url: 'https://ui.shadcn.com/docs/components/button',
          updated_at: fixedNow,
          license: 'MIT',
          tags: ['shadcn', 'component-architecture', 'accessibility', 'visual-creative', 'visual-qa'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'react, shadcn, tailwind',
      '--surfaces=frontend-engineering,visual-creative',
      '--aspects=component-architecture,visual-qa',
      '--run-id=official-ui-source-ranking',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'official-ui-source-ranking');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=skills-sh',
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const candidate = candidates.candidates.find((item: { slug: string }) =>
      item.slug === 'shadcn-component-system',
    );
    expect(candidate.source_quality.signals).toEqual(
      expect.arrayContaining(['external-index', 'professional-domain']),
    );
    expect(candidate.covered_surface).toContain('frontend-engineering');
    expect(candidate.covered_aspects).toEqual(
      expect.arrayContaining(['component-architecture', 'visual-qa']),
    );
  });

  it('uses Dart methodology aliases for backend architecture and testing coverage', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const skillsShIndex = join(tempDir, 'skills-sh.json');

    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'effective-dart-backend-methods',
          description: 'Effective Dart clean architecture domain driven design API design and contract testing for Dart backend services.',
          url: 'https://dart.dev/effective-dart',
          tags: ['dart', 'backend', 'clean architecture', 'contract testing'],
          methodologies: ['effective dart', 'clean architecture', 'domain driven design', 'contract testing'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'dart, shelf',
      '--surfaces=backend',
      '--aspects=architecture,testing',
      '--run-id=dart-backend-methodology',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'dart-backend-methodology');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=skills-sh',
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const dartCandidate = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'effective-dart-backend-methods',
    );
    expect(dartCandidate.covered_technology).toContain('dart');
    expect(dartCandidate.covered_aspects).toEqual(
      expect.arrayContaining(['architecture', 'testing']),
    );
    expect(dartCandidate.source_quality.signals).toContain('professional-domain');

    const coverage = JSON.parse(readFileSync(join(runDir, 'coverage.json'), 'utf8'));
    const architectureCell = coverage.cells.find((cell: { surface: string; technology: string; aspect: string }) =>
      cell.surface === 'backend' && cell.technology === 'dart' && cell.aspect === 'architecture',
    );
    expect(architectureCell.best_candidate_id).toBe(dartCandidate.candidate_id);
  });

  it('prioritizes professional guidance for application-block practices', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const skillsShIndex = join(tempDir, 'skills-sh.json');

    writeSkill(
      bundledRoot,
      'stripe-payments-notes',
      'stripe-payments-notes',
      'Stripe payments idempotency notes.',
      'Lightweight Stripe payment notes with a passing mention of idempotency.',
    );

    writeFileSync(
      skillsShIndex,
      JSON.stringify([
        {
          name: 'stripe-idempotency-reconciliation-guide',
          description: 'Stripe payments idempotency keys webhook reliability ledger reconciliation and financial transaction testing.',
          url: 'https://docs.stripe.com/payments',
          tags: ['stripe', 'payments', 'idempotency', 'reconciliation', 'ledger'],
          methodologies: ['idempotency keys', 'webhook reliability', 'ledger reconciliation'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'dart, shelf, stripe',
      '--blocks=finance-transactions',
      '--aspects=idempotency,reconciliation',
      '--run-id=finance-block-guidance',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'finance-block-guidance');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled,skills-sh',
      '--bundled-root',
      bundledRoot,
      '--skills-sh-index',
      skillsShIndex,
      '--json',
    ]);

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const official = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'stripe-idempotency-reconciliation-guide',
    );
    const local = candidates.candidates.find((candidate: { slug: string }) =>
      candidate.slug === 'stripe-payments-notes',
    );

    expect(official.covered_surface).toContain('finance-transactions');
    expect(official.covered_technology).toContain('stripe');
    expect(official.covered_aspects).toEqual(
      expect.arrayContaining(['idempotency', 'reconciliation']),
    );
    expect(official.source_quality.signals).toEqual(
      expect.arrayContaining(['external-index', 'professional-domain']),
    );
    expect(official.score).toBeGreaterThan(local.score);

    const coverage = JSON.parse(readFileSync(join(runDir, 'coverage.json'), 'utf8'));
    const idempotencyCell = coverage.cells.find((cell: { surface: string; technology: string; aspect: string }) =>
      cell.surface === 'finance-transactions' && cell.technology === 'stripe' && cell.aspect === 'idempotency',
    );
    expect(idempotencyCell.best_candidate_id).toBe(official.candidate_id);
  });

  it('blocks source-level approval for risk-bearing external candidates', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const githubSkill = join(tempDir, 'github-risky', 'SKILL.md');
    mkdirSync(dirname(githubSkill), { recursive: true });
    writeFileSync(
      githubSkill,
      [
        '---',
        'name: github-risky',
        'description: GitHub-hosted Next.js testing skill.',
        '---',
        '',
        'Next.js testing Playwright visual-regression.',
      ].join('\n'),
      'utf8',
    );
    const githubIndex = join(tempDir, 'github-index.json');
    writeFileSync(
      githubIndex,
      JSON.stringify([
        {
          name: 'github-risky',
          description: 'GitHub-hosted Next.js testing skill.',
          url: 'https://github.com/example/github-risky',
          content_path: githubSkill,
          stars: 1,
          tags: ['next.js', 'testing'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'next.js, playwright',
      '--run-id=source-approval-blocked',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'source-approval-blocked');

    run(provisionScript, [
      'discover',
      runDir,
      '--sources=github',
      '--github-index',
      githubIndex,
      '--json',
    ]);

    expect(runFailure(provisionScript, [
      'review',
      runDir,
      '--approve-source=github',
      '--json',
    ])).toContain('source-level approval blocked');

    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    const explicitReview = run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--json',
    ]);
    expect(explicitReview.approved).toBe(1);
  });

  it('rejects tampered install plans before promotion', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');

    writeSkill(
      bundledRoot,
      'next-testing',
      'next-testing',
      'Next.js frontend testing and visual-regression.',
      'Next.js React testing visual-regression Playwright.',
    );

    run(initScript, [
      'next.js, playwright',
      '--run-id=tampered-plan',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'tampered-plan');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--json',
    ]);

    const planPath = join(runDir, 'install-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.items[0].slug = 'tampered-slug';
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    expect(runFailure(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      join(tempDir, 'target-skills'),
      '--json',
    ])).toContain('install plan content changed after review');
  });

  it('reports approved candidate hash mismatches without installing', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const targetSkillRoot = join(tempDir, 'target-skills');

    writeSkill(
      bundledRoot,
      'next-testing',
      'next-testing',
      'Next.js frontend testing and visual-regression.',
      'Next.js React testing visual-regression Playwright.',
    );

    run(initScript, [
      'next.js, playwright',
      '--run-id=candidate-hash-mismatch',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'candidate-hash-mismatch');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--json',
    ]);

    const decisionPath = join(runDir, 'review-decision.json');
    const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
    decision.approved_items[0].candidate_hash = 'sha256:tampered';
    writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');

    const promotion = run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--json',
    ]);
    expect(promotion.status).toBe('failed');
    expect(promotion.errors.join('\n')).toContain('approved candidate hash mismatch');
    expect(existsSync(join(targetSkillRoot, 'next-testing', 'SKILL.md'))).toBe(false);
  });

  it('restores overwritten skills from rollback backups', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const targetSkillRoot = join(tempDir, 'target-skills');
    const targetPath = join(targetSkillRoot, 'next-testing', 'SKILL.md');

    writeSkill(
      bundledRoot,
      'next-testing',
      'next-testing',
      'Next.js frontend testing and visual-regression.',
      'Next.js React testing visual-regression Playwright updated content.',
    );
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, 'original skill content\n', 'utf8');

    run(initScript, [
      'next.js, playwright',
      '--run-id=restore-backup',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'restore-backup');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--json',
    ]);
    run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--json',
    ]);
    expect(readFileSync(targetPath, 'utf8')).toContain('updated content');

    const rollback = run(provisionScript, [
      'rollback',
      runDir,
      '--json',
    ]);
    expect(rollback.status).toBe('rolled_back');
    expect(readFileSync(targetPath, 'utf8')).toBe('original skill content\n');
  });

  it('fails loudly when persisted artifacts violate schemas', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');

    run(initScript, [
      'next.js, playwright',
      '--run-id=schema-guard',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'schema-guard');
    writeFileSync(
      join(runDir, 'candidates.json'),
      JSON.stringify({ schema_version: 1, run_id: 'schema-guard' }),
      'utf8',
    );

    expect(runFailure(provisionScript, [
      'review',
      runDir,
      '--approve=anything',
      '--json',
    ])).toContain('failed candidates schema validation');
  });

  it('blocks promotion when critic verdict is not approve', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const targetSkillRoot = join(tempDir, 'target-skills');

    writeSkill(
      bundledRoot,
      'next-testing',
      'next-testing',
      'Next.js frontend testing and visual-regression.',
      'Next.js React testing visual-regression Playwright.',
    );

    run(initScript, [
      'next.js, playwright',
      '--run-id=critic-gate',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'critic-gate');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=bundled',
      '--bundled-root',
      bundledRoot,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--critic-verdict=revise',
      '--json',
    ]);

    expect(runFailure(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--json',
    ])).toContain('critic verdict is not approve');
  });

  it('quarantines strict-gate failures instead of installing', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const targetSkillRoot = join(tempDir, 'target-skills');
    const githubSkill = join(tempDir, 'github-stale', 'SKILL.md');
    mkdirSync(dirname(githubSkill), { recursive: true });
    writeFileSync(
      githubSkill,
      [
        '---',
        'name: github-stale',
        'description: Stale GitHub skill.',
        '---',
        '',
        'Next.js testing.',
      ].join('\n'),
      'utf8',
    );
    const githubIndex = join(tempDir, 'github-index.json');
    writeFileSync(
      githubIndex,
      JSON.stringify([
        {
          name: 'github-stale',
          description: 'Stale GitHub hosted skill.',
          url: 'https://github.com/example/github-stale',
          content_path: githubSkill,
          stars: 2,
          updated_at: '2020-01-01T00:00:00.000Z',
          tags: ['next.js', 'testing'],
        },
      ]),
      'utf8',
    );

    run(initScript, [
      'next.js, playwright',
      '--run-id=strict-gate-quarantine',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'strict-gate-quarantine');
    run(provisionScript, [
      'discover',
      runDir,
      '--sources=github',
      '--github-index',
      githubIndex,
      '--json',
    ]);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates[0].risk_flags).toEqual(
      expect.arrayContaining(['strict-gate-failed']),
    );

    run(provisionScript, [
      'review',
      runDir,
      '--approve',
      candidates.candidates[0].candidate_id,
      '--critic-verdict=approve',
      '--json',
    ]);
    const promotion = run(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      targetSkillRoot,
      '--json',
    ]);
    expect(promotion.quarantined).toBe(1);
    expect(promotion.installed).toBe(0);

    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    expect(manifest.quarantined).toHaveLength(1);
    expect(existsSync(join(targetSkillRoot, 'github-stale', 'SKILL.md'))).toBe(false);
  });

  it('blocks promotion when compatibility report is blocked', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');

    run(initScript, [
      'ffi, edge-runtime, node',
      '--surfaces=backend',
      '--run-id=compat-blocked',
      '--out',
      runRoot,
      '--json',
    ]);
    const runDir = join(runRoot, 'compat-blocked');
    writeFileSync(
      join(runDir, 'candidates.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'compat-blocked',
        created_at: fixedNow,
        sources: [],
        warnings: [],
        candidates: [],
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(runDir, 'install-plan.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'compat-blocked',
        created_at: fixedNow,
        hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        items: [],
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(runDir, 'review-decision.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'compat-blocked',
        install_plan_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approved_items: [],
        confirmation: {
          approved: true,
          approved_at: fixedNow,
          approved_by: 'tester',
          critic_verdict: 'approve',
          research_acknowledged: true,
        },
      }, null, 2),
      'utf8',
    );

    expect(runFailure(provisionScript, [
      'promote',
      runDir,
      '--skill-root',
      join(tempDir, 'target-skills'),
      '--json',
    ])).toContain('compatibility report is blocked');
  });
});
