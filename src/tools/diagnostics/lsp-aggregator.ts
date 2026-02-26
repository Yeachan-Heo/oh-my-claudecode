/**
 * LSP Aggregator - Fallback strategy for directory diagnostics
 *
 * When tsc is not available or not suitable, iterate through files
 * and collect LSP diagnostics for each.
 */

import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { lspClientManager } from '../lsp/index.js';
import type { Diagnostic } from '../lsp/index.js';
import { LSP_DIAGNOSTICS_WAIT_MS } from './index.js';

export interface LspDiagnosticWithFile {
  file: string;
  diagnostic: Diagnostic;
}

export interface LspAggregationResult {
  success: boolean;
  diagnostics: LspDiagnosticWithFile[];
  errorCount: number;
  warningCount: number;
  filesChecked: number;
}

/**
 * Recursively find files with given extensions
 */
function findFiles(directory: string, extensions: string[], ignoreDirs: string[] = []): string[] {
  const results: string[] = [];
  const ignoreDirSet = new Set(ignoreDirs);

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            // Skip ignored directories
            if (!ignoreDirSet.has(entry)) {
              walk(fullPath);
            }
          } else if (stat.isFile()) {
            const ext = extname(fullPath);
            if (extensions.includes(ext)) {
              results.push(fullPath);
            }
          }
        } catch (_error) {
          // Skip files/dirs we can't access
          continue;
        }
      }
    } catch (_error) {
      // Skip directories we can't read
      return;
    }
  }

  walk(directory);
  return results;
}

/**
 * Run LSP diagnostics on all TypeScript/JavaScript files in a directory
 * @param directory - Project directory to scan
 * @param extensions - File extensions to check (default: ['.ts', '.tsx', '.js', '.jsx'])
 * @returns Aggregated diagnostics from all files
 */
export async function runLspAggregatedDiagnostics(
  directory: string,
  extensions: string[] = ['.ts', '.tsx', '.js', '.jsx']
): Promise<LspAggregationResult> {
  // Find all matching files
  const files = findFiles(directory, extensions, ['node_modules', 'dist', 'build', '.git']);

  const allDiagnostics: LspDiagnosticWithFile[] = [];
  let filesChecked = 0;

  for (const file of files) {
    try {
      await lspClientManager.runWithClientLease(file, async (client) => {
        // Open document to trigger diagnostics
        await client.openDocument(file);

        // Wait for the server to publish diagnostics via textDocument/publishDiagnostics
        // notification instead of using a fixed delay. Falls back to LSP_DIAGNOSTICS_WAIT_MS
        // as a timeout so we don't hang forever on servers that omit the notification.
        await client.waitForDiagnostics(file, LSP_DIAGNOSTICS_WAIT_MS);

        // Get diagnostics for this file
        const diagnostics = client.getDiagnostics(file);

        // Add to aggregated results
        for (const diagnostic of diagnostics) {
          allDiagnostics.push({
            file,
            diagnostic
          });
        }

        filesChecked++;
      });
    } catch (_error) {
      // Skip files that fail (including "no server available")
      continue;
    }
  }

  // Count errors and warnings
  const errorCount = allDiagnostics.filter(d => d.diagnostic.severity === 1).length;
  const warningCount = allDiagnostics.filter(d => d.diagnostic.severity === 2).length;

  return {
    success: errorCount === 0,
    diagnostics: allDiagnostics,
    errorCount,
    warningCount,
    filesChecked
  };
}
