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
/**
 * Read planning artifacts from .omc/plans/ directory.
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
export declare function readApprovedExecutionLaunchHint(cwd: string, mode: "team" | "ralph"): ApprovedExecutionLaunchHint | null;
//# sourceMappingURL=artifacts.d.ts.map