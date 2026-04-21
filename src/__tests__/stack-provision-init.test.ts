import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'skills', 'stack-provision', 'scripts', 'init.mjs');
const fixedNow = '2026-04-21T00:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-stack-provision-'));
  tempDirs.push(dir);
  return dir;
}

function runStackProvision(args: string[]) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMC_STACK_PROVISION_NOW: fixedNow,
    },
  });
  return JSON.parse(output);
}

describe('stack-provision init helper', () => {
  it('derives backend, frontend, and visual capability packs without installing anything', () => {
    const result = runStackProvision([
      'next.js, react, tailwind, framer-motion, three.js, supabase, postgres',
      '--surfaces=frontend-engineering,visual-creative',
      '--creative-intent=distinct visual identity',
      '--run-id=test-run',
      '--dry-run',
      '--json',
    ]);

    expect(result.dry_run).toBe(true);
    expect(result.contract.policy.human_gate_required).toBe(true);
    expect(result.contract.policy.quarantine_required).toBe(true);
    expect(result.contract.policy.allow_generated_install_by_default).toBe(false);
    expect(result.contract.stack).toEqual(
      expect.arrayContaining(['next.js', 'react', 'tailwind', 'framer-motion', 'three.js', 'supabase', 'postgres']),
    );
    expect(result.surfaces).toEqual(
      expect.arrayContaining(['backend', 'frontend-engineering', 'visual-creative']),
    );
    expect(result.surfaces).not.toContain('mobile');
    expect(result.capability_packs).toEqual(
      expect.arrayContaining([
        'database-performance',
        'frontend-architecture',
        'creative-direction',
        'image-generation',
        'visual-qa',
      ]),
    );
    expect(result.capability_matrix.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'visual-creative',
          technology: 'framer-motion',
          aspect: 'image-generation',
        }),
        expect.objectContaining({
          surface: 'backend',
          technology: 'postgres',
          aspect: 'database',
        }),
      ]),
    );
  });

  it('writes a quarantined run directory and current pointer', () => {
    const tempDir = makeTempDir();
    const outRoot = join(tempDir, 'runs');

    const result = runStackProvision([
      'next.js, react, tailwind, framer-motion',
      '--surfaces=frontend-engineering,visual-creative',
      '--creative-intent=visual system with custom generated objects',
      '--run-id=test-write',
      '--out',
      outRoot,
      '--json',
    ]);

    const runDir = join(outRoot, 'test-write');
    const contractPath = join(runDir, 'contract.json');
    const matrixPath = join(runDir, 'capability-matrix.json');
    const statePath = join(runDir, 'state.json');
    const reviewPath = join(runDir, 'review.md');
    const currentPath = join(tempDir, 'current.json');

    for (const path of [contractPath, matrixPath, statePath, reviewPath, currentPath]) {
      expect(existsSync(path)).toBe(true);
    }

    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const current = JSON.parse(readFileSync(currentPath, 'utf8'));
    const review = readFileSync(reviewPath, 'utf8');

    expect(contract.run_id).toBe('test-write');
    expect(contract.created_at).toBe(fixedNow);
    expect(contract.policy.dry_run).toBe(false);
    expect(matrix.cells.some((cell: { surface: string; aspect: string }) =>
      cell.surface === 'visual-creative' && cell.aspect === 'image-generation',
    )).toBe(true);
    expect(state.current_phase).toBe('contract');
    expect(state.status).toBe('initialized');
    expect(current.run_id).toBe('test-write');
    expect(review).toContain('## Visual-Creative Contract');
    expect(review).toContain('Human review gate: required');
    expect(result.artifacts.review).toBe(reviewPath);
  });

  it('extracts stack technologies from ADR decision sections', () => {
    const tempDir = makeTempDir();
    const adrPath = join(tempDir, 'stack.md');
    writeFileSync(
      adrPath,
      [
        '# Stack ADR',
        '',
        '## Decision',
        '',
        '- Frontend: Next.js 15, React, Tailwind CSS',
        '- Backend: Supabase, Postgres',
        '- QA: Playwright',
      ].join('\n'),
      'utf8',
    );

    const result = runStackProvision([
      adrPath,
      '--run-id=adr-run',
      '--dry-run',
      '--json',
    ]);

    expect(result.contract.input.adr_path).toBe(adrPath);
    expect(result.contract.stack).toEqual(
      expect.arrayContaining(['next.js', 'react', 'tailwind', 'supabase', 'postgres', 'playwright']),
    );
    expect(result.surfaces).toEqual(
      expect.arrayContaining(['backend', 'frontend-engineering']),
    );
  });
});
