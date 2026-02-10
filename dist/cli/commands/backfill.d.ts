interface BackfillCommandOptions {
    project?: string;
    from?: string;
    to?: string;
    dryRun?: boolean;
    reset?: boolean;
    verbose?: boolean;
    json?: boolean;
}
/**
 * omc backfill command handler
 */
export declare function backfillCommand(options: BackfillCommandOptions): Promise<void>;
export {};
//# sourceMappingURL=backfill.d.ts.map