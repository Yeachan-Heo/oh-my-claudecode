/**
 * Tests for the `omc ask` provider backend overrides
 * (scripts/lib/provider-overrides.mjs).
 *
 * These overrides let a single provider axis be repointed at a drop-in CLI via
 * `OMC_ASK_<PROVIDER>_BIN` / `OMC_ASK_<PROVIDER>_ARGS` — e.g. routing the Gemini
 * axis through Antigravity's `agy` after `@google/gemini-cli` access moved tiers.
 * Default (env-unset) behavior must remain unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  PROMPT_PLACEHOLDER,
  resolveProviderBinary,
  resolveProviderArgsOverride,
  // @ts-expect-error - plain ESM helper module, no type declarations
} from '../../scripts/lib/provider-overrides.mjs';

describe('resolveProviderBinary', () => {
  it('returns the default binary when no override is set', () => {
    expect(resolveProviderBinary('gemini', 'gemini', {})).toBe('gemini');
  });

  it('returns the override binary from OMC_ASK_<PROVIDER>_BIN', () => {
    const env = { OMC_ASK_GEMINI_BIN: 'agy' };
    expect(resolveProviderBinary('gemini', 'gemini', env)).toBe('agy');
  });

  it('trims surrounding whitespace in the override', () => {
    const env = { OMC_ASK_GEMINI_BIN: '  agy  ' };
    expect(resolveProviderBinary('gemini', 'gemini', env)).toBe('agy');
  });

  it('ignores a blank override and falls back to the default', () => {
    const env = { OMC_ASK_GEMINI_BIN: '   ' };
    expect(resolveProviderBinary('gemini', 'gemini', env)).toBe('gemini');
  });

  it('is scoped per provider (does not leak across providers)', () => {
    const env = { OMC_ASK_GEMINI_BIN: 'agy' };
    expect(resolveProviderBinary('codex', 'codex', env)).toBe('codex');
  });
});

describe('resolveProviderArgsOverride', () => {
  it('returns null when no override is set', () => {
    expect(resolveProviderArgsOverride('gemini', 'hi', {})).toBeNull();
  });

  it('returns null for a blank override', () => {
    expect(resolveProviderArgsOverride('gemini', 'hi', { OMC_ASK_GEMINI_ARGS: '   ' })).toBeNull();
  });

  it('substitutes {{prompt}} as a standalone arg and flags placeholder use', () => {
    const env = {
      OMC_ASK_GEMINI_ARGS: JSON.stringify(['--print', PROMPT_PLACEHOLDER, '--dangerously-skip-permissions']),
    };
    const result = resolveProviderArgsOverride('gemini', 'review this PR', env);
    expect(result).toEqual({
      args: ['--print', 'review this PR', '--dangerously-skip-permissions'],
      usesPromptPlaceholder: true,
    });
  });

  it('substitutes {{prompt}} embedded inside an arg', () => {
    const env = { OMC_ASK_GEMINI_ARGS: JSON.stringify(['--prompt={{prompt}}']) };
    const result = resolveProviderArgsOverride('gemini', 'hello', env);
    expect(result?.args).toEqual(['--prompt=hello']);
    expect(result?.usesPromptPlaceholder).toBe(true);
  });

  it('reports usesPromptPlaceholder=false when the prompt is not embedded (stdin path)', () => {
    const env = { OMC_ASK_GEMINI_ARGS: JSON.stringify(['--print', '--dangerously-skip-permissions']) };
    const result = resolveProviderArgsOverride('gemini', 'hello', env);
    expect(result).toEqual({
      args: ['--print', '--dangerously-skip-permissions'],
      usesPromptPlaceholder: false,
    });
  });

  it('preserves prompts that contain spaces and newlines as a single arg', () => {
    const env = { OMC_ASK_GEMINI_ARGS: JSON.stringify(['--print', PROMPT_PLACEHOLDER]) };
    const prompt = 'line one\nline two with spaces';
    const result = resolveProviderArgsOverride('gemini', prompt, env);
    expect(result?.args).toEqual(['--print', 'line one\nline two with spaces']);
  });

  it('throws a helpful error on invalid JSON', () => {
    const env = { OMC_ASK_GEMINI_ARGS: 'not json' };
    expect(() => resolveProviderArgsOverride('gemini', 'hi', env))
      .toThrow(/OMC_ASK_GEMINI_ARGS must be a JSON array of strings/);
  });

  it('throws when the JSON is not an array', () => {
    const env = { OMC_ASK_GEMINI_ARGS: JSON.stringify({ not: 'an array' }) };
    expect(() => resolveProviderArgsOverride('gemini', 'hi', env))
      .toThrow(/must be a JSON array of strings/);
  });

  it('throws when array elements are not all strings', () => {
    const env = { OMC_ASK_GEMINI_ARGS: JSON.stringify(['--print', 42]) };
    expect(() => resolveProviderArgsOverride('gemini', 'hi', env))
      .toThrow(/must be a JSON array of strings/);
  });

  it('builds the full Antigravity (agy) gemini-axis command end to end', () => {
    const env = {
      OMC_ASK_GEMINI_BIN: 'agy',
      OMC_ASK_GEMINI_ARGS: JSON.stringify(['--print', PROMPT_PLACEHOLDER, '--dangerously-skip-permissions']),
    };
    const binary = resolveProviderBinary('gemini', 'gemini', env);
    const override = resolveProviderArgsOverride('gemini', 'summarize the diff', env);
    expect(binary).toBe('agy');
    expect([binary, ...(override?.args ?? [])]).toEqual([
      'agy',
      '--print',
      'summarize the diff',
      '--dangerously-skip-permissions',
    ]);
  });
});
