import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface LayoutStabilizerOptions {
  sessionTarget: string;
  leaderPaneId: string;
  debounceMs?: number;
}

async function tmuxCmd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (args.some(a => a.includes('#{'))) {
    const { exec } = await import('child_process');
    const execAsync = promisify(exec);
    const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    return execAsync(`tmux ${escaped}`);
  }
  return execFileAsync('tmux', args);
}

export class LayoutStabilizer {
  private pending: NodeJS.Timeout | null = null;
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

  requestLayout(): void {
    if (this.disposed) return;

    if (this.running) {
      this.queuedWhileRunning = true;
      return;
    }

    if (this.pending) clearTimeout(this.pending);

    this.pending = setTimeout(() => {
      this.pending = null;
      void this.applyLayout();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.disposed) return;

    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }

    if (this.running) {
      this.queuedWhileRunning = true;
      return new Promise(resolve => {
        this.flushResolvers.push(resolve);
      });
    }

    await this.applyLayout();
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }

    for (const resolve of this.flushResolvers) resolve();
    this.flushResolvers = [];
  }

  get isPending(): boolean {
    return this.pending !== null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async applyLayout(): Promise<void> {
    if (this.running || this.disposed) return;

    this.running = true;
    try {
      try {
        await execFileAsync('tmux', ['select-layout', '-t', this.sessionTarget, 'main-vertical']);
      } catch {
        // ignore
      }

      try {
        const widthResult = await tmuxCmd([
          'display-message', '-p', '-t', this.sessionTarget, '#{window_width}',
        ]);
        const width = parseInt(widthResult.stdout.trim(), 10);
        if (Number.isFinite(width) && width >= 40) {
          const half = String(Math.floor(width / 2));
          await execFileAsync('tmux', ['set-window-option', '-t', this.sessionTarget, 'main-pane-width', half]);
          await execFileAsync('tmux', ['select-layout', '-t', this.sessionTarget, 'main-vertical']);
        }
      } catch {
        // ignore
      }

      try {
        await execFileAsync('tmux', ['select-pane', '-t', this.leaderPaneId]);
      } catch {
        // ignore
      }
    } finally {
      this.running = false;
      const waiters = this.flushResolvers;
      this.flushResolvers = [];
      for (const resolve of waiters) resolve();

      if (this.queuedWhileRunning && !this.disposed) {
        this.queuedWhileRunning = false;
        this.requestLayout();
      }
    }
  }
}
