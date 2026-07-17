import type { MergeReadinessState } from "./types.js";
/** Render the authoritative session state as a report without filesystem side effects. */
export declare function formatMergeReadinessReport(state: MergeReadinessState): string;
/** Remove answer keys and interim scoring from the public state_read surface. */
export declare function redactMergeReadinessState(state: MergeReadinessState): Record<string, unknown>;
//# sourceMappingURL=report.d.ts.map