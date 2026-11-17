export declare const PACKAGE_ROOT: string;
export declare const HOOKS_JSON_PATH: string;
export declare const PLUGIN_JSON_PATH: string;
export declare const MCP_JSON_PATH: string;
export type McpServerConfig = {
    command?: unknown;
    args?: unknown;
};
export type McpJson = {
    mcpServers?: Record<string, McpServerConfig>;
};
export type PluginJson = {
    hooks?: unknown;
    mcpServers?: unknown;
};
export declare function readMcpServersFromPath(filePath: string): Record<string, McpServerConfig>;
export declare function readPluginMcpServers(): Record<string, McpServerConfig>;
export declare function referencesStandardHooksManifest(value: unknown): boolean;
export declare function referencesRootMcpConfig(value: unknown): boolean;
export declare function listSourceControlledPackageFiles(): string[];
//# sourceMappingURL=npm-package-surface-helpers.d.ts.map