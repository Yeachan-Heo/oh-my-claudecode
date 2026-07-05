import { execFileSync } from 'child_process';
import { expect } from 'vitest';
import type { LazyCodexCompatHookResult } from '../lazycodex-compat/index.js';

export function expectDecision(
  result: LazyCodexCompatHookResult,
  behavior: string,
  decision: string,
): void {
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({ behavior, decision }),
  );
}

export function expectUltraworkContract(message: string | undefined): void {
  expect(message?.split('\n')[0]).toBe('<ultrawork-mode>');
  expect(message).toContain('TESTS ALONE NEVER PROVE DONE');
  expect(message).toContain('# Manual-QA channels');
  expect(message).toContain('1. HTTP call');
  expect(message).toContain('2. tmux');
  expect(message).toContain('3. Browser use');
  expect(message).toContain('4. Computer use');
  expect(message).toContain('CLEANUP, PAIRED');
  expect(message).toContain('mktemp -t ulw-$(date +%Y%m%d-%H%M%S)');
  expect(message).toContain('Goal + binding success criteria');
  expect(message).toContain('3+ realistic QA scenarios');
  expect(message).toContain('lazycodex-code-reviewer');
  expect(message).toContain('lazycodex-qa-executor');
  expect(message).toContain('lazycodex-gate-reviewer');
  expect(message).toContain('Stop ONLY when every scenario PASSES with captured evidence');
}

export function runLazyCodexCompatCli(eventName: string, input: string): Record<string, unknown> {
  const output = execFileSync('npx', ['tsx', 'src/hooks/lazycodex-compat/cli.ts', eventName], {
    cwd: process.cwd(),
    input,
    encoding: 'utf8',
  });
  return JSON.parse(output) as Record<string, unknown>;
}
