import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { wikiAddTool, wikiReadTool } from '../wiki-tools.js';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

describe('wiki tools workingDirectory', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalOmcStateDir = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-tools-wd-'));
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearWorktreeCache();
    if (originalOmcStateDir === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = originalOmcStateDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes and reads wiki pages in the provided linked worktree instead of process cwd', async () => {
    const primary = join(tempDir, 'primary');
    const linked = join(tempDir, 'linked');
    mkdirSync(primary, { recursive: true });

    git(primary, 'init');
    git(primary, 'config user.email "test@example.com"');
    git(primary, 'config user.name "Test User"');
    writeFileSync(join(primary, 'README.md'), 'primary\n');
    git(primary, 'add README.md');
    git(primary, 'commit -m initial');
    git(primary, `worktree add -b linked-wiki ${linked}`);

    process.chdir(primary);
    clearWorktreeCache();

    const addResult = await wikiAddTool.handler({
      title: 'Linked Worktree Page',
      content: 'This belongs to the linked worktree wiki.',
      tags: ['regression'],
      workingDirectory: linked,
    });

    expect(addResult.isError).toBeUndefined();
    expect(existsSync(join(linked, '.omc', 'wiki', 'linked-worktree-page.md'))).toBe(true);
    expect(existsSync(join(primary, '.omc', 'wiki'))).toBe(false);

    const readResult = await wikiReadTool.handler({
      page: 'linked-worktree-page',
      workingDirectory: linked,
    });

    expect(readResult.isError).toBeUndefined();
    expect(readResult.content[0].text).toContain('Linked Worktree Page');
    expect(readResult.content[0].text).toContain('This belongs to the linked worktree wiki.');
    expect(existsSync(join(primary, '.omc', 'wiki'))).toBe(false);
  });
});
