/**
 * Popular Plugin Patterns
 *
 * Common hook patterns from the Claude Code community:
 * - Auto-format on file save
 * - Lint validation before commit
 * - Commit message validation
 * - Test runner before commit
 * - Type checking enforcement
 */
/**
 * Validate file path for security
 * Blocks shell metacharacters and path traversal attempts
 */
export declare function isValidFilePath(filePath: string): boolean;
export interface FormatConfig {
    /** File extensions to format */
    extensions: string[];
    /** Formatter command (e.g., 'prettier --write', 'black') */
    command: string;
    /** Whether to run on file save */
    enabled: boolean;
}
/**
 * Get formatter command for a file extension
 */
export declare function getFormatter(ext: string): string | null;
/**
 * Check if a formatter is available
 */
export declare function isFormatterAvailable(command: string): boolean;
/**
 * Format a file using the appropriate formatter
 */
export declare function formatFile(filePath: string): {
    success: boolean;
    message: string;
};
export interface LintConfig {
    /** Lint command to run */
    command: string;
    /** File patterns to lint */
    patterns: string[];
    /** Whether to block on lint errors */
    blocking: boolean;
}
/**
 * Get linter command for a file extension
 */
export declare function getLinter(ext: string): string | null;
/**
 * Run linter on a file
 */
export declare function lintFile(filePath: string): {
    success: boolean;
    message: string;
};
export interface CommitConfig {
    /** Conventional commit types allowed */
    types: string[];
    /** Maximum subject length */
    maxSubjectLength: number;
    /** Require scope */
    requireScope: boolean;
    /** Require body */
    requireBody: boolean;
}
/**
 * Validate a commit message against conventional commit format
 */
export declare function validateCommitMessage(message: string, config?: Partial<CommitConfig>): {
    valid: boolean;
    errors: string[];
};
/**
 * Run TypeScript type checking
 */
export declare function runTypeCheck(directory: string): {
    success: boolean;
    message: string;
};
/**
 * Detect and run tests for a project
 */
export declare function runTests(directory: string): {
    success: boolean;
    message: string;
};
/**
 * Run project-level lint checks
 */
export declare function runLint(directory: string): {
    success: boolean;
    message: string;
};
export interface PreCommitResult {
    canCommit: boolean;
    checks: Array<{
        name: string;
        passed: boolean;
        message: string;
    }>;
}
/**
 * Run all pre-commit checks
 */
export declare function runPreCommitChecks(directory: string, commitMessage?: string): PreCommitResult;
/**
 * Generate pre-commit check reminder message
 */
export declare function getPreCommitReminderMessage(result: PreCommitResult): string;
/**
 * Generate auto-format reminder message
 */
export declare function getAutoFormatMessage(filePath: string, result: {
    success: boolean;
    message: string;
}): string;
//# sourceMappingURL=index.d.ts.map