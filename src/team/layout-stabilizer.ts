/**
 * Layout Stabilizer for tmux team sessions.
 *
 * Prevents layout thrashing during rapid worker spawn/kill cycles by:
 * 1. Debouncing layout recalculations (coalesces rapid requests into one)
 * 2. Serializing layout operations (mutex prevents concurrent tmux layout calls)
 * 3. Preserving leader pane focus after every layout update
 *
 * @see https://github.com/nicobailon/oh-my-claudecode/issues/1158
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Execute a tmux command asynchronously. Routes through shell when arguments
 * contain tmux format strings (e.g. #{pane_id}) to prevent MSYS2 execFile
 * from stripping curly braces.
 */
async function tmuxCmd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (args.some(a => a.includes('#{'))) {
    const { exec } = await import('child_process');
    const execAsync = promisify(exec);
    const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    return execAsync(`tmux ${escaped}`);
  }
  return execFileAsync('tmux', args);
}

export interface LayoutStabilizerOptions {
  /** tmux target in "session:window" form */
  sessionTarget: string;
  /** Pane ID of the leader pane (e.g. %0) — never killed, always re-focused */
  leaderPaneId: string;
  /** Minimum quiet period before applying layout (ms). Default: 150 */
  debounceMs?: number;
}

export class LayoutStabilizer {
  private pending: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queuedWhileRunning = false;
  private disposed = false;
  private flushResolvers: Array<() => void> = [];

  readonly sessionTarget: string;
  readonly leaderPaneId: string;
  private readonly debounceMs: number;

  constructor(opts: LayoutStabilizerOptions) {
    this.sessionTarget = opts.sessionTarget;
    this.leaderPaneId = opts.leaderPaneId;
    this.debounceMs = opts.debounceMs ?? 150;
  }

  /**
   * Request a layout recalculation. Multiple rapid calls are coalesced
   * into a single layout operation after debounceMs of quiet.
   */
  requestLayout(): void {
    if (this.disposed) return;

    if (this.running) {
      // An operation is in flight — queue one more after it finishes
      this.queuedWhileRunning = true;
      return;
    }

    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.applyLayout();
    }, this.debounceMs);
  }

  /**
   * Force an immediate layout recalculation, bypassing debounce.
   * Waits for any in-flight operation to complete first.
   * Use at the end of a watchdog tick to ensure layout is stable.
   */
  async flush(): Promise<void> {
    if (this.disposed) return;

    // Cancel any pending debounced call — we'll run it now
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }

    // If an operation is already running, wait for it to finish
    if (this.running) {
      this.queuedWhileRunning = true;
      return new Promise<void>(resolve => {
        this.flushResolvers.push(resolve);
      });
    }

    await this.applyLayout();
  }

  /**
   * Cancel any pending layout operation and release resources.
   */
  dispose(): void {
    this.disposed = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    // Resolve any waiters so they don't hang
    for (const resolve of this.flushResolvers) {
      resolve();
    }
    this.flushResolvers = [];
  }

  /** Visible for testing */
  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Visible for testing */
  get isRunning(): boolean {
    return this.running;
  }

  private async applyLayout(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      // 1. Apply main-vertical layout
      try {
        await execFileAsync('tmux', ['select-layout', '-t', this.sessionTarget, 'main-vertical']);
      } catch {
        // Layout may not apply if only 1 pane; ignore
      }

      // 2. Set leader pane to half the window width
      try {
        const widthResult = await tmuxCmd([
          'display-message', '-p', '-t', this.sessionTarget, '#{window_width}'
        ]);
        const width = parseInt(widthResult.stdout.trim(), 10);
        if (Number.isFinite(width) && width >= 40) {
          const half = String(Math.floor(width / 2));
          await execFileAsync('tmux', [
            'set-window-option', '-t', this.sessionTarget, 'main-pane-width', half
          ]);
          await execFileAsync('tmux', [
            'select-layout', '-t', this.sessionTarget, 'main-vertical'
          ]);
        }
      } catch {
        // ignore layout sizing errors
      }

      // 3. Re-select leader pane to preserve focus
      try {
        await execFileAsync('tmux', ['select-pane', '-t', this.leaderPaneId]);
      } catch {
        // ignore
      }
    } finally {
      this.running = false;

      // Resolve flush waiters
      const waiters = this.flushResolvers;
      this.flushResolvers = [];
      for (const resolve of waiters) {
        resolve();
      }

      // If a request came in while we were running, schedule another
      if (this.queuedWhileRunning && !this.disposed) {
        this.queuedWhileRunning = false;
        this.requestLayout();
      }
    }
  }
}
