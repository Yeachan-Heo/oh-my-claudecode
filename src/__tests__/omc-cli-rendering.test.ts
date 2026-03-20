import { describe, expect, it } from 'vitest';
import {
  formatOmcCliInvocation,
  resolveOmcCliPrefix,
  rewriteOmcCliInvocations,
} from '../utils/omc-cli-rendering.js';

describe('omc CLI rendering', () => {
  it('uses omc when the binary is available', () => {
    expect(resolveOmcCliPrefix({ omcAvailable: true, env: {} as NodeJS.ProcessEnv })).toBe('omc');
    expect(formatOmcCliInvocation('team api claim-task', { omcAvailable: true, env: {} as NodeJS.ProcessEnv }))
      .toBe('omc team api claim-task');
  });

  it('falls back to the plugin bridge when omc is unavailable but CLAUDE_PLUGIN_ROOT is set', () => {
    const env = { CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root' } as NodeJS.ProcessEnv;
    expect(resolveOmcCliPrefix({ omcAvailable: false, env }))
      .toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');
    expect(formatOmcCliInvocation('autoresearch --mission "m"', { omcAvailable: false, env }))
      .toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "m"');
  });

  it('rewrites inline and list-form omc commands for plugin installs', () => {
    const env = { CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root' } as NodeJS.ProcessEnv;
    const input = [
      'Run `omc autoresearch --mission "m" --eval "e"`.',
      '- omc team api claim-task --input \'{}\' --json',
      '> omc ask codex --agent-prompt critic "check"',
    ].join('\n');

    const output = rewriteOmcCliInvocations(input, { omcAvailable: false, env });

    expect(output).toContain('`node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "m" --eval "e"`');
    expect(output).toContain('- node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs team api claim-task --input \'{}\' --json');
    expect(output).toContain('> node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask codex --agent-prompt critic "check"');
  });

  it('leaves text unchanged when omc remains the selected prefix', () => {
    const input = 'Use `omc team status demo` and\nomc team wait demo';
    expect(rewriteOmcCliInvocations(input, { omcAvailable: true, env: {} as NodeJS.ProcessEnv })).toBe(input);
  });
});
