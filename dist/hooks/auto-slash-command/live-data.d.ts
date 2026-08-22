/**
 * Live Data Injection
 *
 * Resolves `!command` lines in skill/command templates by executing the command
 * and replacing the line with its output wrapped in <live-data> tags.
 *
 * Supports:
 * - Basic: `!git status`
 * - Caching: `!cache 300s git log -10`
 * - Conditional: `!if-modified src/** then git diff src/`
 * - Conditional: `!if-branch feat/* then echo "feature branch"`
 * - Once per session: `!only-once npm install`
 * - Output formats: `!json docker inspect ...`, `!table ...`, `!diff git diff`
 * - Multi-line: `!begin-script bash` ... `!end-script`
 * - Security allowlist via .omc/config/live-data-policy.json
 */
/** Clear all caches (useful for testing) */
export declare function clearCache(): void;
/** Reset cached policy (for testing) */
export declare function resetSecurityPolicy(): void;
export declare function isLiveDataLine(line: string): boolean;
export declare function hasLiveDataScriptArgumentPlaceholder(content: string): boolean;
/**
 * Return whether placeholder replacement made a previously non-executable line
 * become an executable live-data directive.
 */
export declare function introducesLiveDataDirective(templateContent: string, resolvedContent: string): boolean;
/**
 * Resolve all live-data directives in content.
 * Lines inside fenced code blocks are skipped.
 */
export declare function resolveLiveData(content: string): string;
//# sourceMappingURL=live-data.d.ts.map