/**
 * Intake Command (P2 Part B, contract: docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md)
 *
 * Gives the harbor headless sweep its power switch:
 *   omc intake run --headless       one sweep: preconditions -> headless session -> exit
 *   omc intake schedule --cron ...  register the sweep with the HOST scheduler
 *   omc intake schedule --off       remove it
 *
 * Doctrine (inherited from harbor and the #4113 review):
 * - The timer belongs to the host scheduler; OMC runs no daemon.
 * - The CLI executes preconditions and facts only; every disposition stays
 *   inside the harbor skill (labels it may create; nothing else).
 * - No PR, no push, no tracker posting happens from this file.
 */
import { Command } from 'commander';
export interface IntakeExecResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export type IntakeRunner = (cmd: string, args: string[], options: {
    cwd: string;
    env?: Record<string, string>;
    input?: string;
}) => IntakeExecResult;
/** Real runner: git-style spawn with a bounded timeout and captured output. */
export declare const defaultIntakeRunner: IntakeRunner;
export interface PreconditionCheck {
    ok: boolean;
    reason?: string;
}
/** Tracker reachable: `gh repo view` answers in the working directory. */
export declare function checkTrackerReachable(cwd: string, runner: IntakeRunner): PreconditionCheck;
/** Harbor labels exist or can be created (harbor's own first-use contract). */
export declare function checkOrCreateHarborLabels(cwd: string, runner: IntakeRunner): PreconditionCheck;
/**
 * Single-writer lock: one intake run per repository. The lock is stale after
 * LOCK_STALE_MS regardless of pid liveness (crashed runners must not wedge
 * the intake forever).
 */
export declare function acquireIntakeLock(cwd: string, now?: number): PreconditionCheck;
export declare function releaseIntakeLock(cwd: string): void;
/**
 * Classify a cron expression into the subset the Windows Task Scheduler can
 * express. Everything outside this subset is refused on Windows (with the
 * crontab option noted), never silently approximated.
 */
export declare function parseSimpleCron(expr: string): {
    kind: 'minutes';
    every: number;
} | {
    kind: 'daily';
    hour: number;
    minute: number;
} | {
    kind: 'unsupported';
};
export interface SchedulePlan {
    platform: 'cron' | 'schtasks';
    crontabLine?: string;
    schtaskArgs?: string[];
}
/** Build the host-native registration plan from the parsed cron expression. */
export declare function buildSchedulePlan(platform: 'linux' | 'darwin' | 'win32', expr: string, runCommand: string): SchedulePlan | {
    refused: string;
};
/** Keep (remove=false) or drop (remove=true) the marked crontab lines. When
 * installing (remove=false), `installLine` is appended after the cleanup. */
export declare function filterCrontabLines(existing: string, remove: boolean, installLine?: string): string;
export declare function buildScheduledCommand(cwd: string): string;
export interface HeadlessRunResult {
    exitCode: number;
    message: string;
}
/** `omc intake run --headless`: preconditions, lock, headless sweep, exit. */
export declare function runHeadlessIntake(options: {
    cwd?: string;
    claudeBin?: string;
    allowDocketOnly?: boolean;
}, runner?: IntakeRunner): HeadlessRunResult;
/** `omc intake schedule`: install or remove the host-native entry. */
export declare function scheduleIntake(options: {
    cwd?: string;
    cron: string;
    off?: boolean;
}, runner?: IntakeRunner): HeadlessRunResult;
export declare function intakeCommand(): Command;
//# sourceMappingURL=intake.d.ts.map