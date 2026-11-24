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
