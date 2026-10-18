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
const DEFAULTS = {
    restrictToolPaths: false,
    pythonSandbox: false,
    disableProjectSkills: false,
    disableAutoUpdate: false,
    hardMaxIterations: 500,
    disableRemoteMcp: false,
    disableExternalLLM: false,
};
const STRICT_OVERRIDES = {
    restrictToolPaths: true,
    pythonSandbox: true,
    disableProjectSkills: true,
    disableAutoUpdate: true,
    hardMaxIterations: 200,
    disableRemoteMcp: true,
    disableExternalLLM: true,
};
/** Cached config to avoid re-reading files on every call */
let cachedConfig = null;
/**
 * Load the security section from config files.
 * Checks project config first, then user config.
 */
function loadSecurityFromConfigFiles() {
    const paths = [
        join(process.cwd(), ".claude", "omc.jsonc"),
        join(getConfigDir(), "claude-omc", "config.jsonc"),
    ];
    for (const configPath of paths) {
        if (!existsSync(configPath))
            continue;
        try {
            const content = readFileSync(configPath, "utf-8");
            const parsed = parseJsonc(content);
            if (parsed?.security && typeof parsed.security === "object") {
                return parsed.security;
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    return {};
}
/**
 * Resolve the full security configuration.
 * Precedence: config file > OMC_SECURITY env > defaults
 */
export function getSecurityConfig() {
    if (cachedConfig)
        return cachedConfig;
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
            hardMaxIterations: Math.min(base.hardMaxIterations, (typeof fileOverrides.hardMaxIterations === "number" && fileOverrides.hardMaxIterations > 0) ? fileOverrides.hardMaxIterations : base.hardMaxIterations),
        };
    }
    else {
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
export function clearSecurityConfigCache() {
    cachedConfig = null;
}
/** Convenience: is tool path restriction enabled? */
export function isToolPathRestricted() {
    return getSecurityConfig().restrictToolPaths;
}
/** Convenience: is python sandbox enabled? */
export function isPythonSandboxEnabled() {
    return getSecurityConfig().pythonSandbox;
}
/** Convenience: are project-level skills disabled? */
export function isProjectSkillsDisabled() {
    return getSecurityConfig().disableProjectSkills;
}
/** Convenience: is auto-update disabled? */
export function isAutoUpdateDisabled() {
    return getSecurityConfig().disableAutoUpdate;
}
/** Convenience: get hard max iterations (0 = unlimited) */
export function getHardMaxIterations() {
    return getSecurityConfig().hardMaxIterations;
}
/** Convenience: are remote MCP servers disabled? */
export function isRemoteMcpDisabled() {
    return getSecurityConfig().disableRemoteMcp;
}
/** Convenience: are external LLM providers disabled? */
export function isExternalLLMDisabled() {
    return getSecurityConfig().disableExternalLLM;
}
//# sourceMappingURL=security-config.js.map