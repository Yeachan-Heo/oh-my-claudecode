export type PlanningArtifactKind = "prd" | "test-spec" | "deep-interview" | "deep-interview-autoresearch";
export interface PlanningArtifactNameInfo {
    kind: PlanningArtifactKind;
    slug: string;
    timestamp?: string;
}
export declare function planningArtifactTimestamp(date?: Date): string;
export declare function parsePlanningArtifactFileName(fileNameOrPath: string): PlanningArtifactNameInfo | null;
export declare function planningArtifactSlug(fileNameOrPath: string, kind: PlanningArtifactKind): string | null;
export declare function comparePlanningArtifactPaths(left: string, right: string): number;
export declare function selectMatchingTestSpecsForPrd(prdPath: string | null, testSpecPaths: readonly string[]): string[];
export declare function selectLatestPlanningArtifactPath(paths: readonly string[]): string | null;
//# sourceMappingURL=artifact-names.d.ts.map