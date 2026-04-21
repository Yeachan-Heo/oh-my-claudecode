import { execFileSync } from 'node:child_process';
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

describe('stack-provision executable workflow', () => {
  it('discovers local and indexed candidates, then reviews, promotes, verifies, and rolls back', () => {
    const tempDir = makeTempDir();
    const runRoot = join(tempDir, 'runs');
    const installedRoot = join(tempDir, 'installed-skills');
    const bundledRoot = join(tempDir, 'bundled-skills');
    const pluginRoot = join(tempDir, 'plugin-cache');
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
      'Next.js React Tailwind visual QA and image generation patterns.',
      'Covers Next.js component architecture, visual-regression, image-generation, typography, and motion.',
    );
    writeSkill(
      pluginRoot,
      'visual-verdict',
      'visual-verdict',
      'Visual QA screenshot verdict loop for generated assets.',
      'Covers visual-creative, visual-qa, image-generation, illustration, iconography, and motion.',
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
      '--sources=installed,bundled,plugin,skills-sh,plugin-marketplace,github',
      '--installed-root',
      installedRoot,
      '--bundled-root',
      bundledRoot,
      '--plugin-root',
      pluginRoot,
      '--skills-sh-index',
      skillsShIndex,
      '--plugin-marketplace-index',
      pluginMarketplaceIndex,
      '--github-index',
      githubIndex,
      '--json',
    ]);

    expect(discovery.candidates).toBeGreaterThanOrEqual(6);
    expect(discovery.coverage_summary.covered_cells).toBeGreaterThan(0);
    const candidates = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'));
    expect(candidates.candidates.map((candidate: { source: string }) => candidate.source)).toEqual(
      expect.arrayContaining([
        'installed-skill',
        'bundled-skill',
        'plugin-skill',
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
    expect(promotion.installed).toBeGreaterThanOrEqual(2);
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
});
