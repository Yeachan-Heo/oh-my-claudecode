/**
 * Idle Pane Nudge for Team MCP Wait
 *
 * Detects idle teammate panes during omc_run_team_wait polling and sends
 * tmux send-keys continuation nudges. Only nudges worker panes (never the
 * leader) in the current team session.
 *
 * Idle = pane shows a prompt (paneLooksReady) AND no active task running
 * (paneHasActiveTask is false).
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1047
 */

import {
  paneLooksReady,
  paneHasActiveTask,
  captureOwnedTeamPane,
  type WorkerPaneOwnership,
} from './tmux-session.js';
import {
  isValidTeamInstanceId,
  isValidTmuxServerIdentity,
  type TeamInstanceId,
  type TmuxServerIdentity,
} from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NudgeConfig {
  /** Milliseconds a pane must be idle before the first nudge (default: 30000) */
  delayMs: number;
  /** Maximum number of nudges per pane per wait call (default: 3) */
  maxCount: number;
  /** Text sent to the pane as a nudge (default below) */
  message: string;
}

export interface NudgeAuthority {
  /** Original durable team incarnation from the job record. */
  instanceId: TeamInstanceId;
  /** Exact persisted provider/session target from the team config. */
  sessionName: string;
  /** Tmux server incarnation captured when the team was created. */
  tmuxServerIdentity?: TmuxServerIdentity;
  /** Provider inferred from the persisted target when omitted. */
  provider?: 'tmux' | 'cmux';
  /**
   * Return the exact provider ownership for one persisted worker pane.
   * Missing ownership is never replaced with ambient pane capture.
   */
  getPaneOwnership: (paneId: string) => WorkerPaneOwnership | undefined;
  /**
   * Perform final authority validation and transport while holding the
   * original instance lifecycle lock. Returning false means no delivery was
   * proven and must not increment counters.
   */
  executeNudge: (paneId: string, message: string) => Promise<boolean>;
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  delayMs: 30_000,
  maxCount: 3,
  message: 'Continue working on your assigned task and report concrete progress (not ACK-only).',
};

// ---------------------------------------------------------------------------
// Pane capture + idle detection
// ---------------------------------------------------------------------------

/** Capture the last 80 lines of a team pane. Returns '' on error. */
export async function capturePane(ownership: WorkerPaneOwnership): Promise<string> {
  try {
    return await captureOwnedTeamPane(ownership);
  } catch {
    return '';
  }
}

/**
 * A pane is idle when it shows a prompt (ready for input) but has no
 * active task running.
 */
export async function isPaneIdle(ownership: WorkerPaneOwnership): Promise<boolean> {
  const captured = await capturePane(ownership);
  if (!captured) return false;
  return paneLooksReady(captured) && !paneHasActiveTask(captured);
}

// ---------------------------------------------------------------------------
// NudgeTracker
// ---------------------------------------------------------------------------

interface PaneNudgeState {
  nudgeCount: number;
  firstIdleAt: number | null;
  lastNudgeAt: number | null;
}

export class NudgeTracker {
  private readonly config: NudgeConfig;
  private readonly states = new Map<string, PaneNudgeState>();
  /** Minimum interval between idle-detection scans (ms). */
  private readonly scanIntervalMs = 5_000;
  private lastScanAt = 0;

  constructor(config?: Partial<NudgeConfig>) {
    this.config = { ...DEFAULT_NUDGE_CONFIG, ...config };
  }

  /**
   * Check worker panes for idle state and nudge when appropriate.
   * Returns pane IDs that were nudged in this call.
   *
   * @param paneIds   - Worker pane IDs from the job's panes file
   * @param leaderPaneId - Leader pane ID (never nudged)
   * @param authority   - Original instance and exact persisted provider target
   */
  async checkAndNudge(
    paneIds: string[],
    leaderPaneId: string | undefined,
    authority: NudgeAuthority,
  ): Promise<string[]> {
    if (!authority || typeof authority !== 'object') return [];
    const sessionName = typeof authority.sessionName === 'string' ? authority.sessionName : '';
    const provider = authority.provider
      ?? (sessionName.startsWith('cmux:') ? 'cmux' : 'tmux');
    if (!Array.isArray(paneIds)
      || (provider !== 'tmux' && provider !== 'cmux')
      || sessionName.length === 0
      || !isValidTeamInstanceId(authority.instanceId)
      || sessionName.trim() !== sessionName
      || (authority.provider !== undefined && authority.provider !== provider)
      || typeof authority.getPaneOwnership !== 'function'
      || typeof authority.executeNudge !== 'function'
      || (provider === 'tmux'
        && (!authority.tmuxServerIdentity || !isValidTmuxServerIdentity(authority.tmuxServerIdentity)))
      || (provider === 'cmux' && authority.tmuxServerIdentity !== undefined)) {
      return [];
    }
    const now = Date.now();

    // Throttle: skip if last scan was too recent
    if (now - this.lastScanAt < this.scanIntervalMs) return [];
    this.lastScanAt = now;

    const nudged: string[] = [];

    for (const paneId of paneIds) {
      // Never nudge the leader pane
      if (paneId === leaderPaneId) continue;

      let state = this.states.get(paneId);
      if (!state) {
        state = { nudgeCount: 0, firstIdleAt: null, lastNudgeAt: null };
        this.states.set(paneId, state);
      }

      // Max nudges reached for this pane — skip
      if (state.nudgeCount >= this.config.maxCount) continue;

      let ownership: WorkerPaneOwnership | undefined;
      try {
        ownership = authority.getPaneOwnership(paneId);
      } catch {
        continue;
      }
      if (!ownership
        || ownership.paneId !== paneId
        || ownership.provider !== provider
        || ownership.providerTarget !== sessionName
        || (provider === 'tmux'
          && (!authority.tmuxServerIdentity
            || !ownership.tmuxServerIdentity
            || ownership.tmuxServerIdentity.socket_path !== authority.tmuxServerIdentity.socket_path
            || ownership.tmuxServerIdentity.server_pid !== authority.tmuxServerIdentity.server_pid
            || ownership.tmuxServerIdentity.process_started_at !== authority.tmuxServerIdentity.process_started_at))
        || (provider === 'cmux' && ownership.tmuxServerIdentity !== undefined)) {
        continue;
      }

      const idle = await isPaneIdle(ownership);

      if (!idle) {
        // Pane is active — reset idle tracking
        state.firstIdleAt = null;
        continue;
      }

      // Record when we first detected idle
      if (state.firstIdleAt === null) {
        state.firstIdleAt = now;
      }

      // Has the pane been idle long enough?
      if (now - state.firstIdleAt < this.config.delayMs) continue;

      // Send the nudge
      let ok = false;
      try {
        ok = await authority.executeNudge(paneId, this.config.message);
      } catch {
        ok = false;
      }
      if (ok) {
        state.nudgeCount++;
        state.lastNudgeAt = now;
        // Reset idle timer so the next nudge waits another full delay
        state.firstIdleAt = null;
        nudged.push(paneId);
      }
    }

    return nudged;
  }

  /** Summary of nudge activity per pane. */
  getSummary(): Record<string, { nudgeCount: number; lastNudgeAt: number | null }> {
    const out: Record<string, { nudgeCount: number; lastNudgeAt: number | null }> = {};
    for (const [paneId, state] of this.states) {
      if (state.nudgeCount > 0) {
        out[paneId] = { nudgeCount: state.nudgeCount, lastNudgeAt: state.lastNudgeAt };
      }
    }
    return out;
  }

  /** Total nudges sent across all panes. */
  get totalNudges(): number {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.nudgeCount;
    }
    return total;
  }
}
