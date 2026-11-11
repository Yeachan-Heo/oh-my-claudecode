export interface PlanningArtifacts {
    prdPaths: string[];
    testSpecPaths: string[];
}
export interface ApprovedExecutionLaunchHint {
    mode: "team" | "ralph";
    command: string;
    task: string;
    workerCount?: number;
    agentType?: string;
    linkedRalph?: boolean;
    sourcePath: string;
}
interface ApprovedExecutionLaunchHintReadOptions {
    prdPath?: string;
    task?: string;
    command?: string;
    requirePlanningComplete?: boolean;
}
export type ApprovedExecutionLaunchHintOutcome = {
    status: "absent";
} | {
    status: "ambiguous";
} | {
    status: "incomplete";
} | {
    status: "resolved";
    hint: ApprovedExecutionLaunchHint;
};
/**
 * Read planning artifacts from .omc/.omx plans directories.
 * Returns paths to all PRD and test-spec files found.
 */
export declare function readPlanningArtifacts(cwd: string): PlanningArtifacts;
/**
 * Returns true when the latest PRD and latest test spec contain
 * the required non-empty quality-gate sections.
 */
export declare function isPlanningComplete(artifacts: PlanningArtifacts): boolean;
/**
 * Read the latest PRD file and extract an embedded launch hint for the given mode.
 * Returns null when no hint is found.
 */
export declare function readApprovedExecutionLaunchHint(cwd: string, mode: "team" | "ralph", options?: ApprovedExecutionLaunchHintReadOptions): ApprovedExecutionLaunchHint | null;
export declare function readApprovedExecutionLaunchHintOutcome(cwd: string, mode: "team" | "ralph", options?: ApprovedExecutionLaunchHintReadOptions): ApprovedExecutionLaunchHintOutcome;
export {};
//# sourceMappingURL=artifacts.d.ts.map