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

  it('providerRunning is false for a dead pane and for a shell in the foreground, true for another command, null when unknown', () => {
    const ask = (output: string | Error): boolean | null => {
      vi.mocked(tmuxExec).mockReset();
      if (output instanceof Error) vi.mocked(tmuxExec).mockImplementationOnce(() => { throw output; });
      else vi.mocked(tmuxExec).mockReturnValueOnce(output);
      return panelQuotaTmux.providerRunning(PANE);
    };
    expect(ask('0 node\n')).toBe(true);
    expect(ask('0 claude\n')).toBe(true);
    expect(ask('0 bash\n')).toBe(false);
    expect(ask('0 -zsh\n')).toBe(false);
    expect(ask('0 fish\n')).toBe(false);
    expect(ask('1 node\n')).toBe(false);
    expect(ask('0 \n')).toBeNull();
    expect(ask(new Error("can't find pane"))).toBeNull();
    expect(vi.mocked(tmuxExec).mock.calls[0][0]).toEqual(['display-message', '-t', '%7', '-p', '#{pane_dead} #{pane_current_command}']);
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
