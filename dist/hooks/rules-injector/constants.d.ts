/**
 * Rules Injector Constants
 *
 * Constants for rule file discovery and matching.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
/** Storage directory for rules injector state */
export declare const OMC_STORAGE_DIR: string;
export declare const RULES_INJECTOR_STORAGE: string;
/** Project marker files that indicate a project root */
export declare const PROJECT_MARKERS: string[];
/** Subdirectories to search for rules within projects */
export declare const PROJECT_RULE_SUBDIRS: [string, string][];
/** Single-file rules that always apply */
export declare const PROJECT_RULE_FILES: string[];
/** Pattern for GitHub instructions files */
export declare const GITHUB_INSTRUCTIONS_PATTERN: RegExp;
/** User-level rule directory */
export declare const USER_RULE_DIR = ".claude/rules";
/** Valid rule file extensions */
export declare const RULE_EXTENSIONS: string[];
/** Tools that trigger rule injection */
export declare const TRACKED_TOOLS: string[];
//# sourceMappingURL=constants.d.ts.map