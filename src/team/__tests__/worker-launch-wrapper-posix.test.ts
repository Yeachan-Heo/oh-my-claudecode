/**
 * Regression suite for issue #3931 — POSIX worker launch wrapper content.
 *
 * buildWorkerLaunchWrapper() previously unconditionally emitted a Windows
 * .cmd batch script (CRLF, @echo off, %~dp0, %ERRORLEVEL%) on all platforms,
 * breaking worker launches on macOS/Linux. This suite pins the platform-aware
 * contract: Windows wrapper stays as batch, POSIX wrapper is a valid sh script.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerLaunchWrapper, quotePosixShellArgument, quoteWindowsCreateProcessArgument } from '../worker-launch-ack.js';
import type { WorkerLaunchAttempt } from '../worker-launch-ack.js';

function makeAttempt(overrides: Partial<WorkerLaunchAttempt> = {}): WorkerLaunchAttempt {
  return {
    schema_version: 1,
    attempt_id: '11111111-1111-4111-8111-111111111111',
    nonce: '22222222-2222-4222-8222-222222222222',
    team_name: 'team',
    worker_name: 'worker-1',
    pane_id: '%1',
    provider: 'codex',
    created_at: '2026-01-01T00:00:00.000Z',
    currentPath: '/tmp/current.json',
    expectedPath: '/tmp/expected.json',
    ackPath: '/tmp/ack.json',
    decisionPath: '/tmp/decision.json',
    startedPath: '/tmp/started.json',
    transportOwnerPath: '/tmp/transport-owner.json',
    bootstrapDescriptorPath: '/tmp/bootstrap.json',
    wrapperPath: '/tmp/launch.cmd',
    transportCleanupCompletePath: '/tmp/cleanup.json',
    runtimeCliPath: '/opt/omc/runtime-cli.cjs',
    ...overrides,
  };
}

describe('buildWorkerLaunchWrapper platform contract (issue #3931)', () => {
  describe('Windows wrapper (platform=win32)', () => {
    it('emits CRLF batch script with Windows tokens', () => {
      const wrapper = buildWorkerLaunchWrapper(makeAttempt(), 'win32');
      expect(wrapper).toContain('@echo off');
      expect(wrapper).toContain('setlocal DisableDelayedExpansion');
      expect(wrapper).toContain('OMC_WORKER_LAUNCH_SPEC_FILE=%~dp0bootstrap.json');
      expect(wrapper).toContain('--worker-launch');
      expect(wrapper).toContain('%ERRORLEVEL%');
      expect(wrapper).toContain('del /f /q "%~f0"');
      expect(wrapper).toContain('endlocal & exit /b %_OMC_WORKER_LAUNCH_EXIT%');
      expect(wrapper).toContain('\r\n');
      expect(wrapper).not.toContain('#!/bin/sh');
      expect(wrapper).not.toContain('omc_wrapper_dir');
      expect(wrapper).not.toContain("rm -f");
    });

    it('preserves Windows quoting for paths with spaces and percent', () => {
      const wrapper = buildWorkerLaunchWrapper(
        makeAttempt({ runtimeCliPath: 'C:\\Program Files\\omc\\runtime-cli.cjs' }),
        'win32',
      );
      // Windows quoting uses doubled percent and doubled quotes inside double-quotes
      expect(wrapper).toContain('"C:\\Program Files\\omc\\runtime-cli.cjs"');
      expect(wrapper).toContain('\r\n');
    });

    it('does not emit POSIX shebang', () => {
      const wrapper = buildWorkerLaunchWrapper(makeAttempt(), 'win32');
      expect(wrapper.startsWith('#!')).toBe(false);
    });
  });

  describe('POSIX wrapper (platform=linux/darwin)', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      it(`emits LF sh script with POSIX bootstrap derivation on ${platform}`, () => {
        const wrapper = buildWorkerLaunchWrapper(makeAttempt(), platform);
        expect(wrapper).toContain('#!/bin/sh');
        expect(wrapper).toContain('set -u');
        expect(wrapper).toContain('omc_wrapper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)');
        expect(wrapper).toContain('export OMC_WORKER_LAUNCH_SPEC_FILE="$omc_wrapper_dir/bootstrap.json"');
        expect(wrapper).toContain('--worker-launch');
        expect(wrapper).toContain('_omc_exit=$?');
        expect(wrapper).toContain('rm -f -- "$0"');
        expect(wrapper).toContain('exit $_omc_exit');
        expect(wrapper).not.toContain('@echo off');
        expect(wrapper).not.toContain('%~dp0');
        expect(wrapper).not.toContain('%ERRORLEVEL%');
        expect(wrapper).not.toContain('del /f /q');
        expect(wrapper).not.toContain('endlocal');
        // LF only, no CRLF
        expect(wrapper).not.toContain('\r\n');
        expect(wrapper).toContain('\n');
        // Valid sh syntax
        const dir = mkdtempSync(join(tmpdir(), 'wrapper-syntax-'));
        const path = join(dir, 'test.sh');
        try {
          writeFileSync(path, wrapper, 'utf8');
          const result = spawnSync('sh', ['-n', path], { encoding: 'utf8' });
          expect(result.status).toBe(0);
          expect(result.stderr).toBe('');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('single-quote-escapes runtimeCliPath with spaces', () => {
      const wrapper = buildWorkerLaunchWrapper(
        makeAttempt({ runtimeCliPath: '/opt/my project/runtime-cli.cjs' }),
        'linux',
      );
      expect(wrapper).toContain("'/opt/my project/runtime-cli.cjs'");
      expect(wrapper).not.toContain('/opt/my project/runtime-cli.cjs --worker-launch');
    });

    it('escapes single quotes via close-open pattern', () => {
      const wrapper = buildWorkerLaunchWrapper(
        makeAttempt({ runtimeCliPath: "/opt/omc/runtime's/cli.cjs" }),
        'linux',
      );
      // '/opt/omc/runtime'"'"'/cli.cjs' is the standard single-quote escape: close ', add escaped ', reopen '
      expect(wrapper).toContain(`'"'"'`);
      // Verify round-trip via shell for the produced quoting
      const quoted = quotePosixShellArgument("/opt/omc/runtime's/cli.cjs");
      const result = spawnSync('sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
      expect(result.stdout).toBe("/opt/omc/runtime's/cli.cjs");
    });

    it('keeps shell metacharacters inert (no injection)', () => {
      const malicious = '/tmp/test; rm -rf /; echo/cli.cjs';
      const wrapper = buildWorkerLaunchWrapper(makeAttempt({ runtimeCliPath: malicious }), 'linux');
      expect(wrapper).toContain(`'${malicious}'`);
      // Metachars inside single quotes are inert; sh -n validates
      const dir = mkdtempSync(join(tmpdir(), 'wrapper-inject-'));
      const path = join(dir, 'test.sh');
      try {
        writeFileSync(path, wrapper, 'utf8');
        const result = spawnSync('sh', ['-n', path], { encoding: 'utf8' });
        expect(result.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects CRLF/CR/NUL in runtimeCliPath', () => {
      expect(() => buildWorkerLaunchWrapper(makeAttempt({ runtimeCliPath: '/tmp/a\r\nb/c.cjs' }), 'linux'))
        .toThrow('worker_launch_provider_argv_invalid');
      expect(() => buildWorkerLaunchWrapper(makeAttempt({ runtimeCliPath: '/tmp/a\0b/c.cjs' }), 'linux'))
        .toThrow('worker_launch_provider_argv_invalid');
    });

    it('executes correctly: bootstrap derivation, exit propagation, self-delete', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wrapper-exec-'));
      const runtimeCliPath = join(dir, 'runtime-cli.cjs');
      // Place wrapper alongside bootstrap
      const wrapperDir = join(dir, 'attempt');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(wrapperDir, { recursive: true });
      const bootstrapPath = join(wrapperDir, 'bootstrap.json');
      writeFileSync(bootstrapPath, '{}', 'utf8');
      // Minimal runtime that checks env and exits with specific code
      writeFileSync(runtimeCliPath, `if (process.env.OMC_WORKER_LAUNCH_SPEC_FILE !== "${bootstrapPath}") process.exit(99); process.exit(42);`, 'utf8');

      const attempt = makeAttempt({ runtimeCliPath });
      const wrapper = buildWorkerLaunchWrapper(attempt, 'linux');
      const wrapperPath = join(wrapperDir, 'launch.cmd');
      writeFileSync(wrapperPath, wrapper, 'utf8');
      chmodSync(wrapperPath, 0o700);

      const result = spawnSync(wrapperPath, [], { encoding: 'utf8' });
      expect(result.status).toBe(42);
      expect(result.stderr).toBe('');
      // Self-delete
      expect(result.status).toBe(42);
      // Wrapper should have deleted itself
      const { existsSync } = await import('node:fs');
      expect(existsSync(wrapperPath)).toBe(false);

      rmSync(dir, { recursive: true, force: true });
    });

    it('handles bootstrap path with spaces via symlink-safe derivation', () => {
      const wrapper = buildWorkerLaunchWrapper(
        makeAttempt({ runtimeCliPath: '/opt/omc/runtime-cli.cjs' }),
        'linux',
      );
      // Uses dirname $0 + pwd, not %~dp0, handles spaces via quoted "$0"
      expect(wrapper).toContain('dirname -- "$0"');
      expect(wrapper).toContain('CDPATH=');
    });
  });

  describe('quotePosixShellArgument', () => {
    it('single-quote wraps and escapes internal single quotes', () => {
      expect(quotePosixShellArgument("a'b")).toBe(`'a'"'"'b'`);
      expect(quotePosixShellArgument("a")).toBe(`'a'`);
      expect(quotePosixShellArgument(" ")).toBe(`' '`);
      expect(quotePosixShellArgument("a b c")).toBe(`'a b c'`);
    });

    it('keeps metachars inert inside single quotes', () => {
      for (const value of ['$(whoami)', '`whoami`', 'a; b', 'a|b', 'a&b', '$HOME', '!bang']) {
        const quoted = quotePosixShellArgument(value);
        const result = spawnSync('sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
        expect(result.stdout).toBe(value);
      }
    });

    it('rejects CRLF/NUL', () => {
      expect(() => quotePosixShellArgument('a\r\nb')).toThrow('worker_launch_provider_argv_invalid');
      expect(() => quotePosixShellArgument('a\0b')).toThrow('worker_launch_provider_argv_invalid');
    });
  });
});
