import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { renderAccount } from '../elements/account.js';

const envKeys = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'ANTHROPIC_API_KEY'] as const;

describe('renderAccount', () => {
  let tempDir: string;
  let configDir: string;
  let homeDir: string;
  let originalEnv: Partial<Record<(typeof envKeys)[number], string>>;

  const configFile = () => join(configDir, '.claude.json');
  const fallbackFile = () => join(homeDir, '.claude.json');

  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    tempDir = mkdtempSync(join(tmpdir(), 'omc-account-test-'));
    configDir = join(tempDir, 'config');
    homeDir = join(tempDir, 'home');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    // getOmcConfigDir() places hud-account-cache.json under CLAUDE_CONFIG_DIR/.omc,
    // so each fixture gets an isolated cache without a separate HUD cache override.
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAccount(filePath: string, email: string): void {
    writeFileSync(filePath, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  }

  function renderedText(): string | null {
    const rendered = renderAccount();
    return rendered?.replace(/\x1b\[[0-9;]*m/g, '') ?? null;
  }

  it('renders a valid email from the active Claude config directory', () => {
    writeAccount(configFile(), 'alice@example.com');

    expect(renderedText()).toBe('acct:alice@example.com');
  });

  it('renders nothing when account configuration is absent', () => {
    expect(renderAccount()).toBeNull();
  });

  it('falls back to ~/.claude.json when the active config has no account file', () => {
    writeAccount(fallbackFile(), 'fallback@example.com');

    expect(renderedText()).toBe('acct:fallback@example.com');
  });

  it('renders nothing when ANTHROPIC_API_KEY is set', () => {
    writeAccount(configFile(), 'alice@example.com');
    process.env.ANTHROPIC_API_KEY = 'sk-test-account-key';

    expect(renderAccount()).toBeNull();
  });

  it('renders nothing when oauthAccount is absent', () => {
    writeFileSync(configFile(), JSON.stringify({ userID: 'not-an-account-email' }));

    expect(renderAccount()).toBeNull();
  });

  it('rejects whitespace, ESC, C0/C1 controls, and bidi characters in account emails', () => {
    const invalidEmails = [
      'alice @example.com',
      ' alice@example.com ',
      'alice\t@example.com',
      'alice\x1b@example.com',
      'alice\x00@example.com',
      'alice\x80@example.com',
      'alice\x9f@example.com',
      'alice\u202e@example.com',
      'alice\u2066@example.com',
    ];

    for (const [index, email] of invalidEmails.entries()) {
      writeAccount(configFile(), email);
      const timestamp = Date.now() / 1000 + index + 1;
      utimesSync(configFile(), timestamp, timestamp);
      expect(renderAccount(), `email case ${index}`).toBeNull();
    }
  });

  it('middle-truncates emails longer than 64 characters', () => {
    const email = `${'long.name.'.repeat(8)}@example.com`;
    expect(email.length).toBeGreaterThan(64);
    writeAccount(configFile(), email);

    const rendered = renderedText();
    expect(rendered).toMatch(/^acct:/);
    expect(rendered).toContain('...');
    expect(rendered!.slice('acct:'.length).length).toBeLessThanOrEqual(64);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked .claude.json without following it', () => {
    const target = join(tempDir, 'account-target.json');
    writeAccount(target, 'symlink@example.com');
    symlinkSync(target, configFile());

    expect(renderAccount()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO at .claude.json without hanging', () => {
    writeAccount(configFile(), 'before-fifo@example.com');
    expect(renderedText()).toBe('acct:before-fifo@example.com');

    rmSync(configFile());
    execFileSync('mkfifo', [configFile()]);

    expect(renderAccount()).toBeNull();
  });

  it('renders nothing for a .claude.json larger than 5 MiB', () => {
    const validAccount = JSON.stringify({ oauthAccount: { emailAddress: 'large@example.com' } });
    writeFileSync(configFile(), `${validAccount}${' '.repeat(5 * 1024 * 1024 + 1)}`);

    expect(renderAccount()).toBeNull();
  });

  it('renders nothing for malformed JSON', () => {
    writeFileSync(configFile(), '{malformed json');

    expect(renderAccount()).toBeNull();
  });

  it('refreshes the cached email when the account file changes', () => {
    writeAccount(configFile(), 'first.account@sample.test');
    expect(renderedText()).toBe('acct:first.account@sample.test');
    const before = statSync(configFile());

    writeAccount(configFile(), 'second.account.with.more@example.test');
    const changedMtimeSeconds = before.mtimeMs / 1000 + 5;
    utimesSync(configFile(), changedMtimeSeconds, changedMtimeSeconds);
    const after = statSync(configFile());
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(after.size).not.toBe(before.size);

    expect(renderedText()).toBe('acct:second.account.with.more@example.test');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'renders the active account when the fallback location cannot be inspected',
    () => {
      writeAccount(configFile(), 'active@example.com');
      chmodSync(homeDir, 0o000);
      try {
        expect(renderedText()).toBe('acct:active@example.com');
        expect(renderedText()).toBe('acct:active@example.com');
      } finally {
        chmodSync(homeDir, 0o700);
      }
    },
  );

  it('prefers a newly created active-config account over a cached fallback account', () => {
    writeAccount(fallbackFile(), 'fallback@example.com');
    expect(renderedText()).toBe('acct:fallback@example.com');

    writeAccount(configFile(), 'active@example.com');
    expect(renderedText()).toBe('acct:active@example.com');
  });

  it('shows a fallback account created after the active config was cached as signed out', () => {
    writeFileSync(configFile(), JSON.stringify({ numStartups: 1 }));
    expect(renderedText()).toBeNull();

    writeAccount(fallbackFile(), 'fallback@example.com');
    expect(renderedText()).toBe('acct:fallback@example.com');
  });

  it('shows an account created after a signed-out render', () => {
    expect(renderAccount()).toBeNull();
    writeAccount(configFile(), 'logged-in@example.com');

    expect(renderedText()).toBe('acct:logged-in@example.com');
  });

  it('stops showing an account after its source file is deleted', () => {
    writeAccount(configFile(), 'signed-in@example.com');
    expect(renderedText()).toBe('acct:signed-in@example.com');

    rmSync(configFile());

    expect(renderAccount()).toBeNull();
  });
});
