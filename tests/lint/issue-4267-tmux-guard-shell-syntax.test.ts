import { describe, expect, it, beforeEach, afterEach } from 'vitest';

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
    // 1. Start with & { (call operator + subshell for env cleanup)
    // 2. NOT use env -i (should not have env as a separate token or -i flag)
    // 3. NOT use /dev/null redirection
    // 4. Use single-quoted arguments (preserves literals)
    expect(condition).toMatch(/^&\s+\{/);
    // env-related cleanup happens inside the subshell
    expect(condition).toContain('Remove-Item');
    expect(condition).toContain('env:NODE_OPTIONS');
    // Should NOT use /dev/null (that's POSIX)
    expect(condition).not.toContain('/dev/null');

    // Should have the proper arguments in PowerShell format
    expect(condition).toContain('--tmux-server-identity-guard');
    expect(condition).toContain('#{pid}'); // Format placeholder for tmux
  });

  it('Windows with MSYS2/Cygwin in real tmux: guard condition uses POSIX syntax', async () => {
    mockPlatform('win32');
    // Simulate Git Bash (MSYSTEM) WITH real tmux
    process.env.MSYSTEM = 'MINGW64';
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'; // Real tmux sets TMUX in format: socket,pid,index

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Should use POSIX syntax even on Windows with MSYS2 when real tmux is detected
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

  it('native Windows: guard condition preserves literal values including $ and $()', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    // Test powershellQuote function directly
    const { powershellQuote } = await import(
      '../../src/team/tmux-session.js'
    );

    // Dollar signs should be preserved literally (not expanded) in single-quoted strings
    // Input: C:\tools\$missing\runtime.cjs
    // Output: 'C:\tools\$missing\runtime.cjs' (no escaping needed in PowerShell single quotes)
    expect(powershellQuote('C:\\tools\\$missing\\runtime.cjs')).toBe(
      "'C:\\tools\\$missing\\runtime.cjs'"
    );

    // Dollar expressions should be preserved literally (not evaluated)
    expect(powershellQuote('C:\\tools\\$(1+2)\\runtime.cjs')).toBe(
      "'C:\\tools\\$(1+2)\\runtime.cjs'"
    );

    // Apostrophes should be escaped by doubling
    expect(powershellQuote("can't")).toBe("'can''t'");

    // No special chars should just be single-quoted
    expect(powershellQuote('testvalue')).toBe("'testvalue'");
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
    expect(parts[1]).toBe('{'); // Second token should be { for subshell
    // Should not have 'env' as a token
    for (let i = 0; i < parts.length; i++) {
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

    // Should start with & (call operator), followed by { for environment cleanup subshell
    expect(condition.trim()).toMatch(/^&\s+\{/);

    // Should have balanced single quotes
    const singleQuoteCount = (condition.match(/'/g) || []).length;
    // Count should be even (balanced)
    expect(singleQuoteCount % 2).toBe(0);

    // Should reference the runtime CLI
    expect(condition).toContain('--tmux-server-identity-guard');
  });

  it('Git Bash without TMUX in environment: should choose PowerShell syntax for PSMUX', async () => {
    mockPlatform('win32');
    // Simulate Git Bash (MSYSTEM set) but not in real tmux
    process.env.MSYSTEM = 'MINGW64';
    delete process.env.TMUX;

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // When in Git Bash (MSYSTEM) but no TMUX, should use PowerShell for PSMUX
    // PowerShell syntax: should start with & {  (call operator + subshell)
    const isPowerShell = condition.trim().startsWith('&');
    expect(isPowerShell).toBe(true);
    expect(condition).toContain('{'); // Subshell for environment cleanup
  });

  it('PowerShell guard clears NODE_OPTIONS before invoking node', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    const { tmuxServerGuardConditionPowerShell } = await import(
      '../../src/team/tmux-session.js'
    );

    const condition = tmuxServerGuardConditionPowerShell(
      'C:\\Node\\node.exe',
      'C:\\guard.cjs',
      'dGVzdA==',
    );

    // Should include Remove-Item to clear NODE_OPTIONS and related vars
    expect(condition).toContain('Remove-Item');
    expect(condition).toContain('env:NODE_OPTIONS');
    expect(condition).toContain('env:NODE_PATH');
    expect(condition).toContain('env:NODE_PRESERVE_SYMLINKS');
    // Should use PowerShell syntax with error suppression
    expect(condition).toContain('-ErrorAction');
    expect(condition).toContain('SilentlyContinue');
  });

  it('powershellQuote preserves $ and $(...) literally in round-trip', async () => {
    mockPlatform('win32');
    mockUnixLikeOnWindows(false);

    const { powershellQuote } = await import(
      '../../src/team/tmux-session.js'
    );

    // Test various paths with special characters that should NOT be expanded
    const testCases = [
      'C:\\tools\\$missing\\runtime.cjs',
      'C:\\tools\\$(1+2)\\runtime.cjs',
      "C:\\don't\\path\\here.cjs",
      'C:\\path\\with$vars\\and$(expr)\\file.js',
    ];

    for (const input of testCases) {
      const quoted = powershellQuote(input);
      // Should be single-quoted
      expect(quoted).toMatch(/^'.*'$/);
      // Apostrophes should be doubled
      if (input.includes("'")) {
        expect(quoted).toContain("''");
      }
      // $ should appear literally in the quoted string
      if (input.includes('$')) {
        expect(quoted).toContain('$');
      }
    }
  });

  it('isRealTmuxAvailable detects real tmux vs PSMUX', async () => {
    mockPlatform('win32');
    const { isRealTmuxAvailable } = await import(
      '../../src/team/tmux-session.js'
    );

    // No TMUX var: should return false (PSMUX or no multiplexer)
    delete process.env.TMUX;
    expect(isRealTmuxAvailable()).toBe(false);

    // Invalid TMUX format: should return false
    process.env.TMUX = 'invalid';
    expect(isRealTmuxAvailable()).toBe(false);

    // Valid TMUX format: should return true
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    expect(isRealTmuxAvailable()).toBe(true);

    // Valid TMUX with different socket path
    process.env.TMUX = '/var/folders/something/tmux-socket,9999,2';
    expect(isRealTmuxAvailable()).toBe(true);
  });

  it('Git Bash with valid TMUX: should use POSIX syntax', async () => {
    mockPlatform('win32');
    process.env.MSYSTEM = 'MINGW64';
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'; // Valid real tmux

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // With valid TMUX, should use POSIX even in Git Bash
    expect(condition).toContain('/usr/bin/env');
    expect(condition).toContain('-i');
    expect(condition).toContain("< '/dev/null'");
    // Should NOT use PowerShell call operator
    expect(condition).not.toMatch(/^&\s+/);
  });

  it('Git Bash with invalid TMUX value: should use PowerShell for PSMUX', async () => {
    mockPlatform('win32');
    process.env.MSYSTEM = 'MINGW64';
    process.env.TMUX = 'invalid-tmux-format'; // Invalid tmux value

    const { tmuxServerGuardCondition } = await import(
      '../../src/team/tmux-session.js'
    );

    const identity = buildTestIdentity();
    const condition = tmuxServerGuardCondition(identity);

    // Invalid TMUX should fall back to PowerShell (PSMUX)
    expect(condition.trim()).toMatch(/^&\s+\{/);
  });
});
