/**
 * LSP Utilities
 *
 * Helper functions for formatting LSP results and converting between formats.
 */
import type { Hover, Location, DocumentSymbol, SymbolInformation, Diagnostic, CodeAction, WorkspaceEdit, Range } from './client.js';
/**
 * Convert URI to file path
 */
export declare function uriToPath(uri: string): string;
/**
 * Format a position for display
 */
export declare function formatPosition(line: number, character: number): string;
/**
 * Format a range for display
 */
export declare function formatRange(range: Range): string;
/**
 * Format a location for display
 */
export declare function formatLocation(location: Location): string;
/**
 * Format hover content
 */
export declare function formatHover(hover: Hover | null): string;
/**
 * Format locations array
 */
export declare function formatLocations(locations: Location | Location[] | null): string;
/**
 * Format document symbols (hierarchical)
 */
export declare function formatDocumentSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null, indent?: number): string;
/**
 * Format workspace symbols
 */
export declare function formatWorkspaceSymbols(symbols: SymbolInformation[] | null): string;
/**
 * Format diagnostics
 */
export declare function formatDiagnostics(diagnostics: Diagnostic[], filePath?: string): string;
/**
 * Format code actions
 */
export declare function formatCodeActions(actions: CodeAction[] | null): string;
/**
 * Format workspace edit
 */
export declare function formatWorkspaceEdit(edit: WorkspaceEdit | null): string;
/**
 * Count edits in a workspace edit
 */
export declare function countEdits(edit: WorkspaceEdit | null): {
    files: number;
    edits: number;
};
//# sourceMappingURL=utils.d.ts.map