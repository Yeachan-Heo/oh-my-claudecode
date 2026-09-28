import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Test fix for issue #4154: Windows no-tmux fallback should not use shell:true
// with args array, which triggers DEP0190 and breaks with Volta shims.
// Instead, use COMSPEC /d /s /c with properly quoted command line and
// windowsVerbatimArguments: true to prevent libuv re-quoting.

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('issue #4154 - Windows claude invocation fixes', () => {
  it('quoteForCmd should properly escape arguments with spaces and quotes', async () => {
    const { quoteForCmd } = await import('../../src/cli/tmux-utils.js');

    // Test cases for proper argument quoting
    expect(quoteForCmd('claude')).toBe('claude');
    expect(quoteForCmd('--version')).toBe('--version');

    // Arguments with spaces should be quoted
    expect(quoteForCmd('arg with spaces')).toBe('"arg with spaces"');

    // Arguments with quotes should be escaped
    expect(quoteForCmd('arg"with"quotes')).toBe('"arg""with""quotes"');

    // Empty string should be quoted
    expect(quoteForCmd('')).toBe('""');

    // Mixed special characters
    expect(quoteForCmd('C:\\Users\\user\\path')).toBe('C:\\Users\\user\\path');
    expect(quoteForCmd('C:\\Users\\user\\path with spaces')).toBe('"C:\\Users\\user\\path with spaces"');
  });

  it('quoteForCmd should throw on multi-line strings (CR/LF)', async () => {
    const { quoteForCmd } = await import('../../src/cli/tmux-utils.js');

    // Multi-line strings should throw from assertSafeCmdValue
    expect(() => quoteForCmd('line1\nline2')).toThrow();
    expect(() => quoteForCmd('line1\rline2')).toThrow();
  });

  it('runClaudeDirect uses COMSPEC and windowsVerbatimArguments on Windows', async () => {
    const launchPath = fileURLToPath(new URL('../../src/cli/launch.ts', import.meta.url));
    const source = readFileSync(launchPath, 'utf-8');

    // Check for Windows code path in runClaudeDirect
    expect(source).toContain('function runClaudeDirect');

    // Extract just the runClaudeDirect function
    const runClaudeDirectStart = source.indexOf('function runClaudeDirect(');
    const nextFunctionStart = source.indexOf('\nfunction ', runClaudeDirectStart + 1);
    const runClaudeDirectCode = source.slice(
      runClaudeDirectStart,
      nextFunctionStart > 0 ? nextFunctionStart : runClaudeDirectStart + 1500
    );

    // Should use COMSPEC on Windows
    expect(runClaudeDirectCode).toContain('COMSPEC');

    // Should use /d /s /c pattern
    expect(runClaudeDirectCode).toContain("'/d'");
    expect(runClaudeDirectCode).toContain("'/s'");
    expect(runClaudeDirectCode).toContain("'/c'");

    // Should have windowsVerbatimArguments: true
    expect(runClaudeDirectCode).toContain('windowsVerbatimArguments: true');

    // Should NOT have the problematic shell: process.platform === 'win32' pattern
    expect(runClaudeDirectCode).not.toMatch(
      /execFileSync\s*\(\s*['"]claude['"]\s*,\s*args\s*,\s*{[\s\S]*?shell:/
    );
  });

  it('isClaudeAvailable uses COMSPEC and windowsVerbatimArguments on Windows', async () => {
    const tmuxPath = fileURLToPath(new URL('../../src/cli/tmux-utils.ts', import.meta.url));
    const source = readFileSync(tmuxPath, 'utf-8');

    // Find the isClaudeAvailable function
    const isClaudeAvailableStart = source.indexOf('export function isClaudeAvailable(');
    const nextExportStart = source.indexOf('\nexport ', isClaudeAvailableStart + 1);
    const isClaudeAvailableCode = source.slice(
      isClaudeAvailableStart,
      nextExportStart > 0 ? nextExportStart : isClaudeAvailableStart + 1000
    );

    // Should use COMSPEC on Windows
    expect(isClaudeAvailableCode).toContain('COMSPEC');

    // Should use /d /s /c pattern
    expect(isClaudeAvailableCode).toContain("'/d'");
    expect(isClaudeAvailableCode).toContain("'/s'");
    expect(isClaudeAvailableCode).toContain("'/c'");

    // Should have windowsVerbatimArguments: true
    expect(isClaudeAvailableCode).toContain('windowsVerbatimArguments: true');

    // Should NOT have shell: true pattern with args array
    expect(isClaudeAvailableCode).not.toMatch(/execFileSync\s*\(\s*['"]claude['"]\s*,\s*\[\]/);
  });

  it('runAutoresearchSetupSession passes prompt via stdin on Windows (not argv)', async () => {
    const autoresearchPath = fileURLToPath(
      new URL('../../src/cli/autoresearch-setup-session.ts', import.meta.url)
    );
    const source = readFileSync(autoresearchPath, 'utf-8');

    // Check that runAutoresearchSetupSession exists
    expect(source).toContain('export function runAutoresearchSetupSession(');

    // Find the function
    const functionStart = source.indexOf('export function runAutoresearchSetupSession(');
    const functionCode = source.slice(functionStart, functionStart + 2000);

    // On Windows, should use COMSPEC
    expect(functionCode).toContain('COMSPEC');

    // Should pass prompt via input (stdin), not as argument
    expect(functionCode).toContain('input: prompt');

    // Should have windowsVerbatimArguments: true
    expect(functionCode).toContain('windowsVerbatimArguments: true');

    // The command line should only include ['claude', '-p']
    expect(functionCode).toContain("const commandLine = ['claude', '-p']");

    // Should NOT have shell: true pattern
    expect(functionCode).not.toMatch(/shell:\s*process\.platform\s*===\s*['"]win32['"]/);
  });

  it('verifies no problematic shell:true pattern with args in claude launches', async () => {
    const filesToCheck = [
      { path: '../../src/cli/launch.ts', name: 'launch.ts' },
      { path: '../../src/cli/tmux-utils.ts', name: 'tmux-utils.ts' },
      { path: '../../src/cli/autoresearch-setup-session.ts', name: 'autoresearch-setup-session.ts' },
    ];

    for (const file of filesToCheck) {
      const filePath = fileURLToPath(new URL(file.path, import.meta.url));
      const source = readFileSync(filePath, 'utf-8');

      // Check that source does not have the DEP0190-triggering pattern:
      // execFileSync/spawnSync('claude', args/[...], { shell: process.platform === 'win32' })
      const problematicPattern = /(?:execFileSync|spawnSync)\s*\(\s*['"]claude['"]\s*,\s*(?:args|\[[\s\S]*?\])\s*,\s*{[\s\S]*?shell:\s*process\.platform\s*===\s*['"]win32['"]/;
      expect(
        problematicPattern.test(source),
        `${file.name} contains problematic shell:true pattern with args`
      ).toBe(false);
    }
  });

  it('verifies windowsVerbatimArguments in launch.ts runClaudeDirect', async () => {
    const launchPath = fileURLToPath(new URL('../../src/cli/launch.ts', import.meta.url));
    const source = readFileSync(launchPath, 'utf-8');

    const runClaudeDirectStart = source.indexOf('function runClaudeDirect(');
    const nextFunctionStart = source.indexOf('\nfunction ', runClaudeDirectStart + 1);
    const code = source.slice(
      runClaudeDirectStart,
      nextFunctionStart > 0 ? nextFunctionStart : runClaudeDirectStart + 1500
    );

    // Should have windowsVerbatimArguments: true in the execFileSync call
    expect(code).toContain('windowsVerbatimArguments: true');
  });

  it('verifies windowsVerbatimArguments in tmux-utils.ts isClaudeAvailable', async () => {
    const tmuxPath = fileURLToPath(new URL('../../src/cli/tmux-utils.ts', import.meta.url));
    const source = readFileSync(tmuxPath, 'utf-8');

    const isClaudeStart = source.indexOf('export function isClaudeAvailable(');
    const nextExportStart = source.indexOf('\nexport ', isClaudeStart + 1);
    const code = source.slice(
      isClaudeStart,
      nextExportStart > 0 ? nextExportStart : isClaudeStart + 1000
    );

    // Should have windowsVerbatimArguments: true in the execFileSync call
    expect(code).toContain('windowsVerbatimArguments: true');
  });

  it('verifies windowsVerbatimArguments in autoresearch-setup-session.ts', async () => {
    const autoresearchPath = fileURLToPath(
      new URL('../../src/cli/autoresearch-setup-session.ts', import.meta.url)
    );
    const source = readFileSync(autoresearchPath, 'utf-8');

    const functionStart = source.indexOf('export function runAutoresearchSetupSession(');
    const code = source.slice(functionStart, functionStart + 2000);

    // Should have windowsVerbatimArguments: true in the spawnSync call
    expect(code).toContain('windowsVerbatimArguments: true');
  });

  it('verifies autoresearch Windows path uses stdin for multi-line prompt', async () => {
    const autoresearchPath = fileURLToPath(
      new URL('../../src/cli/autoresearch-setup-session.ts', import.meta.url)
    );
    const source = readFileSync(autoresearchPath, 'utf-8');

    // Check that Windows path uses stdin
    expect(source).toContain('On Windows: pass prompt via stdin');
    expect(source).toContain('input: prompt');

    // The command line should only include ['claude', '-p']
    expect(source).toContain("const commandLine = ['claude', '-p'].map(quoteForCmd)");

    // Should NOT pass prompt as part of commandLine on Windows
    const winBranch = source.slice(
      source.indexOf("if (process.platform === 'win32')"),
      source.indexOf('return spawnSync', source.indexOf("if (process.platform === 'win32')")) + 200
    );
    expect(winBranch).toContain('input: prompt');
    expect(winBranch).not.toContain("['claude', '-p', prompt]");
  });
});
