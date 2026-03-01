// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract, resolveCliBinaryPath, clearResolvedPathCache, type CliAgentType } from './model-contract.js';
import { spawnSync } from 'child_process';
import { resolveCliBinaryPath } from './model-contract.js';

export interface CliInfo {
  available: boolean;
  version?: string;
  path?: string;
}

export function detectCli(binary: string): CliInfo {
  try {
    const resolvedPath = resolveCliBinaryPath(binary);
    const versionResult = spawnSync(resolvedPath, ['--version'], { timeout: 5000 });
    if (versionResult.status === 0) {
      return {
        available: true,
        version: versionResult.stdout?.toString().trim(),
        path: resolvedPath,
      };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export function detectAllClis(): Record<string, CliInfo> {
  return {
    claude: detectCli('claude'),
    codex: detectCli('codex'),
    gemini: detectCli('gemini'),
  };
}
