/**
 * Delegation Router
 *
 * Resolves which provider/tool to use for a given agent role.
 */
import type { DelegationDecision, ResolveDelegationOptions } from '../../shared/types.js';
/**
 * Resolve delegation decision based on configuration and context
 *
 * Precedence (highest to lowest):
 * 1. Explicit tool invocation
 * 2. Configured routing (if enabled)
 * 3. Default heuristic (role category → Claude subagent)
 * 4. defaultProvider
 */
export declare function resolveDelegation(options: ResolveDelegationOptions): DelegationDecision;
/**
 * Parse fallback chain format ["claude:explore", "codex:gpt-5"]
 */
export declare function parseFallbackChain(fallback: string[] | undefined): Array<{
    provider: string;
    agentOrModel: string;
}>;
//# sourceMappingURL=resolver.d.ts.map