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
 * it. A pane that has left that target (and may have been repurposed since) is not read, so its processes are not signalled before the
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
  try {
    const membership = await ops.verifyTeamTargetOwnership({
      provider: ownership.provider,
      providerTarget: ownership.providerTarget,
      recipient: "worker",
      recipientRole: "worker",
      paneId: ownership.paneId,
      ...(ownership.provider === "tmux" ? { tmuxServerIdentity: ownership.tmuxServerIdentity } : {}),
    } as MailboxNotificationTarget);
    if (membership.kind !== "owned") return null;
  } catch {
    return null;
  }
  return ops.capturePaneProcessTree(ownership.tmuxServerIdentity, ownership.paneId);
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

/**
 * The read of a cleanup at the launch fence, for `retireAndCleanupCurrentWorkerLaunchAttempt`: `persisted` is the capture an earlier,
 * interrupted run of the same retirement persisted, which is used as it is (the provider is gone by now, and a read taken after that misses
 * the descendants that left its process group); without one the pane is read as `capturePaneProcessTreeOfWorkerPane` does. `record` is what
 * the hook gives back to be persisted: the new capture, or nothing.
 */
export async function readFencedPaneTree(
  ownership: WorkerPaneOwnership | null | undefined,
  ops: PaneTreeReadOps,
  persisted?: unknown,
): Promise<{ tree: PaneProcessTree | null; record: ReturnType<typeof serializePaneTree> | undefined }> {
  const earlier = revivePaneTree(persisted);
  if (earlier) return { tree: earlier, record: undefined };
  const tree = await capturePaneProcessTreeOfWorkerPane(ownership, ops);
  return { tree, record: tree ? serializePaneTree(tree) : undefined };
}
