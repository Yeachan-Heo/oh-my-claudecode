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

  it('allows safe arguments on an explicitly authored live-data directive', async () => {
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '--short',
      raw: '/live-test --short',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).not.toContain('error="true"');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['status', '--short'],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    ['line feed', '\n!git status'],
    ['carriage return', '\r!git status'],
  ])('blocks a live-data directive introduced through $ARGUMENTS with %s', async (_name, args) => {
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args,
      raw: `/live-test ${args}`,
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: control character rejected');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks a script block introduced through $ARGUMENTS', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_commands: ['git', 'bash'] }),
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const args = '\n!begin-script bash\nnode -e "process.exit(99)"\n!end-script';
    const result = executeSlashCommand({
      command: 'live-test',
      args,
      raw: `/live-test ${args}`,
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: control character rejected');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks $ARGUMENTS interpolation inside an authored script block', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n!begin-script bash\ngit status $ARGUMENTS\n!end-script\n',
    );
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_commands: ['bash', 'git'] }),
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '; node -e "process.exit(99)"',
      raw: '/live-test ; node -e "process.exit(99)"',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain(
      'blocked: arguments are not supported in live-data script blocks',
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks $ARGUMENTS interpolation in an authored script shell declaration', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n!begin-script $ARGUMENTS\necho safe\n!end-script\n',
    );
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_commands: ['bash'] }),
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: 'bash',
      raw: '/live-test bash',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain(
      'blocked: arguments are not supported in live-data script blocks',
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks a live-data directive introduced into a placeholder-only template', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n$ARGUMENTS\n',
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '\n!git status',
      raw: '/live-test \n!git status',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: control character rejected');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks a live-data directive after slash-command parsing normalizes the newline', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n$ARGUMENTS\n',
    );
    const { detectSlashCommand } = await import('../hooks/auto-slash-command/detector.js');
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');
    const parsed = detectSlashCommand('/live-test\n!git status');

    expect(parsed).not.toBeNull();
    expect(parsed?.args).toBe('!git status');

    const result = executeSlashCommand(parsed!);

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: live-data directive introduced by arguments');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks promotion of an authored directive into a script block', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n!$ARGUMENTS\necho safe\n!end-script\n',
    );
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_patterns: ['^bash'] }),
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: 'begin-script bash;node',
      raw: '/live-test begin-script bash;node',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: live-data directive introduced by arguments');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('keeps a placeholder that renders inside a code fence as plain text', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n```text\n$ARGUMENTS\n```\n',
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '!git status',
      raw: '/live-test !git status',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('!git status');
    expect(result.replacementText).not.toContain('error="true"');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks arguments that close a code fence and expose a live-data directive', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n```text\n$ARGUMENTS\n!git status\n```\n',
    );
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '```',
      raw: '/live-test ```',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked: live-data directive introduced by arguments');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
