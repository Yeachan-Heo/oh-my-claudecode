import type { MailboxNotificationTarget } from "./mailbox-notification-guard.js";
import type { PaneProcessTree, WorkerPaneOwnership } from "./tmux-session.js";
import type { TmuxServerIdentity } from "./types.js";

/** The two tmux session functions the read needs, passed by the caller so that this module does not import the one that uses it. */
export interface PaneTreeReadOps {
  verifyTeamTargetOwnership: (target: MailboxNotificationTarget) => Promise<{ kind: string }>;
  capturePaneProcessTree: (identity: TmuxServerIdentity, paneId: string) => Promise<PaneProcessTree | null>;
}

/**
 * The read of a worker pane's process tree (OMC_TEAM_KILL_PANE_TREE) that a cleanup takes before it ends the pane's provider, for the
 * signal that follows. It stands behind what the kill of the pane (`killOwnedWorkerPane`) requires before it acts: not the pane of the
 * leader, not a reserved one, and a pane that shows, at the time of the read, to be a pane of the provider target the team recorded for
 * it, both before and after the tree is read. A pane that has left that target (and may have been repurposed since) is not read, so its processes are not signalled before the
 * kill refuses the pane. Returns null when the pane is refused, as `capturePaneProcessTree` does when it reads nothing.
 */
export async function capturePaneProcessTreeOfWorkerPane(
  ownership: WorkerPaneOwnership | null | undefined,
  ops: PaneTreeReadOps,
): Promise<PaneProcessTree | null> {
  if (
    process.env.OMC_TEAM_KILL_PANE_TREE !== "1" ||
    !ownership?.tmuxServerIdentity ||
    !ownership.paneId.startsWith("%") ||
    ownership.paneId === ownership.leaderPaneId ||
    ownership.reservedPaneIds.includes(ownership.paneId)
  )
    return null;
  const identity = ownership.tmuxServerIdentity;
  const isOwned = async (): Promise<boolean> => {
    try {
      const membership = await ops.verifyTeamTargetOwnership({
        provider: ownership.provider,
        providerTarget: ownership.providerTarget,
        recipient: "worker",
        recipientRole: "worker",
        paneId: ownership.paneId,
        ...(ownership.provider === "tmux" ? { tmuxServerIdentity: identity } : {}),
      } as MailboxNotificationTarget);
      return membership.kind === "owned";
    } catch {
      return false;
    }
  };
  if (!(await isOwned())) return null;
  const tree = await ops.capturePaneProcessTree(identity, ownership.paneId);
  // The pane may have left its target and been respawned between the proof and the read: the tree is then the one of a replacement, and it
  // is given back only when the pane shows to be the pane of the team after the read as well.
  return tree && (await isOwned()) ? tree : null;
}

/** The tree as JSON data (a Map has none), the form in which a fenced capture is persisted with the retirement record of a launch attempt. */
export function serializePaneTree(tree: PaneProcessTree): { panePid: number; pids: number[]; startIdentities: Array<[number, string | null]> } {
  return { panePid: tree.panePid, pids: [...tree.pids], startIdentities: [...tree.startIdentities] };
}

/** The tree a persisted capture holds, or null when the value is not one: a tree that does not validate is never signalled. */
export function revivePaneTree(value: unknown): PaneProcessTree | null {
  if (!value || typeof value !== "object") return null;
  const { panePid, pids, startIdentities } = value as Record<string, unknown>;
  const isPid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 1;
  if (!isPid(panePid) || !Array.isArray(pids) || !pids.every(isPid) || !Array.isArray(startIdentities)) return null;
  const identities = new Map<number, string | null>();
  for (const entry of startIdentities) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isPid(entry[0]) || !(entry[1] === null || typeof entry[1] === "string")) return null;
    identities.set(entry[0], entry[1]);
  }
  return { panePid, pids: [...pids], startIdentities: identities };
}

/** The trees a persisted capture holds: the ones that validate (a tree that does not is never signalled), none for anything that is not a list. */
export function revivePaneTrees(value: unknown): PaneProcessTree[] {
  if (!Array.isArray(value)) return [];
  return value.map(revivePaneTree).filter((tree): tree is PaneProcessTree => tree !== null);
}

/** The trees of the list that are not null, each one once (two reads of the same tree are signalled once). */
export function uniquePaneTrees(list: ReadonlyArray<PaneProcessTree | null | undefined>): PaneProcessTree[] {
  const seen = new Set<string>();
  return list.filter((tree): tree is PaneProcessTree => {
    if (!tree) return false;
    const key = JSON.stringify(serializePaneTree(tree));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The read of a cleanup at the launch fence, for `retireAndCleanupCurrentWorkerLaunchAttempt`. `persisted` is the capture an earlier run
 * (or the caller, before it asked the worker to exit) persisted: it is kept, since the provider may be gone by now and a read taken after
 * that misses the descendants that left its process group, and the pane is read again all the same, since the provider may still be live
 * (a termination that failed) and have started descendants since. `trees` are the ones to signal at the fence: the persisted ones (but those
 * the caller signals itself, being in `earlier`) and the new read. `record` is what replaces the persisted capture: those together with `earlier`, the trees the caller read before the fence and
 * signals itself on this run (a worker that exited since then leaves them as the only identities there are, and a retry cannot read them
 * again); undefined when that adds nothing to what is persisted.
 */
export async function readFencedPaneTree(
  ownership: WorkerPaneOwnership | null | undefined,
  ops: PaneTreeReadOps,
  persisted?: unknown,
  earlier: ReadonlyArray<PaneProcessTree | null | undefined> = [],
): Promise<{ trees: PaneProcessTree[]; record: ReturnType<typeof serializePaneTree>[] | undefined }> {
  // a capture left by a run with the switch on is not used with it off: nothing is signalled then
  const kept = process.env.OMC_TEAM_KILL_PANE_TREE === "1" ? revivePaneTrees(persisted) : [];
  const fresh = await capturePaneProcessTreeOfWorkerPane(ownership, ops);
  const all = uniquePaneTrees([...kept, ...earlier, fresh]);
  const signalledByCaller = new Set(uniquePaneTrees(earlier).map((tree) => JSON.stringify(serializePaneTree(tree))));
  const toSignal = kept.filter((tree) => !signalledByCaller.has(JSON.stringify(serializePaneTree(tree))));
  return { trees: uniquePaneTrees([...toSignal, fresh]), record: all.length > uniquePaneTrees(kept).length ? all.map(serializePaneTree) : undefined };
}
