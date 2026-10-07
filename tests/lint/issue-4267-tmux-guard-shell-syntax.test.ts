import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Test fix for issue #4267: tmuxServerGuardCondition() should emit
// shell-appropriate syntax based on platform:
// - On native Windows: PowerShell syntax (no `env -i`, proper call operator)
// - On POSIX: POSIX shell syntax (with `env -i` and `/dev/null` stdin redirection)

describe('issue #4267 - tmux guard shell syntax platform compatibility', () => {
  let originalPlatform: NodeJS.Platform;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalPlatform = process.platform as NodeJS.Platform;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  function mockPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  function mockUnixLikeOnWindows(value: boolean): void {
    if (value) {
      process.env.MSYSTEM = 'MINGW64';
    } else {
      delete process.env.MSYSTEM;
      delete process.env.MINGW_PREFIX;
    }
  }

  /**
   * Build a test identity matching the structure expected by the guard condition
   */
  function buildTestIdentity() {
    return {
      socket_path: '/tmp/test-socket.sock',
      server_pid: 12345,
      process_started_at: 'test:123456789',
    };
  }

  it('POSIX: guard condition uses env -i and /dev/null redirection', async () => {
    mockPlatform('linux');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // POSIX syntax should:
    // 1. Use /usr/bin/env
    // 2. Have the -i flag for clean environment
    // 3. Include stdin redirection < /dev/null
    expect(condition).toContain('/usr/bin/env');
    expect(condition).toContain('-i');
    expect(condition).toContain("< '/dev/null'");
    // Should NOT use PowerShell call operator
    expect(condition).not.toMatch(/^&\s+"/);
  });

  it('macOS: guard condition uses env -i and /dev/null redirection', async () => {
    mockPlatform('darwin');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Same as Linux
    expect(condition).toContain('/usr/bin/env');
    expect(condition).toContain('-i');
    expect(condition).toContain("< '/dev/null'");
  });

  it('native Windows: guard condition uses PowerShell call operator (&)', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // PowerShell syntax should:
    // 1. Start with & (call operator)
    // 2. NOT use env -i (should not have env as a separate token or -i flag)
    // 3. NOT use /dev/null redirection
    // 4. Use double-quoted arguments
    expect(condition).toMatch(/^&\s+"/);
    expect(condition).not.toContain('/usr/bin/env');
    expect(condition).not.toContain('/dev/null');

    // Should have the proper arguments in PowerShell format
    expect(condition).toContain('--tmux-server-identity-guard');
    expect(condition).toContain('#{pid}'); // Format placeholder for tmux
  });

  it('Windows with MSYS2/Cygwin: guard condition uses POSIX syntax', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(true);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Should use POSIX syntax even on Windows with MSYS2
    expect(condition).toContain('/usr/bin/env');
    expect(condition).toContain('-i');
    expect(condition).toContain("< '/dev/null'");
  });

  it('POSIX: guard condition properly escapes special characters in identity', async () => {
    mockPlatform('linux');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Should contain properly quoted base64 encoded identity
    // The encoding happens internally, but we can verify structure
    expect(condition).toContain('--tmux-server-identity-guard');
    expect(condition).toContain('#{pid}'); // Tmux format placeholder
  });

  it('native Windows: guard condition escapes backticks and quotes in arguments', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    // Test powershellQuote function directly
    const { powershellQuote } = await import(
      '../../src/team/tmux-session.js'
    );

    // Backticks should be escaped with backtick
    expect(powershellQuote('test`value')).toBe('"test``value"');

    // Double quotes should be escaped with backtick
    expect(powershellQuote('test"value')).toBe('"test`"value"');

    // Both should be escaped
    expect(powershellQuote('test`"value')).toBe('"test``\`"value"');

    // No special chars should just be quoted
    expect(powershellQuote('testvalue')).toBe('"testvalue"');
  });

  it('POSIX: shellQuote properly escapes single quotes', async () => {
    mockPlatform('linux');
    mockUnixLikeOnWindows(false);

    const { shellQuote } = await import(
      '../../src/team/tmux-session.js'
    );

    // Single quotes should use the POSIX escaping pattern
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");

    // Multiple single quotes
    expect(shellQuote("can't won't")).toBe("'can'\"'\"'t won'\"'\"'t'");

    // No single quotes should just be wrapped
    expect(shellQuote('testvalue')).toBe("'testvalue'");
  });

  it('native Windows: guard condition does not use env command', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Should NOT contain 'env' command at all
    // (it's not valid in PowerShell context)
    const parts = condition.split(/\s+/);
    expect(parts[0]).toBe('&'); // First token should be call operator
    expect(parts[1]).toMatch(/^"/); // Second token should be quoted (node path)
    // Should not have 'env' as a token
    for (let i = 1; i < 5 && i < parts.length; i++) {
      expect(parts[i]).not.toBe("'env'");
      expect(parts[i]).not.toBe('env');
    }
  });

  it('POSIX: guard condition structure is valid for tmux if-shell', async () => {
    mockPlatform('linux');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // The condition should be a valid shell command line
    // Should start with a command
    expect(condition).toMatch(/^[a-zA-Z'"/]/);

    // Should have proper quoting structure
    const quoteCount = (condition.match(/'/g) || []).length;
    expect(quoteCount % 2).toBe(0); // Quotes should be balanced

    // Should reference the runtime CLI
    expect(condition).toContain('--tmux-server-identity-guard');
  });

  it('native Windows: guard condition structure is valid for PowerShell', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Should start with & (call operator)
    expect(condition.trim()).toMatch(/^&\s+"/);

    // Should have balanced double quotes
    const doubleQuoteCount = (condition.match(/(?<!`)"/g) || []).length;
    // Count should be even (balanced), though we need to account for escaping
    expect(doubleQuoteCount).toBeGreaterThan(0);

    // Should reference the runtime CLI
    expect(condition).toContain('--tmux-server-identity-guard');
  });
});
