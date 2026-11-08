export interface UnifiedMcpRegistryEntry {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    url?: string;
    type?: string;
    timeout?: number;
}
export type UnifiedMcpRegistry = Record<string, UnifiedMcpRegistryEntry>;
export interface UnifiedMcpRegistrySyncResult {
    registryPath: string;
    claudeConfigPath: string;
    codexConfigPath: string;
    registryExists: boolean;
    bootstrappedFromClaude: boolean;
    serverNames: string[];
    claudeChanged: boolean;
    codexChanged: boolean;
}
export interface UnifiedMcpRegistryStatus {
    registryPath: string;
    claudeConfigPath: string;
    codexConfigPath: string;
    registryExists: boolean;
    serverNames: string[];
    claudeMissing: string[];
    claudeMismatched: string[];
    codexMissing: string[];
    codexMismatched: string[];
}
export declare function getUnifiedMcpRegistryPath(): string;
export declare function getClaudeMcpConfigPath(): string;
export declare function getCodexConfigPath(): string;
export declare function extractClaudeMcpRegistry(settings: Record<string, unknown>): UnifiedMcpRegistry;
export declare function stripRetiredTeamMcpServers<T extends Record<string, unknown>>(settings: T): {
    settings: T;
    changed: boolean;
};
export declare function applyRegistryToClaudeSettings(settings: Record<string, unknown>): {
    settings: Record<string, unknown>;
    changed: boolean;
};
export declare function renderManagedCodexMcpBlock(registry: UnifiedMcpRegistry): string;
export declare function syncCodexConfigToml(existingContent: string, registry: UnifiedMcpRegistry): {
    content: string;
    changed: boolean;
};
export declare function syncUnifiedMcpRegistryTargets(settings: Record<string, unknown>): {
    settings: Record<string, unknown>;
    result: UnifiedMcpRegistrySyncResult;
};
export declare function inspectUnifiedMcpRegistrySync(): UnifiedMcpRegistryStatus;
//# sourceMappingURL=mcp-registry.d.ts.map