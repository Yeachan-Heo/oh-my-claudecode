/**
 * Codebase Map Generator
 *
 * Generates a compressed snapshot of the project structure on session start.
 * Injected as context to reduce blind file exploration by 30-50%.
 *
 * Issue #804 - Startup codebase map injection hook
 */
export interface CodebaseMapOptions {
    /** Maximum files to include in the map. Default: 200 */
    maxFiles?: number;
    /** Maximum directory depth to scan. Default: 4 */
    maxDepth?: number;
    /** Additional patterns to ignore (matched against entry name) */
    ignorePatterns?: string[];
    /** Whether to include package.json metadata. Default: true */
    includeMetadata?: boolean;
}
export interface CodebaseMapResult {
    /** The formatted codebase map string */
    map: string;
    /** Total source files counted */
    totalFiles: number;
    /** Whether the result was truncated due to maxFiles limit */
    truncated: boolean;
}
interface TreeNode {
    name: string;
    isDir: boolean;
    children?: TreeNode[];
}
/**
 * Determine whether a directory entry should be skipped.
 */
export declare function shouldSkipEntry(name: string, isDir: boolean, ignorePatterns: string[]): boolean;
/**
 * Recursively build a tree structure for the directory.
 */
export declare function buildTree(dir: string, depth: number, maxDepth: number, fileCount: {
    value: number;
}, maxFiles: number, ignorePatterns: string[]): TreeNode[];
/**
 * Render a tree of nodes to ASCII art lines.
 */
export declare function renderTree(nodes: TreeNode[], prefix: string, lines: string[]): void;
/**
 * Extract a short summary from package.json (name, description, key scripts).
 */
export declare function extractPackageMetadata(directory: string): string;
/**
 * Generate a compressed codebase map for the given directory.
 *
 * Returns a tree-formatted string of source files with optional project
 * metadata. Designed to be injected at session start to reduce exploratory
 * file-search tool calls by 30-50%.
 */
export declare function generateCodebaseMap(directory: string, options?: CodebaseMapOptions): CodebaseMapResult;
export {};
//# sourceMappingURL=codebase-map.d.ts.map