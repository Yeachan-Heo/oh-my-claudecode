/**
 * LSP Utilities
 *
 * Helper functions for formatting LSP results and converting between formats.
 */

import type { Hover, Location, DocumentSymbol, SymbolInformation, Diagnostic, CodeAction, WorkspaceEdit, Range } from './client.js';

/**
 * Symbol kind names (LSP spec)
 */
const SYMBOL_KINDS: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter'
};

/**
 * Diagnostic severity names
 */
const SEVERITY_NAMES: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Information',
  4: 'Hint'
};

/**
 * Convert URI to file path
 */
export function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice(7));
  }
  return uri;
}

/**
 * Format a position for display
 */
export function formatPosition(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

/**
 * Format a range for display
 */
export function formatRange(range: Range): string {
  const start = formatPosition(range.start.line, range.start.character);
  const end = formatPosition(range.end.line, range.end.character);
  return start === end ? start : `${start}-${end}`;
}

/**
 * Format a location for display
 */
export function formatLocation(location: Location): string {
  const uri = location.uri || (location as any).targetUri;
  if (!uri) return 'Unknown location';
  const path = uriToPath(uri);
  const locationRange = location.range || (location as any).targetRange || (location as any).targetSelectionRange;
  if (!locationRange) return path;
  const range = formatRange(locationRange);
  return `${path}:${range}`;
}

/**
 * Format hover content
 */
export function formatHover(hover: Hover | null): string {
  if (!hover) return 'No hover information available';

  let text = '';

  if (typeof hover.contents === 'string') {
    text = hover.contents;
  } else if (Array.isArray(hover.contents)) {
    text = hover.contents.map(c => {
      if (typeof c === 'string') return c;
      return c.value;
    }).join('\n\n');
  } else if ('value' in hover.contents) {
    text = hover.contents.value;
  }

  if (hover.range) {
    text += `\n\nRange: ${formatRange(hover.range)}`;
  }

  return text || 'No hover information available';
}

/**
 * Format locations array
 */
export function formatLocations(locations: Location | Location[] | null): string {
  if (!locations) return 'No locations found';

  const locs = Array.isArray(locations) ? locations : [locations];

  if (locs.length === 0) return 'No locations found';

  return locs.map(loc => formatLocation(loc)).join('\n');
}

/**
 * Format document symbols (hierarchical)
 */
export function formatDocumentSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null, indent = 0): string {
  if (!symbols || symbols.length === 0) return 'No symbols found';

  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const symbol of symbols) {
    const kind = SYMBOL_KINDS[symbol.kind] || 'Unknown';

    if ('range' in symbol) {
      // DocumentSymbol
      const range = formatRange(symbol.range);
      lines.push(`${prefix}${kind}: ${symbol.name} [${range}]`);

      if (symbol.children && symbol.children.length > 0) {
        lines.push(formatDocumentSymbols(symbol.children, indent + 1));
      }
    } else {
      // SymbolInformation
      const loc = formatLocation(symbol.location);
      const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
      lines.push(`${prefix}${kind}: ${symbol.name}${container} [${loc}]`);
    }
  }

  return lines.join('\n');
}

/**
 * Format workspace symbols
 */
export function formatWorkspaceSymbols(symbols: SymbolInformation[] | null): string {
  if (!symbols || symbols.length === 0) return 'No symbols found';

  const lines = symbols.map(symbol => {
    const kind = SYMBOL_KINDS[symbol.kind] || 'Unknown';
    const loc = formatLocation(symbol.location);
    const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
    return `${kind}: ${symbol.name}${container}\n  ${loc}`;
  });

  return lines.join('\n\n');
}

/**
 * Format diagnostics
 */
export function formatDiagnostics(diagnostics: Diagnostic[], filePath?: string): string {
  if (diagnostics.length === 0) return 'No diagnostics';

  const lines = diagnostics.map(diag => {
    const severity = SEVERITY_NAMES[diag.severity || 1] || 'Unknown';
    const range = formatRange(diag.range);
    const source = diag.source ? `[${diag.source}]` : '';
    const code = diag.code ? ` (${diag.code})` : '';
    const location = filePath ? `${filePath}:${range}` : range;

    return `${severity}${code}${source}: ${diag.message}\n  at ${location}`;
  });

  return lines.join('\n\n');
}

/**
 * Format code actions
 */
export function formatCodeActions(actions: CodeAction[] | null): string {
  if (!actions || actions.length === 0) return 'No code actions available';

  const lines = actions.map((action, index) => {
    const preferred = action.isPreferred ? ' (preferred)' : '';
    const kind = action.kind ? ` [${action.kind}]` : '';
    return `${index + 1}. ${action.title}${kind}${preferred}`;
  });

  return lines.join('\n');
}

/**
 * Format workspace edit
 */
export function formatWorkspaceEdit(edit: WorkspaceEdit | null): string {
  if (!edit) return 'No edits';

  const lines: string[] = [];

  if (edit.changes) {
    for (const [uri, changes] of Object.entries(edit.changes)) {
      const path = uriToPath(uri);
      lines.push(`File: ${path}`);
      for (const change of changes) {
        const range = formatRange(change.range);
        const preview = change.newText.length > 50
          ? change.newText.slice(0, 50) + '...'
          : change.newText;
        lines.push(`  ${range}: "${preview}"`);
      }
    }
  }

  if (edit.documentChanges) {
    for (const docChange of edit.documentChanges) {
      const path = uriToPath(docChange.textDocument.uri);
      lines.push(`File: ${path}`);
      for (const change of docChange.edits) {
        const range = formatRange(change.range);
        const preview = change.newText.length > 50
          ? change.newText.slice(0, 50) + '...'
          : change.newText;
        lines.push(`  ${range}: "${preview}"`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No edits';
}

/**
 * Count edits in a workspace edit
 */
export function countEdits(edit: WorkspaceEdit | null): { files: number; edits: number } {
  if (!edit) return { files: 0, edits: 0 };

  let files = 0;
  let edits = 0;

  if (edit.changes) {
    files += Object.keys(edit.changes).length;
    edits += Object.values(edit.changes).reduce((sum, changes) => sum + changes.length, 0);
  }

  if (edit.documentChanges) {
    files += edit.documentChanges.length;
    edits += edit.documentChanges.reduce((sum, doc) => sum + doc.edits.length, 0);
  }

  return { files, edits };
}
