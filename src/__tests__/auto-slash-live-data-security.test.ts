import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

vi.mock('../lib/worktree-paths.js', () => ({
  getWorktreeRoot: () => null,
  getOmcRoot: () => `${process.cwd()}/.omc`,
}));

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedExecFileSync = vi.mocked(childProcess.execFileSync);
const originalCwd = process.cwd();
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let projectDir: string;
let configDir: string;

describe('auto slash live-data security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    projectDir = join(tmpdir(), `omc-live-data-project-${process.pid}-${Date.now()}`);
    configDir = join(tmpdir(), `omc-live-data-config-${process.pid}-${Date.now()}`);
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n!git status $ARGUMENTS\n',
    );
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_commands: ['git'] }),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('blocks shell syntax introduced through $ARGUMENTS', async () => {
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '; node -e "process.exit(99)"',
      raw: '/live-test ; node -e "process.exit(99)"',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked:');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
