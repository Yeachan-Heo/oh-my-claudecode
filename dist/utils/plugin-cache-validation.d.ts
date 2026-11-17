import { type BigIntStats } from 'fs';
export declare function isOmcPluginCacheIdentity(pluginName: string, marketplace: string): boolean;
export declare function sameFileSystemIdentity(left: BigIntStats, right: BigIntStats): boolean;
export declare function hasAncestorWithIdentity(path: string, identity: BigIntStats): boolean;
export declare function firstChildBelowDirectoryIdentity(path: string, directoryIdentity: BigIntStats): string | undefined;
/** Includes the server and share, which win32.parse omits for extended UNC roots. */
export declare function pathRootForTraversal(path: string): string;
/**
 * True when `path` is a usable plugin root. When supplied, the stale identity
 * also prevents required paths from traversing the version being demoted.
 */
export declare function isUsableVersionPath(path: string, staleVersionIdentity?: BigIntStats): boolean;
export declare function isUsableGenericPluginTarget(target: string, staleVersionIdentity: BigIntStats): boolean;
//# sourceMappingURL=plugin-cache-validation.d.ts.map