/**
 * Declarative hook registry — #3698 / #3707.
 *
 * The installed registration (hooks/hooks.json) remains the runtime SSOT.
 * This module derives one declarative entry per installed command, assigning
 * risk classes by convention (only hard-risk entrypoints fail closed;
 * everything else is advisory/fail-open). No hand-maintained metadata table.
 *
 * Risk classes reuse the canonical taxonomy from src/workflow/registry.ts.
 */
import type { HookEvent, HookRegistryEntry, HooksJson } from './types.js';
/** Parse an installed command into entrypoint basename + trailing args. */
export declare function parseEntrypointCommand(command: string): {
    entrypoint: string;
    args: string[];
} | null;
export interface RegistryDriftIssue {
    code: 'unknown-event' | 'unparseable-command' | 'timeout-mismatch';
    message: string;
}
/**
 * Derive the declarative registry from the installed hooks.json.
 * Risk classes are assigned by convention; no hand-maintained metadata.
 */
export declare function buildHookRegistry(hooksJson: HooksJson): HookRegistryEntry[];
/**
 * Registration drift guard: every hooks.json event must be a known lifecycle
 * event, every command must be parseable, and every hook must have a positive
 * timeout. Returns an empty array when registry and installation agree.
 */
export declare function validateRegistryAgainstHooksJson(hooksJson: HooksJson): RegistryDriftIssue[];
/** Registry entries applicable to one event+matcher input, in execution order. */
export declare function selectApplicableEntries(registry: readonly HookRegistryEntry[], event: HookEvent, matcherInput: string | undefined): HookRegistryEntry[];
//# sourceMappingURL=registry.d.ts.map