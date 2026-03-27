/**
 * LSP (Language Server Protocol) Tools
 *
 * Provides IDE-like capabilities to agents via real LSP server integration:
 * - Hover information
 * - Go to definition
 * - Find references
 * - Document/workspace symbols
 * - Diagnostics
 * - Rename
 * - Code actions
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
/**
 * LSP Hover Tool - Get type information and documentation at a position
 */
export declare const lspHoverTool: ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
}>;
/**
 * LSP Go to Definition Tool - Jump to where a symbol is defined
 */
export declare const lspGotoDefinitionTool: ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
}>;
/**
 * LSP Find References Tool - Find all usages of a symbol
 */
export declare const lspFindReferencesTool: ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
    includeDeclaration: z.ZodOptional<z.ZodBoolean>;
}>;
/**
 * LSP Document Symbols Tool - Get outline of all symbols in a file
 */
export declare const lspDocumentSymbolsTool: ToolDefinition<{
    file: z.ZodString;
}>;
/**
 * LSP Workspace Symbols Tool - Search symbols across workspace
 */
export declare const lspWorkspaceSymbolsTool: ToolDefinition<{
    query: z.ZodString;
    file: z.ZodString;
}>;
/**
 * LSP Diagnostics Tool - Get errors, warnings, and hints
 */
export declare const lspDiagnosticsTool: ToolDefinition<{
    file: z.ZodString;
    severity: z.ZodOptional<z.ZodEnum<['error', 'warning', 'info', 'hint']>>;
}>;
/**
 * LSP Servers Tool - List available language servers
 */
export declare const lspServersTool: ToolDefinition<Record<string, never>>;
/**
 * LSP Prepare Rename Tool - Check if rename is valid
 */
export declare const lspPrepareRenameTool: ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
}>;
/**
 * LSP Rename Tool - Rename a symbol across all files
 */
export declare const lspRenameTool: ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
    newName: z.ZodString;
}>;
/**
 * LSP Code Actions Tool - Get available refactoring and quick-fix actions
 */
export declare const lspCodeActionsTool: ToolDefinition<{
    file: z.ZodString;
    startLine: z.ZodNumber;
    startCharacter: z.ZodNumber;
    endLine: z.ZodNumber;
    endCharacter: z.ZodNumber;
}>;
/**
 * LSP Code Action Resolve Tool - Get details of a code action
 */
export declare const lspCodeActionResolveTool: ToolDefinition<{
    file: z.ZodString;
    startLine: z.ZodNumber;
    startCharacter: z.ZodNumber;
    endLine: z.ZodNumber;
    endCharacter: z.ZodNumber;
    actionIndex: z.ZodNumber;
}>;
/**
 * LSP Diagnostics Directory Tool - Get project-level diagnostics
 */
export declare const lspDiagnosticsDirectoryTool: ToolDefinition<{
    directory: z.ZodString;
    strategy: z.ZodOptional<z.ZodEnum<['tsc', 'lsp', 'auto']>>;
}>;
/**
 * Get all LSP tool definitions
 */
export declare const lspTools: (ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
}> | ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
    includeDeclaration: z.ZodOptional<z.ZodBoolean>;
}> | ToolDefinition<{
    file: z.ZodString;
}> | ToolDefinition<{
    query: z.ZodString;
    file: z.ZodString;
}> | ToolDefinition<{
    file: z.ZodString;
    severity: z.ZodOptional<z.ZodEnum<["error", "warning", "info", "hint"]>>;
}> | ToolDefinition<Record<string, never>> | ToolDefinition<{
    file: z.ZodString;
    line: z.ZodNumber;
    character: z.ZodNumber;
    newName: z.ZodString;
}> | ToolDefinition<{
    file: z.ZodString;
    startLine: z.ZodNumber;
    startCharacter: z.ZodNumber;
    endLine: z.ZodNumber;
    endCharacter: z.ZodNumber;
}> | ToolDefinition<{
    file: z.ZodString;
    startLine: z.ZodNumber;
    startCharacter: z.ZodNumber;
    endLine: z.ZodNumber;
    endCharacter: z.ZodNumber;
    actionIndex: z.ZodNumber;
}> | ToolDefinition<{
    directory: z.ZodString;
    strategy: z.ZodOptional<z.ZodEnum<["tsc", "lsp", "auto"]>>;
}>)[];
//# sourceMappingURL=lsp-tools.d.ts.map