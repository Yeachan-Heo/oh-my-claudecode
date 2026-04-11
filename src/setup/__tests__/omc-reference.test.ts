import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installOmcReferenceSkill } from '../omc-reference.js';

describe('installOmcReferenceSkill', () => {
  let workDir: string;
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'omc-reference-skill-'));
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  const makeSkillSource = (root: string, content = '# omc-reference skill\n'): string => {
    const sourceDir = join(root, 'skills', 'omc-reference');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, content);
    return sourcePath;
  };

  it('copies SKILL.md from the canonical source on a fresh install', () => {
    const pluginRoot = join(workDir, 'plugin');
    const sourcePath = makeSkillSource(pluginRoot, '# canonical content\n');
    const targetPath = join(workDir, 'target', 'skills', 'omc-reference', 'SKILL.md');

    const result = installOmcReferenceSkill(targetPath, pluginRoot);

    expect(result.installed).toBe(true);
    expect(result.sourceLabel).toBe(sourcePath);
    expect(result.reason).toBeUndefined();
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf-8')).toBe('# canonical content\n');
  });

  it('returns a skip result when the canonical source is unavailable', () => {
    const targetPath = join(workDir, 'target', 'SKILL.md');

    const result = installOmcReferenceSkill(targetPath, join(workDir, 'nonexistent'));

    expect(result.installed).toBe(false);
    expect(result.sourceLabel).toBeNull();
    expect(result.reason).toBe('canonical source unavailable');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('returns a skip result when the canonical source is an empty file', () => {
    const pluginRoot = join(workDir, 'plugin');
    const sourcePath = makeSkillSource(pluginRoot, '');
    const targetPath = join(workDir, 'target', 'SKILL.md');

    const result = installOmcReferenceSkill(targetPath, pluginRoot);

    expect(result.installed).toBe(false);
    expect(result.sourceLabel).toBe(sourcePath);
    expect(result.reason).toBe('empty canonical source');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('uses CLAUDE_PLUGIN_ROOT as a fallback when the primary source is missing', () => {
    const envRoot = join(workDir, 'env-plugin');
    const envSource = makeSkillSource(envRoot, '# env fallback\n');
    process.env.CLAUDE_PLUGIN_ROOT = envRoot;
    const targetPath = join(workDir, 'target', 'SKILL.md');

    const result = installOmcReferenceSkill(
      targetPath,
      join(workDir, 'missing-primary'),
    );

    expect(result.installed).toBe(true);
    expect(result.sourceLabel).toBe(envSource);
    expect(readFileSync(targetPath, 'utf-8')).toBe('# env fallback\n');
  });

  it('creates the target parent directory if it does not exist', () => {
    const pluginRoot = join(workDir, 'plugin');
    makeSkillSource(pluginRoot, '# content\n');
    const targetPath = join(workDir, 'deep', 'nested', 'target', 'SKILL.md');

    expect(existsSync(join(workDir, 'deep'))).toBe(false);
    const result = installOmcReferenceSkill(targetPath, pluginRoot);

    expect(result.installed).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
  });

  it('is idempotent across re-runs', () => {
    const pluginRoot = join(workDir, 'plugin');
    makeSkillSource(pluginRoot, '# content\n');
    const targetPath = join(workDir, 'target', 'SKILL.md');

    const first = installOmcReferenceSkill(targetPath, pluginRoot);
    const second = installOmcReferenceSkill(targetPath, pluginRoot);

    expect(first.installed).toBe(true);
    expect(second.installed).toBe(true);
    expect(first.sourceLabel).toBe(second.sourceLabel);
    expect(readFileSync(targetPath, 'utf-8')).toBe('# content\n');
  });
});
