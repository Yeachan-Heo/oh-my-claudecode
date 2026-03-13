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
    stopHookCallbacks?: {
      file?: {
        enabled: boolean;
        path: string;
        format?: 'markdown' | 'json';
      };
    };
  };
}

describe('omc config-stop-callback', () => {
  it('configures file callback and ignores unsupported types', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-stop-callback-home-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      stopHookCallbacks: {},
    }, null, 2));

    // Enable file callback
    const enable = runCli(['config-stop-callback', 'file', '--enable', '--path', '/tmp/session.md'], homeDir);
    expect(enable.status).toBe(0);

    const config = readConfig(configPath);
    expect(config.stopHookCallbacks?.file?.enabled).toBe(true);
    expect(config.stopHookCallbacks?.file?.path).toBe('/tmp/session.md');

    // Show config
    const show = runCli(['config-stop-callback', 'file', '--show'], homeDir);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('"path"');

    // Disable
    const disable = runCli(['config-stop-callback', 'file', '--disable'], homeDir);
    expect(disable.status).toBe(0);

    const updated = readConfig(configPath);
    expect(updated.stopHookCallbacks?.file?.enabled).toBe(false);
  });

  it('rejects unsupported callback types', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-stop-callback-home-'));
    const configPath = join(homeDir, '.claude', '.omc-config.json');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      silentAutoUpdate: false,
      stopHookCallbacks: {},
    }, null, 2));

    // Telegram should be rejected
    const telegram = runCli(['config-stop-callback', 'telegram', '--enable'], homeDir);
    expect(telegram.status).not.toBe(0);

    // Discord should be rejected
    const discord = runCli(['config-stop-callback', 'discord', '--enable'], homeDir);
    expect(discord.status).not.toBe(0);
  });
});
