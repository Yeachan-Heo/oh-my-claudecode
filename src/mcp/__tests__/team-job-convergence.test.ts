import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('team-job-convergence imports', () => {
  const sourcePath = join(__dirname, '..', 'team-job-convergence.ts');
  const source = readFileSync(sourcePath, 'utf-8');

  it('does not import isProcessAlive (unused)', () => {
    expect(source).not.toContain("import { isProcessAlive }");
  });

  it('exports OmcTeamJob interface', () => {
    expect(source).toContain('export interface OmcTeamJob');
  });

  it('exports clearScopedTeamState function', () => {
    expect(source).toContain('export function clearScopedTeamState');
  });

  it('exports convergeJobWithResultArtifact function', () => {
    expect(source).toContain('export function convergeJobWithResultArtifact');
  });

  it('exports isJobTerminal function', () => {
    expect(source).toContain('export function isJobTerminal');
  });
});
