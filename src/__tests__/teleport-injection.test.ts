/**
 * Security tests for teleport command: shell injection prevention (issue #850)
 *
 * Verifies that user-controlled values (baseBranch, branchName, worktreePath)
 * are passed as execFileSync argument arrays, never interpolated into shell strings.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('../providers/index.js', () => ({
  parseRemoteUrl: vi.fn(() => ({ owner: 'owner', repo: 'repo', provider: 'github' })),
  getProvider: vi.fn(() => null),
}));

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { teleportCommand, teleportRemoveCommand } from '../cli/commands/teleport.js';

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);

function setupCreateMocks() {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd === 'git rev-parse --show-toplevel') return '/repo/root';
    if (cmd === 'git remote get-url origin') return 'https://github.com/owner/repo.git';
    return '';
  });
  mockExecFileSync.mockReturnValue(Buffer.from(''));
  // parent dir exists, worktree path does not (allow creation)
  mockExistsSync.mockReturnValue(false);
}

function setupRemoveMocks() {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd === 'git status --porcelain') return '';
    if (cmd === 'git rev-parse --git-dir') return '/repo/root/.git/worktrees/test';
    return '';
  });
  mockExecFileSync.mockReturnValue(Buffer.from(''));
  mockExistsSync.mockReturnValue(true);
}

describe('teleport: shell injection prevention (issue #850)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createWorktree: execFileSync used for user-controlled values', () => {
    test('git fetch uses execFileSync with baseBranch as a separate array element', async () => {
      setupCreateMocks();
      const maliciousBase = 'main; touch /tmp/pwned';

      await teleportCommand('my-feature', { base: maliciousBase, json: true });

      const fetchCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'fetch'
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toEqual(['fetch', 'origin', maliciousBase]);
    });

    test('git branch uses execFileSync with branchName and baseBranch as separate elements', async () => {
      setupCreateMocks();
      const maliciousBase = 'main && evil';

      await teleportCommand('my-feature', { base: maliciousBase, json: true });

      const branchCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'branch'
      );
      expect(branchCall).toBeDefined();
      expect(branchCall![1][0]).toBe('branch');
      expect(branchCall![1][1]).toBe('feat/my-feature');
      expect(branchCall![1][2]).toBe(`origin/${maliciousBase}`);
    });

    test('git worktree add uses execFileSync with worktreePath and branchName as separate elements', async () => {
      setupCreateMocks();

      await teleportCommand('my-feature', { base: 'main', json: true });

      const worktreeAddCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'worktree' && call[1][1] === 'add'
      );
      expect(worktreeAddCall).toBeDefined();
      expect(worktreeAddCall![1][0]).toBe('worktree');
      expect(worktreeAddCall![1][1]).toBe('add');
      // Path and branch are separate arguments (no shell quoting or interpolation)
      expect(worktreeAddCall![1]).toHaveLength(4);
    });

    test('execSync is never called with baseBranch interpolated into a shell string', async () => {
      setupCreateMocks();
      const payload = 'main; rm -rf /';

      await teleportCommand('test-feature', { base: payload, json: true });

      const dangerous = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && (call[0] as string).includes(payload)
      );
      expect(dangerous).toBeUndefined();
    });

    test.each([
      ['semicolon injection', 'main; touch /tmp/pwned'],
      ['command substitution $(...)', 'main$(evil)'],
      ['backtick substitution', 'main`evil`'],
      ['pipe injection', 'main | cat /etc/passwd'],
      ['ampersand injection', 'main && evil'],
      ['newline injection', 'main\ntouch /tmp/pwned'],
    ])('shell metacharacters in baseBranch are not executed: %s', async (_desc, payload) => {
      setupCreateMocks();

      await teleportCommand('feature-x', { base: payload, json: true });

      // execSync must never be called with the payload in its command string
      const shellInjected = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && (call[0] as string).includes(payload)
      );
      expect(shellInjected).toBeUndefined();

      // execFileSync must have been called with the payload as a literal array element
      const safeCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && (call[1] as string[]).some(arg => arg.includes(payload))
      );
      expect(safeCall).toBeDefined();
    });
  });

  describe('teleportRemoveCommand: execFileSync used for worktreePath', () => {
    test('git worktree remove uses execFileSync with worktreePath as a separate array element', async () => {
      setupRemoveMocks();

      await teleportRemoveCommand('feat/my-feature', { json: true });

      const removeCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'worktree' && call[1][1] === 'remove'
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1][0]).toBe('worktree');
      expect(removeCall![1][1]).toBe('remove');
      // worktreePath is a separate element, not embedded in a shell string
      expect(typeof removeCall![1][2]).toBe('string');
    });

    test('--force flag is passed as a separate array element when force=true', async () => {
      setupRemoveMocks();

      await teleportRemoveCommand('feat/my-feature', { force: true, json: true });

      const removeCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'worktree' && call[1][1] === 'remove'
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1]).toContain('--force');
    });

    test('--force flag is absent when force=false', async () => {
      setupRemoveMocks();

      await teleportRemoveCommand('feat/my-feature', { json: true });

      const removeCall = mockExecFileSync.mock.calls.find(
        call => Array.isArray(call[1]) && call[1][0] === 'worktree' && call[1][1] === 'remove'
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1]).not.toContain('--force');
    });

    test('execSync is never called with worktreePath interpolated into a shell string', async () => {
      setupRemoveMocks();
      const maliciousPath = 'feat/x"; rm -rf /; echo "';

      // Override existsSync so this specific path is treated as existing
      mockExistsSync.mockReturnValue(true);

      await teleportRemoveCommand(maliciousPath, { json: true });

      const dangerous = mockExecSync.mock.calls.find(
        call => typeof call[0] === 'string' && (call[0] as string).includes(maliciousPath)
      );
      expect(dangerous).toBeUndefined();
    });
  });
});
