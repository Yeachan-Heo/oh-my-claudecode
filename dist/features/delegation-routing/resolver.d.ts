/**
 * Delegation Router
 *
 * Resolves which provider/tool to use for a given agent role.
 */
import type { DelegationRoutingConfig, DelegationRoute, DelegationDecision, ResolveDelegationOptions } from '../../shared/types.js';
export declare const DEPRECATED_MCP_PROVIDER_WARNING = "[OMC] Codex/Gemini MCP delegation is deprecated. Use /team to coordinate CLI workers instead.";
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
export declare function isDeprecatedMcpProvider(provider: DelegationRoute['provider'] | DelegationRoutingConfig['defaultProvider']): provider is 'codex' | 'gemini';
/**
 * Parse fallback chain format ["claude:explore", "codex:gpt-5"]
 */
export declare function parseFallbackChain(fallback: string[] | undefined): Array<{
    provider: string;
    agentOrModel: string;
}>;
//# sourceMappingURL=resolver.d.ts.map