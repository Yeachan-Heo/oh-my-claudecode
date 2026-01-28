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
import { LSP_SERVERS } from '../lsp/servers.js';

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

let _cachedExtensions: string[] | null = null;

/**
 * Get all file extensions supported by configured LSP servers.
 * Cached at module level because LSP_SERVERS is a static configuration.
 * Call invalidateExtensionCache() if LSP_SERVERS is ever made dynamic.
 */
export function getAllSupportedExtensions(): string[] {
  if (_cachedExtensions) return _cachedExtensions;

  const extensions = new Set<string>();
  for (const config of Object.values(LSP_SERVERS)) {
    for (const ext of config.extensions) {
      extensions.add(ext);
    }
  }
  _cachedExtensions = Array.from(extensions);
  return _cachedExtensions;
}

/**
 * Invalidate the cached extensions list.
 * Call this if LSP_SERVERS is modified at runtime.
 * Currently LSP_SERVERS is a static const, so this is for future-proofing.
 */
export function invalidateExtensionCache(): void {
  _cachedExtensions = null;
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
        } catch (error) {
          // Skip files/dirs we can't access
          continue;
        }
      }
    } catch (error) {
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
 * @param extensions - File extensions to check (optional, defaults to all LSP-supported extensions)
 * @returns Aggregated diagnostics from all files
 */
export async function runLspAggregatedDiagnostics(
  directory: string,
  extensions?: string[]
): Promise<LspAggregationResult> {
  const effectiveExtensions = extensions ?? getAllSupportedExtensions();
  // Find all matching files
  const files = findFiles(directory, effectiveExtensions, ['node_modules', 'dist', 'build', '.git']);

  const allDiagnostics: LspDiagnosticWithFile[] = [];
  let filesChecked = 0;

  for (const file of files) {
    try {
      const client = await lspClientManager.getClientForFile(file);
      if (!client) {
        continue;
      }

      // Open document to trigger diagnostics
      await client.openDocument(file);

      // Wait for diagnostics to be published
      await new Promise(resolve => setTimeout(resolve, LSP_DIAGNOSTICS_WAIT_MS));

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
    } catch (error) {
      // Skip files that fail
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
