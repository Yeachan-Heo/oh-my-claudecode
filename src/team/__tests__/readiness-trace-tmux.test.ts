import { beforeEach, describe, expect, it } from 'vitest';

import { readFileSync } from 'fs';
import { join } from 'path';

import { fakeShell, fakeTmux, trace, tmuxUtilsOverrides } from './helpers/readiness-trace-tmux.js';

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

  it.each([
    ['a query chained to a send', ['capture-pane', '-p', '-t', '%2', ';', 'send-keys', '-t', '%2', 'Enter']],
    ['a query whose last argument ends the command', ['capture-pane', '-p', '-t', '%2;', 'send-keys', '-t', '%2', 'Enter']],
  ])('keeps %s as unrecognized', (_label, args) => {
    fakeTmux('tmuxCmdAsync', args);
    expect(trace.keys).toEqual([]);
    expect(trace.unknown).toHaveLength(1);
  });

  it('keeps a guarded command with anything after the marker as unrecognized', () => {
    fakeTmux('tmuxCmdAsync', ['if-shell', 'true', "send -t %2 Enter; display-message -p 'OMC_TMUX_GUARD_OK_x'; send -t %2 Escape"]);
    expect(trace.keys).toEqual([]);
    expect(trace.unknown).toHaveLength(1);
  });

  it('records a send made through tmuxSpawn', () => {
    const result = tmuxUtilsOverrides().tmuxSpawn(['send-keys', '-t', '%2', '-l', 'R5_PROBE']);
    expect(result.status).toBe(0);
    expect(trace.keys.map(key => [key.fn, key.keys])).toEqual([['tmuxSpawn', ['-l', 'R5_PROBE']]]);
  });

  it('overrides every tmux-utils function that starts tmux', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'cli', 'tmux-utils.ts'), 'utf8');
    const starters = [...source.matchAll(/^export (?:async )?function (tmux(?:Exec|Shell|Cmd|Spawn)\w*)\(/gm)].map(match => match[1]);
    expect(starters.length).toBeGreaterThan(0);
    expect(Object.keys(tmuxUtilsOverrides()).sort()).toEqual([...starters].sort());
  });

  it('keeps any other command as unrecognized', () => {
    fakeTmux('tmuxCmdAsync', ['kill-pane', '-t', '%2', '#{pane_dead}']);
    expect(trace.keys).toEqual([]);
    expect(trace.unknown).toHaveLength(1);
  });
});
