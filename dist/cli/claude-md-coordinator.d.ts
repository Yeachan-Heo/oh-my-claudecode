import { type ClaudeMdTransactionResult } from '../installer/claude-md-transaction.js';
export declare const CLAUDE_MD_COORDINATOR_SCHEMA_VERSION = 1;
export interface ClaudeMdCoordinatorHandshake {
    schemaVersion: typeof CLAUDE_MD_COORDINATOR_SCHEMA_VERSION;
    engineVersion: string;
    sourceSha256: string;
}
export declare function runClaudeMdCoordinatorHandshake(): {
    exitCode: 0 | 2;
    response: ClaudeMdCoordinatorHandshake | ClaudeMdCoordinatorErrorResponse;
};
export interface ClaudeMdCoordinatorErrorResponse {
    ok: false;
    exitCode: 2 | 3;
    error: string;
    schemaVersion: typeof CLAUDE_MD_COORDINATOR_SCHEMA_VERSION;
}
export type ClaudeMdCoordinatorResponse = ClaudeMdCoordinatorErrorResponse | ClaudeMdTransactionResult;
/** Validates the versioned stdin protocol and converts every operational failure to a JSON response. */
export declare function runClaudeMdCoordinator(input: unknown): {
    exitCode: number;
    response: ClaudeMdCoordinatorResponse;
};
//# sourceMappingURL=claude-md-coordinator.d.ts.map