/**
 * Unified Security Configuration
 *
 * Single entry point for all OMC security settings.
 * Two layers of configuration:
 *
 * 1. OMC_SECURITY env var — master switch
 *    - "strict": all security features enabled
 *    - unset/other: per-feature defaults apply
 *
 * 2. Config file (.claude/omc.jsonc or ~/.config/claude-omc/config.jsonc)
 *    security section — granular overrides (highest precedence)
 *
 * Precedence: config file > OMC_SECURITY env var > defaults (all off)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseJsonc } from "../utils/jsonc.js";
import { getConfigDir } from "../utils/paths.js";

export interface SecurityConfig {
  /** Restrict ast_grep_search/replace path to project root */
  restrictToolPaths: boolean;
  /** Sandbox python_repl with blocked modules/builtins */
  pythonSandbox: boolean;
  /** Disable project-level .omc/skills/ loading */
  disableProjectSkills: boolean;
  /** Disable silent auto-update */
  disableAutoUpdate: boolean;
  /** Hard max iterations for persistent modes (0 = unlimited) */
  hardMaxIterations: number;
  /** Disable remote MCP servers (Exa, Context7) */
  disableRemoteMcp: boolean;
  /** Disable external LLM providers (Codex, Gemini) in team mode */
  disableExternalLLM: boolean;
}

const DEFAULTS: SecurityConfig = {
  restrictToolPaths: false,
  pythonSandbox: false,
  disableProjectSkills: false,
  disableAutoUpdate: false,
  hardMaxIterations: 500,
  disableRemoteMcp: false,
  disableExternalLLM: false,
};

const STRICT_OVERRIDES: SecurityConfig = {
  restrictToolPaths: true,
  pythonSandbox: true,
  disableProjectSkills: true,
  disableAutoUpdate: true,
  hardMaxIterations: 200,
  disableRemoteMcp: true,
  disableExternalLLM: true,
};

/** Cached config to avoid re-reading files on every call */
let cachedConfig: SecurityConfig | null = null;

/**
 * Load the security section from config files.
 * Checks project config first, then user config.
 */
function loadSecurityFromConfigFiles(): Partial<SecurityConfig> {
  const paths = [
    join(process.cwd(), ".claude", "omc.jsonc"),
    join(getConfigDir(), "claude-omc", "config.jsonc"),
  ];

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseJsonc(content) as Record<string, unknown>;
      if (parsed?.security && typeof parsed.security === "object") {
        return parsed.security as Partial<SecurityConfig>;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return {};
}

/**
 * Resolve the full security configuration.
 * Precedence: config file > OMC_SECURITY env > defaults
 */
export function getSecurityConfig(): SecurityConfig {
  if (cachedConfig) return cachedConfig;

  const isStrict = process.env.OMC_SECURITY === "strict";
  const base = isStrict ? { ...STRICT_OVERRIDES } : { ...DEFAULTS };
  const fileOverrides = loadSecurityFromConfigFiles();

  if (isStrict) {
    // In strict mode, config file can only TIGHTEN security, not relax it
    cachedConfig = {
      restrictToolPaths: base.restrictToolPaths || (fileOverrides.restrictToolPaths ?? false),
      pythonSandbox: base.pythonSandbox || (fileOverrides.pythonSandbox ?? false),
      disableProjectSkills: base.disableProjectSkills || (fileOverrides.disableProjectSkills ?? false),
      disableAutoUpdate: base.disableAutoUpdate || (fileOverrides.disableAutoUpdate ?? false),
      disableRemoteMcp: base.disableRemoteMcp || (fileOverrides.disableRemoteMcp ?? false),
      disableExternalLLM: base.disableExternalLLM || (fileOverrides.disableExternalLLM ?? false),
      hardMaxIterations: Math.min(base.hardMaxIterations, fileOverrides.hardMaxIterations ?? base.hardMaxIterations),
    };
  } else {
    cachedConfig = {
      restrictToolPaths: fileOverrides.restrictToolPaths ?? base.restrictToolPaths,
      pythonSandbox: fileOverrides.pythonSandbox ?? base.pythonSandbox,
      disableProjectSkills: fileOverrides.disableProjectSkills ?? base.disableProjectSkills,
      disableAutoUpdate: fileOverrides.disableAutoUpdate ?? base.disableAutoUpdate,
      disableRemoteMcp: fileOverrides.disableRemoteMcp ?? base.disableRemoteMcp,
      disableExternalLLM: fileOverrides.disableExternalLLM ?? base.disableExternalLLM,
      hardMaxIterations: fileOverrides.hardMaxIterations ?? base.hardMaxIterations,
    };
  }

  return cachedConfig;
}

/** Clear cached config (for testing) */
export function clearSecurityConfigCache(): void {
  cachedConfig = null;
}

/** Convenience: is tool path restriction enabled? */
export function isToolPathRestricted(): boolean {
  return getSecurityConfig().restrictToolPaths;
}

/** Convenience: is python sandbox enabled? */
export function isPythonSandboxEnabled(): boolean {
  return getSecurityConfig().pythonSandbox;
}

/** Convenience: are project-level skills disabled? */
export function isProjectSkillsDisabled(): boolean {
  return getSecurityConfig().disableProjectSkills;
}

/** Convenience: is auto-update disabled? */
export function isAutoUpdateDisabled(): boolean {
  return getSecurityConfig().disableAutoUpdate;
}

/** Convenience: get hard max iterations (0 = unlimited) */
export function getHardMaxIterations(): number {
  return getSecurityConfig().hardMaxIterations;
}

/** Convenience: are remote MCP servers disabled? */
export function isRemoteMcpDisabled(): boolean {
  return getSecurityConfig().disableRemoteMcp;
}

/** Convenience: are external LLM providers disabled? */
export function isExternalLLMDisabled(): boolean {
  return getSecurityConfig().disableExternalLLM;
}
