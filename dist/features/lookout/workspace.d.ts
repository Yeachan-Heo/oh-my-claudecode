import type { LookoutFinding } from "./types.js";
export declare function repoRoot(repoArg: string): string | null;
export declare function scanWorkspace(root: string, advice: {
    gate: string;
    checkpoint: string;
}): LookoutFinding[];
//# sourceMappingURL=workspace.d.ts.map