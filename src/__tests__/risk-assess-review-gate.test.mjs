import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assessRisk, classifyChangedFiles, hasHighRiskPath, isNoisePath } from '../../scripts/risk-assess.mjs';

const repoRoot = process.cwd();
const riskScript = join(repoRoot, 'scripts/risk-assess.mjs');
const gateScript = join(repoRoot, 'scripts/review-gate.mjs');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function write(repo, file, contents) {
  const fullPath = join(repo, file);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'risk-assess-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    write(repo, 'README.md', '# fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'initial']);
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('risk-assess false-positive controls', () => {
  it('does not treat high-risk words embedded in docs filenames as critical', () => {
    expect(hasHighRiskPath('docs/authentication-design.md')).toBe(false);
    const result = classifyChangedFiles(['docs/authentication-design.md'], 8);
    expect(result.level).toBe('low');
  });

  it('still treats real source high-risk path segments as critical', () => {
    expect(hasHighRiskPath('src/auth/login.ts')).toBe(true);
    expect(hasHighRiskPath('src/auth.ts')).toBe(true);
    expect(hasHighRiskPath('src/auth-service.ts')).toBe(true);
    expect(hasHighRiskPath('src/authService.ts')).toBe(true);
    expect(hasHighRiskPath('src/token-store.ts')).toBe(true);
    expect(hasHighRiskPath('src/tokenStore.ts')).toBe(true);
    expect(hasHighRiskPath('src/oauth-client.ts')).toBe(true);
    expect(hasHighRiskPath('src/passwordReset.ts')).toBe(true);
    expect(hasHighRiskPath('src/APIAuthClient.ts')).toBe(true);
    expect(hasHighRiskPath('src/JWTTokenStore.ts')).toBe(true);
    const result = classifyChangedFiles(['src/auth/login.ts'], 8);
    expect(result.level).toBe('critical');
  });

  it('ignores .omc harness state and log files for classification', () => {
    expect(isNoisePath('.omc/harness-state/session.json')).toBe(true);
    expect(isNoisePath('runs/output.log')).toBe(true);
    const result = classifyChangedFiles(['.omc/harness-state/session.json', 'runs/output.log'], 500);
    expect(result.level).toBe('none');
    expect(result.relevantFiles).toEqual([]);
  });

  it('ignores large noise diffs when classifying a small code change', () => withRepo((repo) => {
    write(repo, 'src/index.ts', 'export const value = 0;\n');
    write(repo, '.omc/harness-state/session.json', '{}\n');
    git(repo, ['add', 'src/index.ts', '.omc/harness-state/session.json']);
    git(repo, ['commit', '-m', 'fixture files']);

    write(repo, 'src/index.ts', 'export const value = 1;\n');
    write(repo, '.omc/harness-state/session.json', `${'{"event":"noise"}\n'.repeat(250)}`);

    const result = assessRisk({ cwd: repo });

    expect(result.changedFiles).toContain('src/index.ts');
    expect(result.changedFiles).toContain('.omc/harness-state/session.json');
    expect(result.relevantFiles).toEqual(['src/index.ts']);
    expect(result.diffSize).toBeLessThan(20);
    expect(result.level).toBe('low');
  }));


  it('counts staged diff size in default union context', () => withRepo((repo) => {
    write(repo, 'src/large.ts', 'export const line0 = 0;\n');
    git(repo, ['add', 'src/large.ts']);
    git(repo, ['commit', '-m', 'large fixture']);

    write(repo, 'src/large.ts', Array.from({ length: 150 }, (_, index) => `export const line${index} = ${index};`).join('\n') + '\n');
    git(repo, ['add', 'src/large.ts']);

    const result = assessRisk({ cwd: repo });

    expect(result.relevantFiles).toEqual(['src/large.ts']);
    expect(result.diffSize).toBeGreaterThan(100);
    expect(result.level).toBe('high');
  }));

  it('does not ignore real source files under logs directories', () => {
    const result = classifyChangedFiles(['src/auth/logs/session.ts'], 4);
    expect(result.relevantFiles).toEqual(['src/auth/logs/session.ts']);
    expect(result.level).toBe('critical');
  });

  it('treats env files as configuration changes', () => {
    expect(classifyChangedFiles(['.env'], 1).level).toBe('medium');
    expect(classifyChangedFiles(['config/.env.local'], 1).level).toBe('medium');
  });


  it('counts large staged rename edits toward the high-risk size gate', () => withRepo((repo) => {
    write(repo, 'src/old-name.ts', 'export const line0 = 0;\n');
    git(repo, ['add', 'src/old-name.ts']);
    git(repo, ['commit', '-m', 'rename fixture']);

    git(repo, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    write(repo, 'src/new-name.ts', Array.from({ length: 150 }, (_, index) => `export const line${index} = ${index};`).join('\n') + '\n');
    git(repo, ['add', 'src/new-name.ts']);

    const result = assessRisk({ cwd: repo, stagedOnly: true });

    expect(result.changedFiles).toContain('src/old-name.ts');
    expect(result.changedFiles).toContain('src/new-name.ts');
    expect(result.diffSize).toBeGreaterThan(100);
    expect(result.level).toBe('high');
  }));

  it('fails closed when git diff cannot be assessed', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'risk-assess-nongit-'));
    try {
      const risk = spawnSync(process.execPath, [riskScript, '--cwd', nonGitDir], { encoding: 'utf8' });
      expect(risk.status).toBe(2);
      expect(JSON.parse(risk.stdout).level).toBe('unknown');

      const gate = spawnSync(process.execPath, [gateScript, '--cwd', nonGitDir, '--json'], { encoding: 'utf8' });
      expect(gate.status).toBe(2);
      const result = JSON.parse(gate.stdout);
      expect(result.action).toBe('BLOCK');
      expect(result.risk.level).toBe('unknown');
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('uses staged-only input for explicit commit-context review gates', () => withRepo((repo) => {
    write(repo, 'src/auth/login.ts', 'export const risky = false;\n');
    git(repo, ['add', 'src/auth/login.ts']);
    git(repo, ['commit', '-m', 'auth fixture']);

    write(repo, 'src/small.ts', 'export const small = true;\n');
    git(repo, ['add', 'src/small.ts']);
    write(repo, 'src/auth/login.ts', 'export const risky = true;\n');

    const commitContext = spawnSync(process.execPath, [gateScript, '--context', 'commit', '--cwd', repo, '--json'], { encoding: 'utf8' });
    const normalContext = spawnSync(process.execPath, [riskScript, '--cwd', repo], { encoding: 'utf8' });

    expect(commitContext.status).toBe(0);
    const gate = JSON.parse(commitContext.stdout);
    expect(gate.risk.stagedOnly).toBe(true);
    expect(gate.risk.relevantFiles).toEqual(['src/small.ts']);
    expect(gate.risk.level).toBe('low');

    const risk = JSON.parse(normalContext.stdout);
    expect(risk.relevantFiles).toContain('src/auth/login.ts');
    expect(risk.level).toBe('critical');
  }));
});
