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
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

describe('omc config-stop-callback --profile', () => {
  it('creates a discord profile and stores it in notificationProfiles', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));

    const result = runCli([
      'config-stop-callback', 'discord',
      '--profile', 'work',
      '--enable',
      '--webhook', 'https://discord.com/api/webhooks/test',
    ], homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Profile "work"');

    const config = readConfig(configPath);
    expect(config.notificationProfiles).toBeDefined();
    expect(config.notificationProfiles.work).toBeDefined();
    expect(config.notificationProfiles.work.enabled).toBe(true);
    expect(config.notificationProfiles.work.discord.enabled).toBe(true);
    expect(config.notificationProfiles.work.discord.webhookUrl).toBe('https://discord.com/api/webhooks/test');
  });

  it('creates a telegram profile', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));

    const result = runCli([
      'config-stop-callback', 'telegram',
      '--profile', 'personal',
      '--enable',
      '--token', '123:abc',
      '--chat', '999',
    ], homeDir);

    expect(result.status).toBe(0);

    const config = readConfig(configPath);
    expect(config.notificationProfiles.personal.telegram.enabled).toBe(true);
    expect(config.notificationProfiles.personal.telegram.botToken).toBe('123:abc');
    expect(config.notificationProfiles.personal.telegram.chatId).toBe('999');
  });

  it('creates a discord-bot profile with --channel-id', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));

    const result = runCli([
      'config-stop-callback', 'discord-bot',
      '--profile', 'ops',
      '--enable',
      '--token', 'bot-token-123',
      '--channel-id', 'channel-456',
    ], homeDir);

    expect(result.status).toBe(0);

    const config = readConfig(configPath);
    expect(config.notificationProfiles.ops['discord-bot'].enabled).toBe(true);
    expect(config.notificationProfiles.ops['discord-bot'].botToken).toBe('bot-token-123');
    expect(config.notificationProfiles.ops['discord-bot'].channelId).toBe('channel-456');
  });

  it('adds multiple platforms to the same profile', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));

    // Add discord first
    runCli([
      'config-stop-callback', 'discord',
      '--profile', 'multi',
      '--enable',
      '--webhook', 'https://discord.com/api/webhooks/multi',
    ], homeDir);

    // Add telegram to same profile
    runCli([
      'config-stop-callback', 'telegram',
      '--profile', 'multi',
      '--enable',
      '--token', '123:tg',
      '--chat', '456',
    ], homeDir);

    const config = readConfig(configPath);
    expect(config.notificationProfiles.multi.discord.enabled).toBe(true);
    expect(config.notificationProfiles.multi.telegram.enabled).toBe(true);
  });

  it('does not affect legacy stopHookCallbacks when using --profile', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      stopHookCallbacks: {
        discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/legacy' },
      },
    }, null, 2));

    runCli([
      'config-stop-callback', 'discord',
      '--profile', 'new',
      '--enable',
      '--webhook', 'https://discord.com/api/webhooks/new',
    ], homeDir);

    const config = readConfig(configPath);
    // Legacy config preserved
    expect(config.stopHookCallbacks.discord.webhookUrl).toBe('https://discord.com/api/webhooks/legacy');
    // New profile created separately
    expect(config.notificationProfiles.new.discord.webhookUrl).toBe('https://discord.com/api/webhooks/new');
  });

  it('shows profile config with --show', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      notificationProfiles: {
        work: {
          enabled: true,
          discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/work' },
        },
      },
    }, null, 2));

    const result = runCli([
      'config-stop-callback', 'discord',
      '--profile', 'work',
      '--show',
    ], homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('webhookUrl');
  });
});

describe('omc config-notify-profile', () => {
  it('lists all profiles', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      notificationProfiles: {
        work: { enabled: true, discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/w' } },
        personal: { enabled: true, telegram: { enabled: true, botToken: 'tk', chatId: 'ch' } },
      },
    }, null, 2));

    const result = runCli(['config-notify-profile', '--list'], homeDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work');
    expect(result.stdout).toContain('personal');
  });

  it('shows a specific profile', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      notificationProfiles: {
        work: { enabled: true, discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/w' } },
      },
    }, null, 2));

    const result = runCli(['config-notify-profile', 'work', '--show'], homeDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('webhookUrl');
  });

  it('deletes a profile', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      notificationProfiles: {
        work: { enabled: true, discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/w' } },
        personal: { enabled: true, telegram: { enabled: true, botToken: 'tk', chatId: 'ch' } },
      },
    }, null, 2));

    const result = runCli(['config-notify-profile', 'work', '--delete'], homeDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deleted');

    const config = readConfig(configPath);
    expect(config.notificationProfiles.work).toBeUndefined();
    expect(config.notificationProfiles.personal).toBeDefined();
  });

  it('shows helpful message when no profiles exist', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-profile-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));

    const result = runCli(['config-notify-profile', '--list'], homeDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No notification profiles');
  });
});
