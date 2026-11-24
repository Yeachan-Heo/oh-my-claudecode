import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFencedPaneTree, revivePaneTree, serializePaneTree } from '../pane-tree-read.js';
import type { PaneProcessTree, WorkerPaneOwnership } from '../tmux-session.js';

const IDENTITY = { socket_path: '/tmp/pane-tree-read-test.sock', server_pid: 4242, process_started_at: 'start' };
const TREE: PaneProcessTree = {
  panePid: 4000,
  pids: [4001, 4002],
  startIdentities: new Map<number, string | null>([[4001, 'start-4001'], [4002, null]]),
};

function ownership(overrides: Partial<WorkerPaneOwnership> = {}): WorkerPaneOwnership {
  return {
    provider: 'tmux', providerTarget: 'team:0', paneId: '%2', splitTarget: '%1', leaderPaneId: '%1', reservedPaneIds: [],
    source: 'adopted', tmuxServerIdentity: IDENTITY, ...overrides,
  } as WorkerPaneOwnership;
}

afterEach(() => { delete process.env.OMC_TEAM_KILL_PANE_TREE; });

describe('the pane tree persisted with a launch retirement', () => {
  it('survives the round trip through JSON: the descendants and the identity of each', () => {
    expect(revivePaneTree(JSON.parse(JSON.stringify(serializePaneTree(TREE))))).toEqual(TREE);
  });

  it.each([
    ['nothing', undefined],
    ['text', 'tree'],
    ['a root that is not a process', { panePid: 1, pids: [4001], startIdentities: [[4001, 'a']] }],
    ['a descendant that is not a process', { panePid: 4000, pids: [4001, 0], startIdentities: [[4001, 'a']] }],
    ['an identity that is neither text nor null', { panePid: 4000, pids: [4001], startIdentities: [[4001, 7]] }],
    ['an identity entry of another shape', { panePid: 4000, pids: [4001], startIdentities: [[4001]] }],
    ['identities that are no list', { panePid: 4000, pids: [4001], startIdentities: { 4001: 'a' } }],
  ])('a value that is not such a tree (%s) is not revived, so it is never signalled', (_what, value) => {
    expect(revivePaneTree(value)).toBeNull();
  });

  it('uses the capture an interrupted run persisted as it is, and reads nothing now (the provider is gone)', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => null) };
    const read = await readFencedPaneTree(ownership(), ops, JSON.parse(JSON.stringify(serializePaneTree(TREE))));
    expect(read.tree).toEqual(TREE);
    expect(read.record).toBeUndefined(); // already persisted
    expect(ops.verifyTeamTargetOwnership).not.toHaveBeenCalled();
    expect(ops.capturePaneProcessTree).not.toHaveBeenCalled();
  });

  it('without a persisted capture reads the pane and gives the capture back to be persisted; a capture that does not validate is read anew', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => TREE) };
    for (const persisted of [undefined, { panePid: 'x' }]) {
      const read = await readFencedPaneTree(ownership(), ops, persisted);
      expect(read.tree).toBe(TREE);
      expect(read.record).toEqual(serializePaneTree(TREE));
    }
    expect(ops.capturePaneProcessTree).toHaveBeenCalledTimes(2);
  });
});
