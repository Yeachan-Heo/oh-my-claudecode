import { spawnSync } from 'child_process';
import { isAbsolute, normalize } from 'path';
import { resolvedEnv } from './shell-path.js';
import { validateTeamName } from './team-name.js';

export type CliAgentType = 'claude' | 'codex' | 'gemini';

export interface CliAgentContract {
  agentType: CliAgentType;
  binary: string;
  installInstructions: string;
  buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
  parseOutput(rawOutput: string): string;
  /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
  supportsPromptMode?: boolean;
  /** CLI flag for prompt mode (e.g., '-p' for gemini) */
  promptModeFlag?: string;
}

export interface WorkerLaunchConfig {
  teamName: string;
  workerName: string;
  model?: string;
  cwd: string;
  extraFlags?: string[];
}

const CONTRACTS: Record<CliAgentType, CliAgentContract> = {
  claude: {
    agentType: 'claude',
    binary: 'claude',
    installInstructions: 'Install Claude CLI: https://claude.ai/download',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  codex: {
    agentType: 'codex',
    binary: 'codex',
    installInstructions: 'Install Codex CLI: npm install -g @openai/codex',
    supportsPromptMode: true,
    // Codex accepts prompt as a positional argument (no flag needed):
    //   codex [OPTIONS] [PROMPT]
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      // Codex outputs JSONL — extract the last assistant message
      const lines = rawOutput.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'message' && parsed.role === 'assistant') {
            return parsed.content ?? rawOutput;
          }
          if (parsed.type === 'result' || parsed.output) {
            return parsed.output ?? parsed.result ?? rawOutput;
          }
        } catch {
          // not JSON, skip
        }
      }
      return rawOutput.trim();
    },
  },
  gemini: {
    agentType: 'gemini',
    binary: 'gemini',
    installInstructions: 'Install Gemini CLI: npm install -g @google/gemini-cli',
    supportsPromptMode: true,
    promptModeFlag: '-p',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--yolo'];
      const effectiveModel = model || 'gemini-2.5-pro';
      args.push('--model', effectiveModel);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
};

/**
 * Patterns matching directories that must never contain trusted CLI binaries.
 * These locations are world-writable and trivially exploitable for PATH hijacking.
 */
const UNTRUSTED_PATH_PATTERNS: RegExp[] = [
  /^\/tmp\b/,
  /^\/var\/tmp\b/,
  /^\/dev\/shm\b/,
];

/**
 * Well-known prefixes where CLI binaries are typically installed.
 * Binaries outside these directories produce a warning but are not blocked,
 * supporting custom user setups while maintaining audit visibility.
 *
 * Extend via `OMC_TRUSTED_CLI_DIRS` (colon-separated) for non-standard layouts.
 */
function getTrustedPrefixes(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const prefixes = [
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/opt/',
    '/snap/',
    '/nix/',
    '/opt/homebrew/',
  ];
  if (home) {
    prefixes.push(
      `${home}/.local/bin`,
      `${home}/.npm-global/`,
      `${home}/.nvm/`,
      `${home}/.volta/`,
      `${home}/.fnm/`,
      `${home}/.cargo/bin`,
      `${home}/.bun/bin`,
      `${home}/n/bin`,
    );
  }
  const extra = process.env.OMC_TRUSTED_CLI_DIRS;
  if (extra) {
    for (const dir of extra.split(':').filter(Boolean)) {
      if (isAbsolute(dir)) prefixes.push(dir);
    }
  }
  return prefixes;
}

/** Session-scoped cache of binary-name → resolved-absolute-path. */
const resolvedPathCache = new Map<string, string>();

/**
 * Resolve a CLI binary name to its absolute filesystem path with security
 * validation. The result is cached for the lifetime of this process so that
 * subsequent calls are deterministic (PATH is only consulted once per binary).
 *
 * Security guarantees:
 *  - Rejects binary names containing path separators or shell metacharacters.
 *  - Rejects paths in world-writable temp directories (/tmp, /var/tmp, /dev/shm).
 *  - Rejects non-absolute resolution results.
 *  - Logs a warning for binaries outside well-known installation prefixes.
 *
 * @returns Absolute path to the binary.
 * @throws  If the binary is not found, the name is invalid, or the resolved
 *          path fails validation.
 */
export function resolveCliBinaryPath(binary: string): string {
  const cached = resolvedPathCache.get(binary);
  if (cached) return cached;

  if (/[/\\;|&$`()"'\s]/.test(binary)) {
    throw new Error(`Invalid CLI binary name: "${binary}"`);
  }

  const whichCmd =
    process.platform === 'win32' && !process.env.MSYSTEM ? 'where' : 'which';
  const result = spawnSync(whichCmd, [binary], {
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: resolvedEnv(),
  });

  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const resolvedPath = normalize(result.stdout.trim().split('\n')[0].trim());

  if (!isAbsolute(resolvedPath)) {
    throw new Error(
      `CLI binary '${binary}' resolved to a relative path: "${resolvedPath}". ` +
        'Only absolute paths are accepted.',
    );
  }

  for (const pattern of UNTRUSTED_PATH_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      throw new Error(
        `CLI binary '${binary}' resolved to an untrusted location: "${resolvedPath}". ` +
          'Binaries in temporary directories are not allowed for security reasons.',
      );
    }
  }

  const trustedPrefixes = getTrustedPrefixes();
  const inTrustedDir = trustedPrefixes.some((p) => resolvedPath.startsWith(p));
  if (!inTrustedDir) {
    console.warn(
      `[omc:cli-security] CLI binary '${binary}' resolved to '${resolvedPath}' ` +
        'which is not in a standard installation directory. ' +
        'This may indicate PATH manipulation. ' +
        `Expected prefixes include: ${trustedPrefixes.slice(0, 5).join(', ')}, ...`,
    );
  }

  resolvedPathCache.set(binary, resolvedPath);
  return resolvedPath;
}

/** Clear the resolved-path cache (for testing or session reset). */
export function clearResolvedPathCache(): void {
  resolvedPathCache.clear();
}

/** @internal Exposed for testing only. */
export const _testInternals = {
  UNTRUSTED_PATH_PATTERNS,
  getTrustedPrefixes,
};

export function getContract(agentType: CliAgentType): CliAgentContract {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
  }
  return contract;
}

export function isCliAvailable(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  try {
    const resolvedBinary = resolveCliBinaryPath(contract.binary);
    const result = spawnSync(resolvedBinary, ['--version'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function validateCliAvailable(agentType: CliAgentType): void {
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}

export function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}

export function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const resolvedBinary = resolveCliBinaryPath(contract.binary);
  const args = buildLaunchArgs(agentType, config);
  return [resolvedBinary, ...args];
}

export function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string {
  return buildWorkerArgv(agentType, config)
    .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
    .join(' ');
}

export function getWorkerEnv(teamName: string, workerName: string, agentType: CliAgentType): Record<string, string> {
  validateTeamName(teamName);
  const workerEnv: Record<string, string> = {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType,
  };

  // Keep worker spawn PATH aligned with CLI preflight checks (validateCliAvailable)
  // while preserving key casing where possible (PATH vs Path).
  const env = resolvedEnv();
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  if (pathKey) {
    const pathValue = env[pathKey];
    if (typeof pathValue === 'string') {
      workerEnv[pathKey] = pathValue;
    }
  }

  return workerEnv;
}

export function parseCliOutput(agentType: CliAgentType, rawOutput: string): string {
  return getContract(agentType).parseOutput(rawOutput);
}

/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export function isPromptModeAgent(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}

/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
export function getPromptModeArgs(agentType: CliAgentType, instruction: string): string[] {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  // If a flag is defined (e.g. gemini's '-p'), prepend it; otherwise the
  // instruction is passed as a positional argument (e.g. codex [PROMPT]).
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}
