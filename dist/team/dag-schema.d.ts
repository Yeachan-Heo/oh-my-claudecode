export type TeamDagWorkerCountSource = 'cli-explicit' | 'plan-suggested' | 'default-derived';
export interface TeamDagNode {
    id: string;
    subject: string;
    description: string;
    role?: string;
    lane?: string;
    filePaths?: string[];
    domains?: string[];
    depends_on?: string[];
    requires_code_change?: boolean;
    acceptance?: string[];
}
export interface TeamDagWorkerPolicy {
    requested_count?: number;
    count_source?: TeamDagWorkerCountSource;
    max_count?: number;
    reserve_verification_lane?: boolean;
    strict_max_count?: boolean;
}
export interface TeamDagHandoff {
    schema_version: 1;
    plan_slug?: string;
    source_prd?: string;
    nodes: TeamDagNode[];
    worker_policy?: TeamDagWorkerPolicy;
}
export interface TeamDagResolution {
    dag: TeamDagHandoff | null;
    source: 'sidecar' | 'markdown' | 'none';
    path?: string;
    planSlug?: string;
    warning?: string;
    error?: string;
}
export declare function parseTeamDagHandoff(value: unknown): TeamDagHandoff;
export declare function readTeamDagHandoffForLatestPlan(cwd: string): TeamDagResolution;
//# sourceMappingURL=dag-schema.d.ts.map