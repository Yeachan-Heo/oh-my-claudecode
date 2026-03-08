// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract, type CliAgentType } from './model-contract.js';
import { spawnSync } from 'child_process';

export interface CliInfo {
  available: boolean;
  version?: string;
  path?: string;
}

export function detectCli(binary: string): CliInfo {
  try {
    const versionResult = spawnSync(binary, ['--version'], { timeout: 5000 });
    if (versionResult.status === 0) {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      const pathResult = spawnSync(finder, [binary], { timeout: 5000 });
      return {
        available: true,
        version: versionResult.stdout?.toString().trim(),
        path: pathResult.stdout?.toString().trim(),
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
