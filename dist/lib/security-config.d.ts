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
/**
 * Resolve the full security configuration.
 * Precedence: config file > OMC_SECURITY env > defaults
 */
export declare function getSecurityConfig(): SecurityConfig;
/** Clear cached config (for testing) */
export declare function clearSecurityConfigCache(): void;
/** Convenience: is tool path restriction enabled? */
export declare function isToolPathRestricted(): boolean;
/** Convenience: is python sandbox enabled? */
export declare function isPythonSandboxEnabled(): boolean;
/** Convenience: are project-level skills disabled? */
export declare function isProjectSkillsDisabled(): boolean;
/** Convenience: is auto-update disabled? */
export declare function isAutoUpdateDisabled(): boolean;
/** Convenience: get hard max iterations (0 = unlimited) */
export declare function getHardMaxIterations(): number;
/** Convenience: are remote MCP servers disabled? */
export declare function isRemoteMcpDisabled(): boolean;
/** Convenience: are external LLM providers disabled? */
export declare function isExternalLLMDisabled(): boolean;
//# sourceMappingURL=security-config.d.ts.map