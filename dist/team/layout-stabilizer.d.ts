export interface LayoutStabilizerOptions {
    sessionTarget: string;
    leaderPaneId: string;
    debounceMs?: number;
}
export declare class LayoutStabilizer {
    private pending;
    private running;
    private queuedWhileRunning;
    private disposed;
    private flushResolvers;
    readonly sessionTarget: string;
    readonly leaderPaneId: string;
    private readonly debounceMs;
    constructor(opts: LayoutStabilizerOptions);
    requestLayout(): void;
    flush(): Promise<void>;
    dispose(): void;
    get isPending(): boolean;
    get isRunning(): boolean;
    private applyLayout;
}
//# sourceMappingURL=layout-stabilizer.d.ts.map