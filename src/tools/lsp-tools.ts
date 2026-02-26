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
import {
  lspClientManager,
  getAllServers,
  getServerForFile,
  formatHover,
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatDiagnostics,
  formatCodeActions,
  formatWorkspaceEdit,
  countEdits
} from './lsp/index.js';
import { runDirectoryDiagnostics, LSP_DIAGNOSTICS_WAIT_MS } from './diagnostics/index.js';
import { ToolDefinition } from './types.js';

/**
 * Helper to handle LSP errors gracefully.
 * Uses runWithClientLease to protect the client from idle eviction
 * while the operation is in flight.
 */
async function withLspClient<T>(
  filePath: string,
  operation: string,
  fn: (client: NonNullable<Awaited<ReturnType<typeof lspClientManager.getClientForFile>>>) => Promise<T>
): Promise<{ isError?: true; content: Array<{ type: 'text'; text: string }> }> {
  try {
    // Pre-check: is there a server for this file type?
    const serverConfig = getServerForFile(filePath);
    if (!serverConfig) {
      return {
        isError: true as const,
        content: [{
          type: 'text' as const,
          text: `No language server available for file type: ${filePath}\n\nUse lsp_servers tool to see available language servers.`
        }]
      };
    }

    const result = await lspClientManager.runWithClientLease(filePath, async (client) => {
      return fn(client);
    });
    return {
      content: [{
        type: 'text' as const,
        text: String(result)
      }]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Surface install hints for missing servers
    if (message.includes('not found')) {
      return {
        isError: true as const,
        content: [{
          type: 'text' as const,
          text: `${message}`
        }]
      };
    }
    return {
      isError: true as const,
      content: [{
        type: 'text' as const,
        text: `Error in ${operation}: ${message}`
      }]
    };
  }
}

/**
 * LSP Hover Tool - Get type information and documentation at a position
 */
export const lspHoverTool: ToolDefinition<{
  file: z.ZodString;
  line: z.ZodNumber;
  character: z.ZodNumber;
}> = {
  name: 'lsp_hover',
  description: 'Get type information, documentation, and signature at a specific position in a file. Useful for understanding what a symbol represents.',
  schema: {
    file: z.string().describe('Path to the source file'),
    line: z.number().int().min(1).describe('Line number (1-indexed)'),
    character: z.number().int().min(0).describe('Character position in the line (0-indexed)')
  },
  handler: async (args) => {
    const { file, line, character } = args;
    return withLspClient(file, 'hover', async (client) => {
      const hover = await client!.hover(file, line - 1, character);
      return formatHover(hover);
    });
  }
};

/**
 * LSP Go to Definition Tool - Jump to where a symbol is defined
 */
export const lspGotoDefinitionTool: ToolDefinition<{
  file: z.ZodString;
  line: z.ZodNumber;
  character: z.ZodNumber;
}> = {
  name: 'lsp_goto_definition',
  description: 'Find the definition location of a symbol (function, variable, class, etc.). Returns the file path and position where the symbol is defined.',
  schema: {
    file: z.string().describe('Path to the source file'),
    line: z.number().int().min(1).describe('Line number (1-indexed)'),
    character: z.number().int().min(0).describe('Character position in the line (0-indexed)')
  },
  handler: async (args) => {
    const { file, line, character } = args;
    return withLspClient(file, 'goto definition', async (client) => {
      const locations = await client!.definition(file, line - 1, character);
      return formatLocations(locations);
    });
  }
};

/**
 * LSP Find References Tool - Find all usages of a symbol
 */
export const lspFindReferencesTool: ToolDefinition<{
  file: z.ZodString;
  line: z.ZodNumber;
  character: z.ZodNumber;
  includeDeclaration: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'lsp_find_references',
  description: 'Find all references to a symbol across the codebase. Useful for understanding usage patterns and impact of changes.',
  schema: {
    file: z.string().describe('Path to the source file'),
    line: z.number().int().min(1).describe('Line number (1-indexed)'),
    character: z.number().int().min(0).describe('Character position in the line (0-indexed)'),
    includeDeclaration: z.boolean().optional().describe('Include the declaration in results (default: true)')
  },
  handler: async (args) => {
    const { file, line, character, includeDeclaration = true } = args;
    return withLspClient(file, 'find references', async (client) => {
      const locations = await client!.references(file, line - 1, character, includeDeclaration);
      if (!locations || locations.length === 0) {
        return 'No references found';
      }
      return `Found ${locations.length} reference(s):\n\n${formatLocations(locations)}`;
    });
  }
};

/**
 * LSP Document Symbols Tool - Get outline of all symbols in a file
 */
export const lspDocumentSymbolsTool: ToolDefinition<{
  file: z.ZodString;
}> = {
  name: 'lsp_document_symbols',
  description: 'Get a hierarchical outline of all symbols in a file (functions, classes, variables, etc.). Useful for understanding file structure.',
  schema: {
    file: z.string().describe('Path to the source file')
  },
  handler: async (args) => {
    const { file } = args;
    return withLspClient(file, 'document symbols', async (client) => {
      const symbols = await client!.documentSymbols(file);
      return formatDocumentSymbols(symbols);
    });
  }
};

/**
 * LSP Workspace Symbols Tool - Search symbols across workspace
 */
export const lspWorkspaceSymbolsTool: ToolDefinition<{
  query: z.ZodString;
  file: z.ZodString;
}> = {
  name: 'lsp_workspace_symbols',
  description: 'Search for symbols (functions, classes, etc.) across the entire workspace by name. Useful for finding definitions without knowing the exact file.',
  schema: {
    query: z.string().describe('Symbol name or pattern to search'),
    file: z.string().describe('Any file in the workspace (used to determine which language server to use)')
  },
  handler: async (args) => {
    const { query, file } = args;
    return withLspClient(file, 'workspace symbols', async (client) => {
      const symbols = await client!.workspaceSymbols(query);
      if (!symbols || symbols.length === 0) {
        return `No symbols found matching: ${query}`;
      }
      return `Found ${symbols.length} symbol(s) matching "${query}":\n\n${formatWorkspaceSymbols(symbols)}`;
    });
  }
};

/**
 * LSP Diagnostics Tool - Get errors, warnings, and hints
 */
export const lspDiagnosticsTool: ToolDefinition<{
  file: z.ZodString;
  severity: z.ZodOptional<z.ZodEnum<['error', 'warning', 'info', 'hint']>>;
}> = {
  name: 'lsp_diagnostics',
  description: 'Get language server diagnostics (errors, warnings, hints) for a file. Useful for finding issues without running the compiler.',
  schema: {
    file: z.string().describe('Path to the source file'),
    severity: z.enum(['error', 'warning', 'info', 'hint']).optional().describe('Filter by severity level')
  },
  handler: async (args) => {
    const { file, severity } = args;
    return withLspClient(file, 'diagnostics', async (client) => {
      // Open the document to trigger diagnostics
      await client!.openDocument(file);
      // Wait a bit for diagnostics to be published
      await new Promise(resolve => setTimeout(resolve, LSP_DIAGNOSTICS_WAIT_MS));

      let diagnostics = client!.getDiagnostics(file);

      if (severity) {
        const severityMap: Record<string, number> = {
          'error': 1,
          'warning': 2,
          'info': 3,
          'hint': 4
        };
        const severityNum = severityMap[severity];
        diagnostics = diagnostics.filter(d => d.severity === severityNum);
      }

      if (diagnostics.length === 0) {
        return severity
          ? `No ${severity} diagnostics in ${file}`
          : `No diagnostics in ${file}`;
      }

      return `Found ${diagnostics.length} diagnostic(s):\n\n${formatDiagnostics(diagnostics, file)}`;
    });
  }
};

/**
 * LSP Servers Tool - List available language servers
 */
export const lspServersTool: ToolDefinition<Record<string, never>> = {
  name: 'lsp_servers',
  description: 'List all known language servers and their installation status. Shows which servers are available and how to install missing ones.',
  schema: {},
  handler: async () => {
    const servers = getAllServers();

    const installed = servers.filter(s => s.installed);
    const notInstalled = servers.filter(s => !s.installed);

    let text = '## Language Server Status\n\n';

    if (installed.length > 0) {
      text += '### Installed:\n';
      for (const server of installed) {
        text += `- ${server.name} (${server.command})\n`;
        text += `  Extensions: ${server.extensions.join(', ')}\n`;
      }
      text += '\n';
    }

    if (notInstalled.length > 0) {
      text += '### Not Installed:\n';
      for (const server of notInstalled) {
        text += `- ${server.name} (${server.command})\n`;
        text += `  Extensions: ${server.extensions.join(', ')}\n`;
        text += `  Install: ${server.installHint}\n`;
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text
      }]
    };
  }
};

/**
 * LSP Prepare Rename Tool - Check if rename is valid
 */
export const lspPrepareRenameTool: ToolDefinition<{
  file: z.ZodString;
  line: z.ZodNumber;
  character: z.ZodNumber;
}> = {
  name: 'lsp_prepare_rename',
  description: 'Check if a symbol at the given position can be renamed. Returns the range of the symbol if rename is possible.',
  schema: {
    file: z.string().describe('Path to the source file'),
    line: z.number().int().min(1).describe('Line number (1-indexed)'),
    character: z.number().int().min(0).describe('Character position in the line (0-indexed)')
  },
  handler: async (args) => {
    const { file, line, character } = args;
    return withLspClient(file, 'prepare rename', async (client) => {
      const range = await client!.prepareRename(file, line - 1, character);
      if (!range) {
        return 'Cannot rename symbol at this position';
      }
      return `Rename possible. Symbol range: line ${range.start.line + 1}, col ${range.start.character + 1} to line ${range.end.line + 1}, col ${range.end.character + 1}`;
    });
  }
};

/**
 * LSP Rename Tool - Rename a symbol across all files
 */
export const lspRenameTool: ToolDefinition<{
  file: z.ZodString;
  line: z.ZodNumber;
  character: z.ZodNumber;
  newName: z.ZodString;
}> = {
  name: 'lsp_rename',
  description: 'Rename a symbol (variable, function, class, etc.) across all files in the project. Returns the list of edits that would be made. Does NOT apply the changes automatically.',
  schema: {
    file: z.string().describe('Path to the source file'),
    line: z.number().int().min(1).describe('Line number (1-indexed)'),
    character: z.number().int().min(0).describe('Character position in the line (0-indexed)'),
    newName: z.string().min(1).describe('New name for the symbol')
  },
  handler: async (args) => {
    const { file, line, character, newName } = args;
    return withLspClient(file, 'rename', async (client) => {
      const edit = await client!.rename(file, line - 1, character, newName);
      if (!edit) {
        return 'Rename failed or no edits returned';
      }

      const { files, edits } = countEdits(edit);
      return `Rename to "${newName}" would affect ${files} file(s) with ${edits} edit(s):\n\n${formatWorkspaceEdit(edit)}\n\nNote: Use the Edit tool to apply these changes.`;
    });
  }
};

/**
 * LSP Code Actions Tool - Get available refactoring and quick-fix actions
 */
export const lspCodeActionsTool: ToolDefinition<{
  file: z.ZodString;
  startLine: z.ZodNumber;
  startCharacter: z.ZodNumber;
  endLine: z.ZodNumber;
  endCharacter: z.ZodNumber;
}> = {
  name: 'lsp_code_actions',
  description: 'Get available code actions (refactorings, quick fixes) for a selection. Returns a list of possible actions that can be applied.',
  schema: {
    file: z.string().describe('Path to the source file'),
    startLine: z.number().int().min(1).describe('Start line of selection (1-indexed)'),
    startCharacter: z.number().int().min(0).describe('Start character of selection (0-indexed)'),
    endLine: z.number().int().min(1).describe('End line of selection (1-indexed)'),
    endCharacter: z.number().int().min(0).describe('End character of selection (0-indexed)')
  },
  handler: async (args) => {
    const { file, startLine, startCharacter, endLine, endCharacter } = args;
    return withLspClient(file, 'code actions', async (client) => {
      const range = {
        start: { line: startLine - 1, character: startCharacter },
        end: { line: endLine - 1, character: endCharacter }
      };
      const actions = await client!.codeActions(file, range);
      return formatCodeActions(actions);
    });
  }
};

/**
 * LSP Code Action Resolve Tool - Get details of a code action
 */
export const lspCodeActionResolveTool: ToolDefinition<{
  file: z.ZodString;
  startLine: z.ZodNumber;
  startCharacter: z.ZodNumber;
  endLine: z.ZodNumber;
  endCharacter: z.ZodNumber;
  actionIndex: z.ZodNumber;
}> = {
  name: 'lsp_code_action_resolve',
  description: 'Get the full edit details for a specific code action. Use after lsp_code_actions to see what changes an action would make.',
  schema: {
    file: z.string().describe('Path to the source file'),
    startLine: z.number().int().min(1).describe('Start line of selection (1-indexed)'),
    startCharacter: z.number().int().min(0).describe('Start character of selection (0-indexed)'),
    endLine: z.number().int().min(1).describe('End line of selection (1-indexed)'),
    endCharacter: z.number().int().min(0).describe('End character of selection (0-indexed)'),
    actionIndex: z.number().int().min(1).describe('Index of the action (1-indexed, from lsp_code_actions output)')
  },
  handler: async (args) => {
    const { file, startLine, startCharacter, endLine, endCharacter, actionIndex } = args;
    return withLspClient(file, 'code action resolve', async (client) => {
      const range = {
        start: { line: startLine - 1, character: startCharacter },
        end: { line: endLine - 1, character: endCharacter }
      };
      const actions = await client!.codeActions(file, range);

      if (!actions || actions.length === 0) {
        return 'No code actions available';
      }

      if (actionIndex < 1 || actionIndex > actions.length) {
        return `Invalid action index. Available actions: 1-${actions.length}`;
      }

      const action = actions[actionIndex - 1];

      let result = `Action: ${action.title}\n`;
      if (action.kind) result += `Kind: ${action.kind}\n`;
      if (action.isPreferred) result += `(Preferred)\n`;

      if (action.edit) {
        result += `\nEdits:\n${formatWorkspaceEdit(action.edit)}`;
      }

      if (action.command) {
        result += `\nCommand: ${action.command.title} (${action.command.command})`;
      }

      return result;
    });
  }
};

/**
 * LSP Diagnostics Directory Tool - Get project-level diagnostics
 */
export const lspDiagnosticsDirectoryTool: ToolDefinition<{
  directory: z.ZodString;
  strategy: z.ZodOptional<z.ZodEnum<['tsc', 'lsp', 'auto']>>;
}> = {
  name: 'lsp_diagnostics_directory',
  description: 'Run project-level diagnostics on a directory using tsc --noEmit (preferred) or LSP iteration (fallback). Useful for checking the entire codebase for errors.',
  schema: {
    directory: z.string().describe('Project directory to check'),
    strategy: z.enum(['tsc', 'lsp', 'auto']).optional().describe('Strategy to use: "tsc" (TypeScript compiler), "lsp" (Language Server iteration), or "auto" (default: auto-detect)')
  },
  handler: async (args) => {
    const { directory, strategy = 'auto' } = args;
    try {
      const result = await runDirectoryDiagnostics(directory, strategy);

      let output = `## Directory Diagnostics\n\n`;
      output += `Strategy: ${result.strategy}\n`;
      output += `Summary: ${result.summary}\n\n`;

      if (result.errorCount > 0 || result.warningCount > 0) {
        output += `### Diagnostics\n\n${result.diagnostics}`;
      } else {
        output += result.diagnostics;
      }

      return {
        content: [{
          type: 'text' as const,
          text: output
        }]
      };
    } catch (error) {
      return {
        isError: true as const,
        content: [{
          type: 'text' as const,
          text: `Error running directory diagnostics: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

/**
 * Get all LSP tool definitions
 */
export const lspTools = [
  lspHoverTool,
  lspGotoDefinitionTool,
  lspFindReferencesTool,
  lspDocumentSymbolsTool,
  lspWorkspaceSymbolsTool,
  lspDiagnosticsTool,
  lspDiagnosticsDirectoryTool,
  lspServersTool,
  lspPrepareRenameTool,
  lspRenameTool,
  lspCodeActionsTool,
  lspCodeActionResolveTool
];
