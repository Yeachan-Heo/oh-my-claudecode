/**
 * LSP Server Configurations
 *
 * Defines known language servers and their configurations.
 * Supports auto-detection and installation hints.
 */
export interface LspServerConfig {
    name: string;
    command: string;
    args: string[];
    extensions: string[];
    installHint: string;
    initializationOptions?: Record<string, unknown>;
}
/**
 * Known LSP servers and their configurations
 */
export declare const LSP_SERVERS: Record<string, LspServerConfig>;
/**
 * Check if a command exists in PATH
 */
export declare function commandExists(command: string): boolean;
/**
 * Get the LSP server config for a file based on its extension
 */
export declare function getServerForFile(filePath: string): LspServerConfig | null;
/**
 * Get all available servers (installed and not installed)
 */
export declare function getAllServers(): Array<LspServerConfig & {
    installed: boolean;
}>;
/**
 * Get the appropriate server for a language
 */
export declare function getServerForLanguage(language: string): LspServerConfig | null;
//# sourceMappingURL=servers.d.ts.map