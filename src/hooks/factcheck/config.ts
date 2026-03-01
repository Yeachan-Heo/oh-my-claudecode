/**
 * Factcheck Guard Configuration
 *
 * Loads guard config from the OMC config system with token expansion
 * and deep merge over sensible defaults.
 */

import { homedir } from 'os';
import { resolve } from 'path';
import { loadConfig } from '../../config/loader.js';
import type { GuardsConfig, FactcheckPolicy, SentinelPolicy } from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FACTCHECK_POLICY: FactcheckPolicy = {
  enabled: false,
  mode: 'quick',
  strict_project_patterns: [],
  forbidden_path_prefixes: ['${HOME}/.claude/plugins/cache/omc/'],
  forbidden_path_substrings: ['/.omc/', '.omc-config.json'],
  readonly_command_prefixes: [
    'ls ', 'cat ', 'find ', 'grep ', 'head ', 'tail ', 'stat ', 'echo ', 'wc ',
  ],
  warn_on_cwd_mismatch: true,
  enforce_cwd_parity_in_quick: false,
  warn_on_unverified_gates: true,
  warn_on_unverified_gates_when_no_source_files: false,
};

const DEFAULT_SENTINEL_POLICY: SentinelPolicy = {
  enabled: false,
  readiness: {
    min_pass_rate: 0.60,
    max_timeout_rate: 0.10,
    max_warn_plus_fail_rate: 0.40,
    min_reason_coverage_rate: 0.95,
  },
};

export const DEFAULT_GUARDS_CONFIG: GuardsConfig = {
  factcheck: { ...DEFAULT_FACTCHECK_POLICY },
  sentinel: { ...DEFAULT_SENTINEL_POLICY },
};

// ---------------------------------------------------------------------------
// Token expansion
// ---------------------------------------------------------------------------

/**
 * Expand ${HOME} and ${WORKSPACE} tokens in a string.
 */
export function expandTokens(value: string, workspace?: string): string {
  const home = homedir();
  const ws = workspace ?? process.env.OMC_WORKSPACE ?? process.cwd();
  return value
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$\{WORKSPACE\}/g, ws);
}

/**
 * Recursively expand tokens in string values within an object or array.
 */
function expandTokensDeep<T>(obj: T, workspace?: string): T {
  if (typeof obj === 'string') {
    return expandTokens(obj, workspace) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => expandTokensDeep(item, workspace)) as unknown as T;
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandTokensDeep(value, workspace);
    }
    return result as T;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Deep merge (local, type-safe for guards config)
// ---------------------------------------------------------------------------

function deepMergeGuards(
  target: GuardsConfig,
  source: Partial<GuardsConfig>,
): GuardsConfig {
  const result = { ...target };

  if (source.factcheck) {
    result.factcheck = { ...result.factcheck, ...source.factcheck };
  }
  if (source.sentinel) {
    result.sentinel = {
      ...result.sentinel,
      ...source.sentinel,
      readiness: {
        ...result.sentinel.readiness,
        ...(source.sentinel.readiness ?? {}),
      },
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load guards config from the OMC config system.
 *
 * Reads the `guards` key from the merged OMC config, deep-merges over
 * defaults, and expands ${HOME}/${WORKSPACE} tokens.
 */
export function loadGuardsConfig(workspace?: string): GuardsConfig {
  try {
    const fullConfig = loadConfig() as Record<string, unknown>;
    const guardsRaw = (fullConfig.guards ?? {}) as Partial<GuardsConfig>;
    const merged = deepMergeGuards(DEFAULT_GUARDS_CONFIG, guardsRaw);
    return expandTokensDeep(merged, workspace);
  } catch {
    // If config loading fails, return expanded defaults
    return expandTokensDeep({ ...DEFAULT_GUARDS_CONFIG }, workspace);
  }
}

/**
 * Check if a project name matches any strict project patterns.
 * Uses simple glob-style matching (supports * wildcard).
 */
export function shouldUseStrictMode(
  projectName: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    if (regex.test(projectName)) {
      return true;
    }
  }
  return false;
}
