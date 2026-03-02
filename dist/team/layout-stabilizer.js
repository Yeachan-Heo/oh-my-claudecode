import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
async function tmuxCmd(args) {
    if (args.some(a => a.includes('#{'))) {
        const { exec } = await import('child_process');
        const execAsync = promisify(exec);
        const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        return execAsync(`tmux ${escaped}`);
    }
    return execFileAsync('tmux', args);
}
export class LayoutStabilizer {
    pending = null;
    running = false;
    queuedWhileRunning = false;
    disposed = false;
    flushResolvers = [];
    sessionTarget;
    leaderPaneId;
    debounceMs;
    constructor(opts) {
        this.sessionTarget = opts.sessionTarget;
        this.leaderPaneId = opts.leaderPaneId;
        this.debounceMs = opts.debounceMs ?? 150;
    }
    requestLayout() {
        if (this.disposed)
            return;
        if (this.running) {
            this.queuedWhileRunning = true;
            return;
        }
        if (this.pending)
            clearTimeout(this.pending);
        this.pending = setTimeout(() => {
            this.pending = null;
            void this.applyLayout();
        }, this.debounceMs);
    }
    async flush() {
        if (this.disposed)
            return;
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
    dispose() {
        this.disposed = true;
        if (this.pending) {
            clearTimeout(this.pending);
            this.pending = null;
        }
        for (const resolve of this.flushResolvers)
            resolve();
        this.flushResolvers = [];
    }
    get isPending() {
        return this.pending !== null;
    }
    get isRunning() {
        return this.running;
    }
    async applyLayout() {
        if (this.running || this.disposed)
            return;
        this.running = true;
        try {
            try {
                await execFileAsync('tmux', ['select-layout', '-t', this.sessionTarget, 'main-vertical']);
            }
            catch {
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
            }
            catch {
                // ignore
            }
            try {
                await execFileAsync('tmux', ['select-pane', '-t', this.leaderPaneId]);
            }
            catch {
                // ignore
            }
        }
        finally {
            this.running = false;
            const waiters = this.flushResolvers;
            this.flushResolvers = [];
            for (const resolve of waiters)
                resolve();
            if (this.queuedWhileRunning && !this.disposed) {
                this.queuedWhileRunning = false;
                this.requestLayout();
            }
        }
    }
}
//# sourceMappingURL=layout-stabilizer.js.map