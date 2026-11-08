import { execFileSync } from 'node:child_process';
/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export declare function pathIdentity(path: string): string;
export declare function processStartIdentities(pids: number[], exec?: typeof execFileSync): Map<number, string>;
export interface CacheOccupancyRecord {
    version: 1;
    pid: number;
    processStartIdentity: string;
    pluginRoot: string;
    updatedAt: string;
}
export declare function getCacheOccupancyDir(configDir?: string): string;
export declare function publishCacheOccupancy(pluginRoot: string, configDir?: string, precomputedIdentity?: string): Promise<boolean>;
export interface ReadOccupiedPluginRootsOptions {
    /** Precomputed pid→identity map (same-process reuse, issue #3995). Records
     *  whose pid is absent from the map are kept conservatively. */
    identities?: Map<number, string>;
    /** Extra pids to resolve in the fresh batched identity probe. */
    includePids?: number[];
}
export declare function readOccupiedPluginRoots(configDir?: string, options?: ReadOccupiedPluginRootsOptions): {
    roots: Set<string>;
    unavailable: boolean;
    identities: Map<number, string>;
};
//# sourceMappingURL=cache-occupancy.d.ts.map