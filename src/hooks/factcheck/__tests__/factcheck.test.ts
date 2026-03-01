/**
 * Factcheck Guard Tests
 *
 * Ported from tests/test_factcheck.py (issue #1155).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { runChecks } from '../index.js';
import type { FactcheckPolicy, FactcheckMode } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultPolicy(): FactcheckPolicy {
  return {
    enabled: true,
    mode: 'quick',
    strict_project_patterns: [],
    forbidden_path_prefixes: [join(homedir(), '.claude/plugins/cache/omc/')],
    forbidden_path_substrings: ['/.omc/', '.omc-config.json'],
    readonly_command_prefixes: [
      'ls ', 'cat ', 'find ', 'grep ', 'head ', 'tail ', 'stat ', 'echo ', 'wc ',
    ],
    warn_on_cwd_mismatch: true,
    enforce_cwd_parity_in_quick: false,
    warn_on_unverified_gates: true,
    warn_on_unverified_gates_when_no_source_files: false,
  };
}

function baseClaims(): Record<string, unknown> {
  return {
    schema_version: '1.0',
    run_id: 'abc123',
    ts: '2026-02-28T20:00:00+00:00',
    cwd: '/tmp/original',
    mode: 'declared',
    files_modified: [],
    files_created: [],
    artifacts_expected: [],
    gates: {
      selftest_ran: false,
      goldens_ran: false,
      sentinel_stop_smoke_ran: false,
      shadow_leak_check_ran: false,
    },
    commands_executed: [],
    models_used: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Factcheck Guard (issue #1155)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'factcheck-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('quick mode ignores cwd mismatch by default', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();

    const result = runChecks(
      claims,
      'quick',
      policy,
      join(tempDir, 'other'),
    );

    // Quick mode skips cwd parity by default, and no source files
    // means unverified gates are ignored → PASS
    expect(result.verdict).toBe('PASS');
    expect(result.mismatches.every(m => m.check !== 'argv_parity')).toBe(true);
  });

  it('strict mode fails on false gates and cwd mismatch', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();

    const result = runChecks(claims, 'strict', policy, tempDir);

    expect(result.verdict).toBe('FAIL');
    const checks = new Set(result.mismatches.map(m => m.check));
    expect(checks.has('B')).toBe(true);
    expect(checks.has('argv_parity')).toBe(true);
  });

  it('declared mode: no gate warn when no source files', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();

    const result = runChecks(claims, 'declared', policy, '/tmp/original');

    expect(result.verdict).toBe('PASS');
    expect(result.notes.join(' ')).toContain('No source files declared');
  });

  it('forbidden prefix is blocking', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    (claims as Record<string, unknown>).files_created = [
      join(homedir(), '.claude/plugins/cache/omc/touched.txt'),
    ];

    const result = runChecks(claims, 'declared', policy, '/tmp/original');

    expect(result.verdict).toBe('FAIL');
    expect(result.mismatches.some(m => m.check === 'H')).toBe(true);
  });

  it('missing required fields produce FAIL', () => {
    const policy = defaultPolicy();
    const claims = { schema_version: '1.0' }; // Missing almost everything

    const result = runChecks(claims, 'quick', policy, tempDir);

    expect(result.verdict).toBe('FAIL');
    expect(result.mismatches.some(m => m.check === 'A')).toBe(true);
  });

  it('all gates true in strict mode with matching cwd passes', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    (claims as Record<string, unknown>).gates = {
      selftest_ran: true,
      goldens_ran: true,
      sentinel_stop_smoke_ran: true,
      shadow_leak_check_ran: true,
    };
    (claims as Record<string, unknown>).cwd = tempDir;

    const result = runChecks(claims, 'strict', policy, tempDir);

    expect(result.verdict).toBe('PASS');
    expect(result.mismatches).toHaveLength(0);
  });

  it('forbidden command in mutating context is FAIL', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    const forbiddenPath = join(homedir(), '.claude/plugins/cache/omc/');
    (claims as Record<string, unknown>).commands_executed = [
      `rm -rf ${forbiddenPath}data`,
    ];

    const result = runChecks(claims, 'quick', policy, tempDir);

    expect(result.verdict).toBe('FAIL');
    expect(result.mismatches.some(
      m => m.check === 'H' && m.detail.includes('Forbidden mutating command'),
    )).toBe(true);
  });

  it('readonly command in forbidden path is allowed', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    const forbiddenPath = join(homedir(), '.claude/plugins/cache/omc/');
    (claims as Record<string, unknown>).commands_executed = [
      `ls ${forbiddenPath}`,
      `cat ${forbiddenPath}file.txt`,
    ];

    const result = runChecks(claims, 'quick', policy, tempDir);

    // Should not have any command-related failures
    expect(result.mismatches.every(
      m => !m.detail.includes('Forbidden mutating command'),
    )).toBe(true);
  });

  it('declared mode warns on false gates when source files exist', () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    // Create a real file so "file not found" doesn't fire
    const srcFile = join(tempDir, 'src.ts');
    writeFileSync(srcFile, 'export const x = 1;');
    (claims as Record<string, unknown>).files_modified = [srcFile];
    (claims as Record<string, unknown>).cwd = '/tmp/original';

    const result = runChecks(claims, 'declared', policy, '/tmp/original');

    expect(result.verdict).toBe('WARN');
    expect(result.mismatches.some(
      m => m.check === 'B' && m.severity === 'WARN',
    )).toBe(true);
  });
});
