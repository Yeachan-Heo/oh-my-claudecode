/**
 * Tests for the tmux adapter of the panel quota wait (panelQuotaTmux in tmux-detector.ts).
 * tmux is replaced by the mocked tmux-utils wrappers; no tmux server is started.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { panelQuotaTmux } from '../../features/rate-limit-wait/tmux-detector.js';
import type { TmuxPane } from '../../features/rate-limit-wait/types.js';

vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return { ...actual, tmuxExec: vi.fn(), tmuxSpawn: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { tmuxExec, tmuxSpawn } from '../../cli/tmux-utils.js';

const PANE = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 } as TmuxPane;

describe('panelQuotaTmux adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmuxSpawn).mockReturnValue({ status: 0 } as never);
  });

  it('listPanes maps the tmux pane list to pane points', () => {
    vi.mocked(tmuxExec).mockReturnValueOnce('omc-team-a:0.1 %7 1 team title\n');
    const panes = panelQuotaTmux.listPanes();
    expect(panes).toEqual([expect.objectContaining({ id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 })]);
  });

  it('listPanes returns null, not an empty list, when the inventory cannot be read', () => {
    vi.mocked(tmuxExec).mockImplementationOnce(() => { throw new Error('no server running'); });
    expect(panelQuotaTmux.listPanes()).toBeNull();
    vi.mocked(tmuxSpawn).mockReturnValue({ status: 1 } as never);
    expect(panelQuotaTmux.listPanes()).toBeNull();
  });

  it('providerRunning is false for a dead pane, true for a foreground command that is not a shell, null when unknown', () => {
    const ask = (output: string | Error): boolean | null => {
      vi.mocked(tmuxExec).mockReset();
      vi.mocked(execFileSync).mockReset();
      if (output instanceof Error) vi.mocked(tmuxExec).mockImplementationOnce(() => { throw output; });
      else vi.mocked(tmuxExec).mockReturnValueOnce(output);
      return panelQuotaTmux.providerRunning(PANE);
    };
    expect(ask('0 4242 node\n')).toBe(true);
    expect(ask('0 4242 claude\n')).toBe(true);
    expect(ask('1 4242 node\n')).toBe(false);
    expect(ask('1 4242 bash\n')).toBe(false);
    expect(ask('0 4242 \n')).toBeNull();
    expect(ask(new Error("can't find pane"))).toBeNull();
    expect(vi.mocked(execFileSync), 'ps is asked only when a shell is in the foreground').not.toHaveBeenCalled();
    vi.mocked(tmuxExec).mockReset();
    vi.mocked(tmuxExec).mockReturnValueOnce('0 4242 node\n');
    panelQuotaTmux.providerRunning(PANE);
    expect(vi.mocked(tmuxExec).mock.calls[0][0]).toEqual(['display-message', '-t', '%7', '-p', '#{pane_dead} #{pane_pid} #{pane_current_command}']);
  });

  it('providerRunning with a shell as the pane command: the shell at its own prompt means the provider exited, a wrapper script in the foreground means it runs', () => {
    const ask = (command: string, ps: string | Error): boolean | null => {
      vi.mocked(tmuxExec).mockReset();
      vi.mocked(execFileSync).mockReset();
      vi.mocked(tmuxExec).mockReturnValueOnce(`0 4242 ${command}\n`);
      if (ps instanceof Error) vi.mocked(execFileSync).mockImplementationOnce(() => { throw ps; });
      else vi.mocked(execFileSync).mockReturnValueOnce(ps);
      return panelQuotaTmux.providerRunning(PANE);
    };
    // pgid and tpgid of the shell: equal at its prompt, different while another job holds the terminal.
    expect(ask('bash', ' 4242  4242\n'), 'the shell at its prompt').toBe(false);
    expect(ask('-zsh', ' 4242  4242\n'), 'a login shell at its prompt').toBe(false);
    expect(ask('bash', ' 4242  5151\n'), 'a wrapper script that runs the provider').toBe(true);
    expect(ask('bash', ' 4242    -1\n'), 'no controlling terminal').toBeNull();
    expect(ask('bash', 'garbage\n')).toBeNull();
    expect(ask('bash', new Error('ps: not found'))).toBeNull();
    expect(vi.mocked(execFileSync).mock.calls[0][0]).toBe('ps');
    expect(vi.mocked(execFileSync).mock.calls[0][1]).toEqual(['-o', 'pgid=,tpgid=', '-p', '4242']);
  });

  it('capture returns the pane screen read with capture-pane', () => {
    vi.mocked(tmuxExec).mockReturnValueOnce('working...\nAPI Error: 429 {"error":{"code":1308}}\n');
    const screen = panelQuotaTmux.capture(PANE, 15);
    expect(screen).toContain('"code":1308');
    expect(vi.mocked(tmuxExec).mock.calls[0][0]).toEqual(expect.arrayContaining(['capture-pane', '-t', '%7']));
  });

  it('sendContinue sends the text and then Enter to the same pane', () => {
    vi.mocked(tmuxExec).mockReturnValue('');
    expect(panelQuotaTmux.sendContinue(PANE)).toBe(true);
    const calls = vi.mocked(tmuxExec).mock.calls.map((call) => call[0]);
    expect(calls).toContainEqual(['send-keys', '-t', '%7', '-l', 'continue']);
    expect(calls).toContainEqual(['send-keys', '-t', '%7', 'Enter']);
  });
});
