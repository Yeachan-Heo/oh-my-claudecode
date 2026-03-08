#!/usr/bin/env node
/**
 * Team MCP Server - tmux CLI worker runtime tools
 */
type DeprecatedTeamToolName = 'omc_run_team_start' | 'omc_run_team_status' | 'omc_run_team_wait' | 'omc_run_team_cleanup';
export declare function createDeprecatedCliOnlyEnvelope(toolName: DeprecatedTeamToolName): {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError: true;
};
export declare function createDeprecatedCliOnlyEnvelopeWithArgs(toolName: DeprecatedTeamToolName, args?: unknown): {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError: true;
};
export declare function handleStatus(args: unknown): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
export declare function handleWait(args: unknown): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
export declare function handleCleanup(args: unknown): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
export {};
//# sourceMappingURL=team-server.d.ts.map