import { beforeEach, describe, expect, it } from 'vitest';

import { fakeShell, fakeTmux, trace } from './helpers/readiness-trace-tmux.js';

describe('readiness trace tmux mock', () => {
  beforeEach(() => {
    trace.keys = [];
    trace.unknown = [];
  });

  it.each([
    ['send', ['send', '-t', '%2', 'Enter'], ['Enter']],
    ['a send-keys whose text looks like a pane query', ['send-keys', '-t', '%2', '-l', '#{pane_dead}'], ['-l', '#{pane_dead}']],
  ])('records %s as a key send', (_label, args, keys) => {
    fakeTmux('tmuxCmdAsync', args);
    expect(trace.keys.map(key => key.keys)).toEqual([keys]);
    expect(trace.unknown).toEqual([]);
  });

  it.each([
    ["send -t %2 Enter", ['Enter']],
    ["send-keys -t %2 -l '#{pane_dead}'", ['-l', '#{pane_dead}']],
  ])('records the shell command %s as a key send', (command, keys) => {
    fakeShell('tmuxShellAsync', command);
    expect(trace.keys.map(key => key.keys)).toEqual([keys]);
  });

  it('records a send inside a guarded if-shell', () => {
    fakeTmux('tmuxCmdAsync', ['if-shell', 'true', "send -t %2 Enter; display-message -p OMC_TMUX_GUARD_OK_x"]);
    expect(trace.keys.map(key => [key.guarded, key.keys])).toEqual([[true, ['Enter']]]);
  });

  it('answers pane queries without recording keys', () => {
    expect(fakeTmux('tmuxCmdAsync', ['display-message', '-p', '-t', '%2', '#{pane_dead}'])).toBe('0\n');
    expect(trace.keys).toEqual([]);
    expect(trace.unknown).toEqual([]);
  });

  it('keeps any other command as unrecognized', () => {
    fakeTmux('tmuxCmdAsync', ['kill-pane', '-t', '%2', '#{pane_dead}']);
    expect(trace.keys).toEqual([]);
    expect(trace.unknown).toHaveLength(1);
  });
});
