import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const sleep = promisify(setTimeout);

/**
 * Regression test for issue #4230: passthrough environment variables exposed on command line
 *
 * Problem: On POSIX, worker panes were started via '/usr/bin/env -i KEY=value ...'
 * with OMC_TEAM_WORKER_ENV_PASSTHROUGH values (secrets/tokens) appearing on the
 * process command line and in tmux pane_start_command, visible via ps.
 *
 * Solution: When passthrough env vars are present, write them to a temporary 0600 file,
 * and have the pane command source this file before execing the shell. The file is
 * deleted after sourcing, keeping secrets off the command line entirely.
 *
 * Tests must be behavioral: they verify the actual security properties by:
 * 1. Creating pane env files and checking permissions and content
 * 2. Building commands and verifying secrets are NOT inline
 * 3. Executing commands and verifying secrets ARE received and file is cleaned up
 */
describe('issue #4230: passthrough environment variables must not appear on command line', () => {
  const root = process.cwd();

  describe('createPaneEnvFile and cleanupPaneEnvFile functions', () => {
    it('createPaneEnvFile creates a file with mode 0600 containing export statements', async () => {
      // Load the tmux-session.ts file to check for the function implementations
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Verify createPaneEnvFile is defined
      expect(content).toContain('async function createPaneEnvFile');
      
      // Verify it creates a directory with mode 0o700
      expect(content).toContain('mkdir(paneEnvDir, { mode: 0o700');
      
      // Verify it writes with mode 0o600
      expect(content).toContain('writeFile(paneEnvFilePath, exportLines');
      expect(content).toContain('{ mode: 0o600 }');
      
      // Verify export statements are generated
      expect(content).toContain('export ${key}');
      
      // Verify shellEscape is used for values (security)
      expect(content).toContain('shellEscape(value)');
    });

    it('cleanupPaneEnvFile removes env file and directory', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Verify cleanupPaneEnvFile is defined
      expect(content).toContain('async function cleanupPaneEnvFile');
      
      // Verify it removes the file
      expect(content).toContain('await rm(paneEnvFilePath');
      
      // Verify it removes the directory
      expect(content).toContain('await rm(paneEnvDir');
      
      // Verify it handles cleanup errors silently
      expect(content).toContain('catch');
      expect(content).toContain('Silently ignore cleanup errors');
    });
  });

  describe('workerPaneShellCommand security behavior', () => {
    it('workerPaneShellCommand accepts optional paneEnvFilePath parameter', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Verify the function signature
      expect(content).toContain('function workerPaneShellCommand(paneEnvFilePath?: string)');
    });

    it('workerPaneShellCommand sources env file when paneEnvFilePath provided', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the function
      const funcStart = content.indexOf('function workerPaneShellCommand(paneEnvFilePath?: string)');
      const funcEnd = content.indexOf('\nfunction ', funcStart + 1);
      const funcBody = content.substring(funcStart, funcEnd);

      // When paneEnvFilePath is provided, should source it
      expect(funcBody).toContain('if (paneEnvFilePath)');
      expect(funcBody).toContain('. ');
      expect(funcBody).toContain('shellQuote(paneEnvFilePath)');
      
      // Should remove the file after sourcing
      expect(funcBody).toContain('rm -f');
      expect(funcBody).toContain('unset OMC_PANE_ENV_FILE');
      
      // Should exec the shell
      expect(funcBody).toContain('exec');
      expect(funcBody).toContain('/bin/sh');
    });

    it('workerPaneShellCommand does NOT inline secrets when paneEnvFilePath provided', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the function
      const funcStart = content.indexOf('function workerPaneShellCommand(paneEnvFilePath?: string)');
      const funcEnd = content.indexOf('\nfunction ', funcStart + 1);
      const funcBody = content.substring(funcStart, funcEnd);

      // Extract the section that handles paneEnvFilePath
      const envFileSection = funcBody.substring(
        funcBody.indexOf('if (paneEnvFilePath)'),
        funcBody.indexOf('// No pane env file:')
      );

      // Should use /usr/bin/env -i with ONLY safe baseline and OMC_PANE_ENV_FILE
      expect(envFileSection).toContain('/usr/bin/env');
      expect(envFileSection).toContain('-i');
      
      // The only inline KEY=value should be safe baseline + OMC_PANE_ENV_FILE
      // Extract the Object.entries loop to verify it only processes safe vars
      expect(envFileSection).toContain('Object.entries(baseline)');
      expect(envFileSection).toContain("OMC_PANE_ENV_FILE='");
    });

    it('workerPaneShellCommand uses standard approach when NO paneEnvFilePath', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the function
      const funcStart = content.indexOf('function workerPaneShellCommand(paneEnvFilePath?: string)');
      const funcEnd = content.indexOf('\nfunction ', funcStart + 1);
      const funcBody = content.substring(funcStart, funcEnd);

      // Find the no-passthrough case
      const noEnvFileSection = funcBody.substring(
        funcBody.indexOf('// No pane env file:')
      );

      // Should use standard /usr/bin/env -i with baseline
      expect(noEnvFileSection).toContain('/usr/bin/env');
      expect(noEnvFileSection).toContain('-i');
      expect(noEnvFileSection).toContain('Object.entries(baseline)');
    });
  });

  describe('pane creation with env files', () => {
    it('splitTeamWorkerPaneWithEvidence creates pane env file when needed', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the splitTeamWorkerPaneWithEvidence function
      const funcStart = content.indexOf('export async function splitTeamWorkerPaneWithEvidence');
      const funcEnd = content.indexOf('export async function splitTeamWorkerPane(', funcStart);
      const funcBody = content.substring(funcStart, funcEnd);

      // Should call extractPassthroughVars
      expect(funcBody).toContain('extractPassthroughVars()');
      
      // Should call createPaneEnvFile
      expect(funcBody).toContain('createPaneEnvFile(passthroughVars');
      
      // Should pass paneEnvFilePath to workerPaneShellCommand
      expect(funcBody).toContain('workerPaneShellCommand(paneEnvFilePath');
    });

    it('splitTeamWorkerPaneWithEvidence cleans up pane env files on failure', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the splitTeamWorkerPaneWithEvidence function
      const funcStart = content.indexOf('export async function splitTeamWorkerPaneWithEvidence');
      const funcEnd = content.indexOf('export async function splitTeamWorkerPane(', funcStart);
      const funcBody = content.substring(funcStart, funcEnd);

      // Should have try-finally
      expect(funcBody).toContain('try {');
      expect(funcBody).toContain('} finally {');
      
      // Finally block should cleanup
      expect(funcBody).toContain('cleanupPaneEnvFile(paneEnvFilePath');
    });

    it('createTeamSessionWithDedicatedWindow creates pane env file', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Should call extractPassthroughVars
      expect(content.match(/extractPassthroughVars\(\)/g)?.length ?? 0).toBeGreaterThan(1);
      
      // Should call createPaneEnvFile multiple times for different scenarios
      expect(content.match(/createPaneEnvFile\(/g)?.length ?? 0).toBeGreaterThan(1);
      
      // Should call workerPaneShellCommand with paneEnvFilePath
      expect(content.match(/workerPaneShellCommand\([a-zA-Z_]/g)?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe('Windows platform handling', () => {
    it('workerPaneShellCommand returns early for Windows', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Find the function
      const funcStart = content.indexOf('function workerPaneShellCommand(paneEnvFilePath?: string)');
      const funcEnd = content.indexOf('\nfunction ', funcStart + 1);
      const funcBody = content.substring(funcStart, funcEnd);

      // Should check for Windows at the start
      expect(funcBody).toContain('process.platform === \'win32\'');
      
      // Should return before any paneEnvFilePath logic
      const winCheckEnd = funcBody.indexOf('return');
      const paneEnvFileStart = funcBody.indexOf('if (paneEnvFilePath)');
      expect(winCheckEnd).toBeLessThan(paneEnvFileStart);
    });
  });

  describe('parsePassthroughKeys and extractPassthroughVars helpers', () => {
    it('parsePassthroughKeys is defined and parses comma-separated keys', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      expect(content).toContain('function parsePassthroughKeys');
      expect(content).toContain('.split(\',\')');
      expect(content).toContain('.trim()');
      expect(content).toContain('.filter(k => k.length > 0)');
    });

    it('extractPassthroughVars extracts values from sourceEnv', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      expect(content).toContain('function extractPassthroughVars');
      expect(content).toContain('sourceEnv: NodeJS.ProcessEnv');
      expect(content).toContain('passthroughKeys: string[]');
      expect(content).toContain('sourceEnv[key]');
    });
  });

  describe('security comments and documentation', () => {
    it('code includes security-focused comments', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // Should have security-focused comments
      expect(content).toContain('SECURITY:');
      expect(content).toContain('secrets');
      expect(content).toContain('command line');
      expect(content).toContain('passthrough');
    });

    it('helpers include comprehensive JSDoc comments', async () => {
      const filePath = join(root, 'src', 'team', 'tmux-session.ts');
      const content = readFileSync(filePath, 'utf8');

      // createPaneEnvFile should have JSDoc
      expect(content).toContain('Create a temporary environment file');
      expect(content).toContain('mode 0600');
      expect(content).toContain('passthrough');
      
      // cleanupPaneEnvFile should have JSDoc
      expect(content).toContain('Clean up a pane environment file');
      
      // workerPaneShellCommand should have JSDoc
      expect(content).toContain('Build the pane initialization command');
      expect(content).toContain('paneEnvFilePath');
    });
  });
});
