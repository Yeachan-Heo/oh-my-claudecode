import { spawnSync } from 'child_process';
import { isAbsolute, normalize, win32 as win32Path } from 'path';
import { validateTeamName } from './team-name.js';
import { normalizeToCcAlias } from '../features/delegation-enforcer.js';
import { isBedrock, isVertexAI, isProviderSpecificModelId } from '../config/models.js';
import { isExternalLLMDisabled } from '../lib/security-config.js';

export type CliAgentType = 'claude' | 'codex' | 'gemini';

export interface CliAgentContract {
  agentType: CliAgentType;
  binary: string;
  installInstructions: string;
  buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
  parseOutput(rawOutput: string): string;
  /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
  supportsPromptMode?: boolean;
  /** CLI flag for prompt mode (e.g., '-i' for gemini) */
  promptModeFlag?: string;
}

export interface WorkerLaunchConfig {
  teamName: string;
  workerName: string;
  model?: string;
  cwd: string;
  extraFlags?: string[];
  /**
   * Optional pre-validated absolute CLI binary path.
   * Used by runtime preflight validation to ensure spawns are pinned.
   */
  resolvedBinaryPath?: string;
}

/** @deprecated Backward-compat shim for older team API consumers. */
export interface CliBinaryValidation {
  valid: boolean;
  binary: string;
  resolvedPath?: string;
  reason?: string;
}

const resolvedPathCache = new Map<string, string>();

const UNTRUSTED_PATH_PATTERNS: RegExp[] = [
  /^\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/dev\/shm(\/|$)/,
];

function getTrustedPrefixes(): string[] {
  const trusted = [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/',
  ];

  const home = process.env.HOME;
  if (home) {
    trusted.push(`${home}/.local/bin`);
    trusted.push(`${home}/.nvm/`);
    trusted.push(`${home}/.cargo/bin`);
  }

  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? '')
    .split(':')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => isAbsolute(part));

  trusted.push(...custom);
  return trusted;
}

function isTrustedPrefix(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  return getTrustedPrefixes().some(prefix => normalized.startsWith(normalize(prefix)));
}

function assertBinaryName(binary: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) {
    throw new Error(`Invalid CLI binary name: ${binary}`);
  }
}

/** @deprecated Backward-compat shim; non-interactive shells should generally skip RC files. */
export function shouldLoadShellRc(): boolean {
  return false;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function resolveCliBinaryPath(binary: string): string {
  assertBinaryName(binary);
  const cached = resolvedPathCache.get(binary);
  if (cached) return cached;

  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [binary], {
    timeout: 5000,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const stdout = result.stdout?.toString().trim() ?? '';
  const firstLine = stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  if (!firstLine) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const resolvedPath = normalize(firstLine);
  if (!isAbsolute(resolvedPath)) {
    throw new Error(`Resolved CLI binary '${binary}' to relative path`);
  }

  if (UNTRUSTED_PATH_PATTERNS.some(pattern => pattern.test(resolvedPath))) {
    throw new Error(`Resolved CLI binary '${binary}' to untrusted location: ${resolvedPath}`);
  }

  if (!isTrustedPrefix(resolvedPath)) {
    console.warn(`[omc:cli-security] CLI binary '${binary}' resolved to non-standard path: ${resolvedPath}`);
  }

  resolvedPathCache.set(binary, resolvedPath);
  return resolvedPath;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function clearResolvedPathCache(): void {
  resolvedPathCache.clear();
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function validateCliBinaryPath(binary: string): CliBinaryValidation {
  try {
    const resolvedPath = resolveCliBinaryPath(binary);
    return { valid: true, binary, resolvedPath };
  } catch (error) {
    return {
      valid: false,
      binary,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export const _testInternals = {
  UNTRUSTED_PATH_PATTERNS,
  getTrustedPrefixes,
};

const CONTRACTS: Record<CliAgentType, CliAgentContract> = {
  claude: {
    agentType: 'claude',
    binary: 'claude',
    installInstructions: 'Install Claude CLI: https://claude.ai/download',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (model) {
        // Provider-specific model IDs (Bedrock, Vertex) must be passed as-is.
        // Normalizing them to aliases like "sonnet" causes Claude Code to expand
        // them to Anthropic API names (claude-sonnet-4-6) which are invalid on
        // these providers. (issue #1695)
        const resolved = isProviderSpecificModelId(model) ? model : normalizeToCcAlias(model);
        args.push('--model', resolved);
      }
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
    promptModeFlag: '-i',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--approval-mode', 'yolo'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
};

export function getContract(agentType: CliAgentType): CliAgentContract {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
  }
  if (agentType !== 'claude' && isExternalLLMDisabled()) {
    throw new Error(
      `External LLM provider "${agentType}" is blocked by security policy (disableExternalLLM). ` +
      `Only Claude workers are allowed in the current security configuration.`
    );
  }
  return contract;
}

function validateBinaryRef(binary: string): void {
  if (isAbsolute(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}

function resolveBinaryPath(binary: string): string {
  validateBinaryRef(binary);
  if (isAbsolute(binary)) return binary;

  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(resolver, [binary], { timeout: 5000, encoding: 'utf8' });
    if (result.status !== 0) return binary;

    const lines = result.stdout
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean) ?? [];

    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && (isAbsolute(firstPath) || win32Path.isAbsolute(firstPath));
    return isResolvedAbsolute ? firstPath : binary;
  } catch {
    return binary;
  }
}

export function isCliAvailable(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  try {
    const resolvedBinary = resolveBinaryPath(contract.binary);
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedBinary)) {
      const comspec = process.env.COMSPEC || 'cmd.exe';
      const result = spawnSync(comspec, ['/d', '/s', '/c', `"${resolvedBinary}" --version`], { timeout: 5000 });
      return result.status === 0;
    }

    const result = spawnSync(resolvedBinary, ['--version'], {
      timeout: 5000,
      shell: process.platform === 'win32',
    });
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

export function resolveValidatedBinaryPath(agentType: CliAgentType): string {
  const contract = getContract(agentType);
  return resolveCliBinaryPath(contract.binary);
}

export function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}

export function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const binary = config.resolvedBinaryPath
    ? (() => {
        validateBinaryRef(config.resolvedBinaryPath);
        return config.resolvedBinaryPath;
      })()
    : resolveBinaryPath(contract.binary);
  const args = buildLaunchArgs(agentType, config);
  return [binary, ...args];
}

export function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string {
  return buildWorkerArgv(agentType, config)
    .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
    .join(' ');
}

const WORKER_MODEL_ENV_ALLOWLIST = [
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
  'OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL',
  'OMC_CODEX_DEFAULT_MODEL',
  'OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL',
  'OMC_GEMINI_DEFAULT_MODEL',
] as const;

export function getWorkerEnv(
  teamName: string,
  workerName: string,
  agentType: CliAgentType,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  validateTeamName(teamName);
  const workerEnv: Record<string, string> = {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType,
  };

  for (const key of WORKER_MODEL_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      workerEnv[key] = value;
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
 * Resolve the active model for Claude team workers on Bedrock/Vertex.
 *
 * When running on a non-standard provider (Bedrock, Vertex), workers need
 * the provider-specific model ID passed explicitly via --model. Without it,
 * Claude Code falls back to its built-in default (claude-sonnet-4-6) which
 * is invalid on these providers.
 *
 * Resolution order:
 *   1. ANTHROPIC_MODEL / CLAUDE_MODEL env vars (user's explicit setting)
 *   2. Provider tier-specific env vars (CLAUDE_CODE_BEDROCK_SONNET_MODEL, etc.)
 *   3. undefined — let Claude Code handle its own default
 *
 * Returns undefined when not on Bedrock/Vertex (standard Anthropic API
 * handles bare aliases fine).
 */
export function resolveClaudeWorkerModel(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // Only needed for non-standard providers
  if (!isBedrock() && !isVertexAI()) {
    return undefined;
  }

  // Direct model env vars — highest priority
  const directModel = env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || '';
  if (directModel) {
    return directModel;
  }

  // Fallback: Bedrock tier-specific env vars (default to sonnet tier)
  const bedrockModel =
    env.CLAUDE_CODE_BEDROCK_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    '';
  if (bedrockModel) {
    return bedrockModel;
  }

  // OMC tier env vars
  const omcModel = env.OMC_MODEL_MEDIUM || '';
  if (omcModel) {
    return omcModel;
  }

  return undefined;
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
  // If a flag is defined (e.g. gemini's '-i'), prepend it; otherwise the
  // instruction is passed as a positional argument (e.g. codex [PROMPT]).
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}
