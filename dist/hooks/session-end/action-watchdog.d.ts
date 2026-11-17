export interface SessionEndWatchdogControl {
    directory: string;
    jobId: string;
    action: string;
    attempt: number;
    runnerNonce: string;
    deadlineAt: number;
}
/** Durable deadline evidence names the detached action runner from its control record when available. */
export declare function armSessionEndActionWatchdog(control: SessionEndWatchdogControl): () => void;
//# sourceMappingURL=action-watchdog.d.ts.map