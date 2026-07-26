import type { GraphProcessIdentity } from './runtime-types.js';
export declare class GraphPlatformError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export type GraphProcessLiveness = boolean | 'unknown';
export interface GraphPlatformAdapter {
    preflight(): GraphProcessIdentity;
    isProcessIdentityLive(identity: GraphProcessIdentity): GraphProcessLiveness;
}
export interface GraphPlatformDependencies {
    platform: NodeJS.Platform;
    pid: number;
    fileExists(path: string): boolean;
    readText(path: string): string;
    execCommand(command: string): string;
}
export declare function createGraphPlatformAdapter(overrides?: Partial<GraphPlatformDependencies>): GraphPlatformAdapter;
export declare const graphPlatform: GraphPlatformAdapter;
//# sourceMappingURL=platform.d.ts.map