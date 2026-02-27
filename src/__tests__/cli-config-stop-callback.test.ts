import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], homeDir: string): CliRunResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
    },
    encoding: 'utf-8',
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readConfig(configPath: string) {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as {
    silentAutoUpdate: boolean;
    defaultExecutionMode?: string;
    taskTool?: string;
    stopHookCallbacks?: {
      telegram?: {
        enabled: boolean;
        botToken?: string;
        chatId?: string;
        tagList?: string[];
      };
      discord?: {
        enabled: boolean;
        webhookUrl?: string;
        tagList?: string[];
      };
      slack?: {
        enabled: boolean;
        webhookUrl?: string;
        tagList?: string[];
      };
      file?: {
        enabled: boolean;
        path: string;
        format?: 'markdown' | 'json';
      };
    };
  };
}

describe('omc config-stop-callback tag options', () => {
  it('updates telegram tagList options and preserves existing config fields', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-stop-callback-home-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      taskTool: 'task',
      stopHookCallbacks: {
        telegram: {
          enabled: true,
          botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxyz012345678',
          chatId: '12345',
          tagList: ['@old'],
        },
      },
    }, null, 2));

    const replace = runCli(['config-stop-callback', 'telegram', '--tag-list', '@alice,bob'], homeDir);
    expect(replace.status).toBe(0);

    let config = readConfig(configPath);
    expect(config.taskTool).toBe('task');
    expect(config.stopHookCallbacks?.telegram?.tagList).toEqual(['@alice', 'bob']);

    const add = runCli(['config-stop-callback', 'telegram', '--add-tag', 'charlie'], homeDir);
    expect(add.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.telegram?.tagList).toEqual(['@alice', 'bob', 'charlie']);

    const remove = runCli(['config-stop-callback', 'telegram', '--remove-tag', 'bob'], homeDir);
    expect(remove.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.telegram?.tagList).toEqual(['@alice', 'charlie']);

    const show = runCli(['config-stop-callback', 'telegram', '--show'], homeDir);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('"tagList": [');
    expect(show.stdout).toContain('"@alice"');
  }, 60000);

  it('applies and clears discord tags and ignores tag options for file callback', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-stop-callback-home-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
          tagList: ['@here'],
        },
        file: {
          enabled: true,
          path: '/tmp/session.md',
          format: 'markdown',
        },
      },
    }, null, 2));

    const add = runCli(['config-stop-callback', 'discord', '--add-tag', 'role:123'], homeDir);
    expect(add.status).toBe(0);

    let config = readConfig(configPath);
    expect(config.stopHookCallbacks?.discord?.tagList).toEqual(['@here', 'role:123']);

    const clear = runCli(['config-stop-callback', 'discord', '--clear-tags'], homeDir);
    expect(clear.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.discord?.tagList).toEqual([]);

    const file = runCli(['config-stop-callback', 'file', '--tag-list', '@ignored'], homeDir);
    expect(file.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.file).toEqual({
      enabled: true,
      path: '/tmp/session.md',
      format: 'markdown',
    });
  }, 60000);

  it('configures slack stop-callback with webhook and tags', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-stop-callback-home-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      stopHookCallbacks: {},
    }, null, 2));

    // Enable slack with webhook and tags
    const enable = runCli(['config-stop-callback', 'slack', '--enable', '--webhook', 'https://hooks.slack.com/services/T00/B00/xxx', '--tag-list', '<!here>,<@U1234567890>'], homeDir);
    expect(enable.status).toBe(0);

    let config = readConfig(configPath);
    expect(config.stopHookCallbacks?.slack?.enabled).toBe(true);
    expect(config.stopHookCallbacks?.slack?.webhookUrl).toBe('https://hooks.slack.com/services/T00/B00/xxx');
    expect(config.stopHookCallbacks?.slack?.tagList).toEqual(['<!here>', '<@U1234567890>']);

    // Add a tag
    const add = runCli(['config-stop-callback', 'slack', '--add-tag', '<!channel>'], homeDir);
    expect(add.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.slack?.tagList).toEqual(['<!here>', '<@U1234567890>', '<!channel>']);

    // Remove a tag
    const remove = runCli(['config-stop-callback', 'slack', '--remove-tag', '<!here>'], homeDir);
    expect(remove.status).toBe(0);

    config = readConfig(configPath);
    expect(config.stopHookCallbacks?.slack?.tagList).toEqual(['<@U1234567890>', '<!channel>']);

    // Show config
    const show = runCli(['config-stop-callback', 'slack', '--show'], homeDir);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('"webhookUrl"');
    expect(show.stdout).toContain('"tagList"');
  }, 60000);
});
