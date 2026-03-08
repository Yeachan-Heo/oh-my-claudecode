import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { loadAgentPrompt } from '../agents/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

function getSnippetByMarker(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) return '';
  // A bounded snippet is enough for ordering assertions.
  return source.slice(start, start + 1400);
}

describe('package dir resolution regression (#1322, #1324)', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('src/agents/utils.ts checks __dirname before import.meta.url', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'agents', 'utils.ts'), 'utf-8');
    const snippet = getSnippetByMarker(source, 'function getPackageDir(): string {');

    expect(snippet).toContain("typeof __dirname !== 'undefined'");
    expect(snippet).toContain("currentDirName === 'bridge'");
    expect(snippet).toContain('fileURLToPath(import.meta.url)');
    expect(snippet.indexOf("typeof __dirname !== 'undefined'")).toBeLessThan(
      snippet.indexOf('fileURLToPath(import.meta.url)'),
    );
  });

  it('src/agents/prompt-helpers.ts checks __dirname before import.meta.url', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'agents', 'prompt-helpers.ts'), 'utf-8');
    const snippet = getSnippetByMarker(source, 'function getPackageDir(): string {');

    expect(snippet).toContain("typeof __dirname !== 'undefined'");
    expect(snippet).toContain("currentDirName === 'bridge'");
    expect(snippet).toContain('fileURLToPath(import.meta.url)');
    expect(snippet.indexOf("typeof __dirname !== 'undefined'")).toBeLessThan(
      snippet.indexOf('fileURLToPath(import.meta.url)'),
    );
  });

  it('bridge/runtime-cli.cjs keeps __dirname branch ahead of fileURLToPath(import_meta.url)', () => {
    const source = readFileSync(join(REPO_ROOT, 'bridge', 'runtime-cli.cjs'), 'utf-8');
    const snippet = getSnippetByMarker(source, 'function getPackageDir() {');

    expect(snippet).toContain('typeof __dirname !== "undefined"');
    expect(snippet).toContain('currentDirName === "bridge"');
    expect(snippet).toContain('fileURLToPath)(import_meta.url)');
    expect(snippet.indexOf('typeof __dirname !== "undefined"')).toBeLessThan(
      snippet.indexOf('fileURLToPath)(import_meta.url)'),
    );
  });

  it('loadAgentPrompt resolves prompts even when cwd is unrelated', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'omc-agents-path-resolution-'));
    process.chdir(sandboxDir);

    const prompt = loadAgentPrompt('architect');
    expect(prompt).not.toContain('Prompt unavailable');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('getValidAgentRoles resolves agents directory even when cwd is unrelated', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'omc-agent-roles-path-resolution-'));
    process.chdir(sandboxDir);

    const { getValidAgentRoles } = await import('../agents/prompt-helpers.js');
    const roles = getValidAgentRoles();

    expect(roles).toContain('architect');
    expect(roles).toContain('executor');
    expect(roles).toContain('planner');
  });
});
