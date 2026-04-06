/**
 * Factcheck Guard Configuration
 *
 * Loads guard config from the OMC config system with token expansion
 * and deep merge over sensible defaults.
 */
import { homedir } from 'os';
import { loadConfig } from '../../config/loader.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_FACTCHECK_POLICY = {
    enabled: false,
    mode: 'quick',
    strict_project_patterns: [],
    forbidden_path_prefixes: ['${CLAUDE_CONFIG_DIR}/plugins/cache/omc/'],
    forbidden_path_substrings: ['/.omc/', '.omc-config.json'],
    readonly_command_prefixes: [
        'ls ', 'cat ', 'find ', 'grep ', 'head ', 'tail ', 'stat ', 'echo ', 'wc ',
    ],
    warn_on_cwd_mismatch: true,
    enforce_cwd_parity_in_quick: false,
    warn_on_unverified_gates: true,
    warn_on_unverified_gates_when_no_source_files: false,
};
const DEFAULT_SENTINEL_POLICY = {
    enabled: false,
    readiness: {
        min_pass_rate: 0.60,
        max_timeout_rate: 0.10,
        max_warn_plus_fail_rate: 0.40,
        min_reason_coverage_rate: 0.95,
    },
};
export const DEFAULT_GUARDS_CONFIG = {
    factcheck: { ...DEFAULT_FACTCHECK_POLICY },
    sentinel: { ...DEFAULT_SENTINEL_POLICY },
};
// ---------------------------------------------------------------------------
// Token expansion
// ---------------------------------------------------------------------------
/**
 * Expand ${HOME}, ${WORKSPACE}, and ${CLAUDE_CONFIG_DIR} tokens in a string.
 */
export function expandTokens(value, workspace) {
    const home = homedir();
    const ws = workspace ?? process.env.OMC_WORKSPACE ?? process.cwd();
    return value
        .replace(/\$\{HOME\}/g, home)
        .replace(/\$\{WORKSPACE\}/g, ws)
        .replace(/\$\{CLAUDE_CONFIG_DIR\}/g, getClaudeConfigDir());
}
/**
 * Recursively expand tokens in string values within an object or array.
 */
function expandTokensDeep(obj, workspace) {
    if (typeof obj === 'string') {
        return expandTokens(obj, workspace);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => expandTokensDeep(item, workspace));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandTokensDeep(value, workspace);
        }
        return result;
    }
    return obj;
}
// ---------------------------------------------------------------------------
// Deep merge (local, type-safe for guards config)
// ---------------------------------------------------------------------------
function deepMergeGuards(target, source) {
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
 * defaults, and expands ${HOME}/${WORKSPACE}/${CLAUDE_CONFIG_DIR} tokens.
 */
export function loadGuardsConfig(workspace) {
    try {
        const fullConfig = loadConfig();
        const guardsRaw = (fullConfig.guards ?? {});
        const merged = deepMergeGuards(DEFAULT_GUARDS_CONFIG, guardsRaw);
        return expandTokensDeep(merged, workspace);
    }
    catch {
        // If config loading fails, return expanded defaults
        return expandTokensDeep({ ...DEFAULT_GUARDS_CONFIG }, workspace);
    }
}
/**
 * Check if a project name matches any strict project patterns.
 * Uses simple glob-style matching (supports * wildcard).
 */
export function shouldUseStrictMode(projectName, patterns) {
    for (const pattern of patterns) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (regex.test(projectName)) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=config.js.map