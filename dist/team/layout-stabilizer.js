import { tmuxExecAsync, tmuxCmdAsync } from '../cli/tmux-utils.js';
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
                await tmuxExecAsync(['select-layout', '-t', this.sessionTarget, 'main-vertical']);
            }
            catch {
                // ignore
            }
            try {
                const widthResult = await tmuxCmdAsync([
                    'display-message', '-p', '-t', this.sessionTarget, '#{window_width}',
                ]);
                const width = parseInt(widthResult.stdout.trim(), 10);
                if (Number.isFinite(width) && width >= 40) {
                    const half = String(Math.floor(width / 2));
                    await tmuxExecAsync(['set-window-option', '-t', this.sessionTarget, 'main-pane-width', half]);
                    await tmuxExecAsync(['select-layout', '-t', this.sessionTarget, 'main-vertical']);
                }
            }
            catch {
                // ignore
            }
            try {
                await tmuxExecAsync(['select-pane', '-t', this.leaderPaneId]);
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