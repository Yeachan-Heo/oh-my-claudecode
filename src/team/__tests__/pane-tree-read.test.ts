import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFencedPaneTree, revivePaneTree, revivePaneTrees, serializePaneTree } from '../pane-tree-read.js';
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

  it('keeps the capture an interrupted run persisted when the pane is gone, and adds nothing to it', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => null) };
    const read = await readFencedPaneTree(ownership(), ops, JSON.parse(JSON.stringify([serializePaneTree(TREE)])));
    expect(read.trees).toEqual([TREE]);
    expect(read.record).toBeUndefined(); // already persisted
  });

  it('reads the pane again when a capture is persisted (the provider may still run and have started descendants since), and replaces the capture with the union', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const later: PaneProcessTree = { panePid: 4000, pids: [4001, 4002, 4003], startIdentities: new Map<number, string | null>([[4001, 'start-4001'], [4002, null], [4003, 'start-4003']]) };
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => later) };
    const read = await readFencedPaneTree(ownership(), ops, JSON.parse(JSON.stringify([serializePaneTree(TREE)])));
    expect(ops.capturePaneProcessTree).toHaveBeenCalledTimes(1);
    expect(read.trees).toEqual([TREE, later]);
    expect(read.record).toEqual([serializePaneTree(TREE), serializePaneTree(later)]);
    // the same tree read again is neither signalled twice nor persisted twice
    const same = await readFencedPaneTree(ownership(), { ...ops, capturePaneProcessTree: vi.fn(async () => TREE) }, JSON.parse(JSON.stringify([serializePaneTree(TREE)])));
    expect(same.trees).toEqual([TREE]);
    expect(same.record).toBeUndefined();
  });

  it('leaves out of the trees to signal the persisted ones the caller signals itself, and keeps them in the record', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => null) };
    const read = await readFencedPaneTree(ownership(), ops, JSON.parse(JSON.stringify([serializePaneTree(TREE)])), [TREE]);
    expect(read.trees).toEqual([]);
    expect(read.record).toBeUndefined();
  });

  it('does not use a persisted capture when the switch is off: nothing is signalled', async () => {
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => TREE) };
    const read = await readFencedPaneTree(ownership(), ops, JSON.parse(JSON.stringify([serializePaneTree(TREE)])));
    expect(read.trees).toEqual([]);
    expect(ops.capturePaneProcessTree).not.toHaveBeenCalled();
  });

  it('without a persisted capture reads the pane and gives the capture back to be persisted; a capture that does not validate is read anew', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const ops = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => TREE) };
    for (const persisted of [undefined, { panePid: 'x' }]) {
      const read = await readFencedPaneTree(ownership(), ops, persisted);
      expect(read.trees).toEqual([TREE]);
      expect(read.record).toEqual([serializePaneTree(TREE)]);
    }
    expect(ops.capturePaneProcessTree).toHaveBeenCalledTimes(2);
  });

  it('persists the trees read before the fence with the read at the fence, and when the pane is gone the earlier ones alone', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const other: PaneProcessTree = { panePid: 4000, pids: [4005], startIdentities: new Map([[4005, 'start-4005']]) };
    const gone = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => null) };
    const alone = await readFencedPaneTree(null, gone, undefined, [TREE, null, other]);
    expect(alone.trees).toEqual([]); // nothing is read at the fence: the caller signals its own earlier trees on this run
    expect(alone.record).toEqual([serializePaneTree(TREE), serializePaneTree(other)]);
    const alive = { verifyTeamTargetOwnership: vi.fn(async () => ({ kind: 'owned' })), capturePaneProcessTree: vi.fn(async () => TREE) };
    const both = await readFencedPaneTree(ownership(), alive, undefined, [other]);
    expect(both.trees).toEqual([TREE]);
    expect(both.record).toEqual([serializePaneTree(other), serializePaneTree(TREE)]);
    // a retry gets all of them back from what was persisted, and drops what does not validate
    expect(revivePaneTrees(JSON.parse(JSON.stringify([...both.record!, { panePid: 'x' }])))).toEqual([other, TREE]);
    expect((await readFencedPaneTree(ownership(), gone, JSON.parse(JSON.stringify(both.record)))).trees).toEqual([other, TREE]);
    expect(revivePaneTrees('tree')).toEqual([]);
  });
});
