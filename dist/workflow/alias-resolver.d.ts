/**
 * Alias Resolver — issue #3706
 *
 * Maps legacy workflow / skill / command aliases to the four Tier-0
 * canonical workflows (`plan`, `execute`, `review`, `verify`) or the
 * maintainer-only `omc release` authority. Provides:
 *  - one concise actionable warning per alias per session (default)
 *  - diagnostics mapping/telemetry retention
 *  - temporary automation opt-out
 *  - usage receipts (machine-readable)
 *  - resolver flag rollback (`OMC_ALIAS_RESOLVER_ENABLED`)
 *
 * Design contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md
 * Plan head: 0a91273e61dbbd47eb0af4c02844409251e08398
 * Epic: #3698, child: #3706
 *
 * This module is intentionally additive and dependency-light. When the
 * prerequisite registry (#3703) lands, this resolver adapts to that
 * registry via a narrow adapter seam (see `resolveWorkflowAliasViaRegistry`
 * hook). The resolver flag gates all behavior so a rollout issue can fall
 * back to legacy mapping without a code revert.
 */
export declare const TIER0_WORKFLOWS: readonly ["plan", "deep-interview", "ralplan", "execute", "review", "verify"];
export type Tier0Workflow = (typeof TIER0_WORKFLOWS)[number];
/**
 * Non-Tier-0 alias targets. `research` is an internal lane (registry.ts marks
 * it internalOnly); `omc-release` is the maintainer-only release authority;
 * `project-session-manager` is a kept utility that the short `psm` name points
 * at. None of these join TIER0_WORKFLOWS.
 */
export type AliasTarget = Tier0Workflow | 'omc-release' | 'research' | 'project-session-manager';
export interface AliasEntry {
    alias: string;
    canonical: AliasTarget;
    tier0?: Tier0Workflow;
    owner: string;
    description: string;
    removalMilestone: string;
    isWorkflowAlias: boolean;
}
export interface AliasMappingDiagnostics {
    alias: string;
    canonical: AliasTarget;
    tier0: Tier0Workflow | null;
    warning: string;
    owner: string;
    removalMilestone: string;
}
/**
 * 5.0.0 retired the legacy workflow aliases outright under the major-version
 * carve-out (see alias-retirement/policy.ts). Removed entirely rather than
 * aliased: ultrawork, ultraqa, ultrapilot, swarm, pipeline,
 * merge-readiness, deep-dive, sciomc, ccg, omc-teams, mcp-setup, learner,
 * writer-memory, local-build-reminder, setup, omc-reference.
 *
 * Entries that remain are genuine aliases only. Skills the registry marks
 * `decision: 'keep'` (team, autopilot, autoresearch, ai-slop-cleaner,
 * visual-verdict, self-improve) are deliberately absent — listing a kept skill
 * here would rewrite a direct invocation into something else.
 */
export declare const ALIAS_REGISTRY: readonly AliasEntry[];
export declare function isResolverEnabled(): boolean;
export declare function isWarningOptedOut(): boolean;
export declare function normalizeWorkflowInput(raw: string): string;
export interface AliasResolution {
    input: string;
    normalized: string;
    canonical: AliasTarget;
    tier0: Tier0Workflow | null;
    isAlias: boolean;
    isCanonical: boolean;
    isRelease: boolean;
    warning: string | null;
    mapping: {
        alias: string;
        canonical: AliasTarget;
    } | null;
    enabled: boolean;
}
export declare function formatAliasWarning(alias: string, canonical: AliasTarget): string;
export declare function resolveWorkflowAlias(rawInput: string): AliasResolution;
export type AliasRegistryLookup = (normalized: string) => AliasEntry | undefined;
export declare function resolveWorkflowAliasViaRegistry(rawInput: string, lookup: AliasRegistryLookup): AliasResolution;
export declare function getAliasMapping(): AliasMappingDiagnostics[];
export declare function getDiagnostics(): {
    tier0: readonly Tier0Workflow[];
    aliases: AliasMappingDiagnostics[];
    resolverEnabled: boolean;
    warningOptOut: boolean;
    planHead: string;
};
export declare function shouldEmitWarning(alias: string, sessionId?: string, worktreeRoot?: string): boolean;
export declare function markWarningEmitted(alias: string, sessionId?: string, worktreeRoot?: string): void;
export declare function maybeGetAliasWarning(resolution: AliasResolution, sessionId?: string, worktreeRoot?: string): string | null;
export interface AliasTelemetryEvent {
    alias: string;
    normalized: string;
    canonical: AliasTarget;
    tier0: Tier0Workflow | null;
    timestamp: string;
    sessionId?: string;
    warned: boolean;
    release: boolean;
}
export interface AliasReceipts {
    version: 1;
    planHead: string;
    generatedAt: string;
    totals: {
        aliasUses: number;
        canonicalUses: number;
    };
    byAlias: Record<string, {
        count: number;
        canonical: AliasTarget;
        lastSeen: string;
    }>;
    byCanonical: Record<string, number>;
    releaseUses: number;
}
export declare function recordAliasTelemetry(event: Omit<AliasTelemetryEvent, 'timestamp'> & {
    timestamp?: string;
}, worktreeRoot?: string): void;
export declare function readTelemetryTail(limit?: number, worktreeRoot?: string): AliasTelemetryEvent[];
export declare function readUsageReceipts(worktreeRoot?: string): AliasReceipts;
export declare function clearAliasTelemetryForTests(worktreeRoot?: string): void;
export declare function clearAliasWarningsForTests(sessionId?: string, worktreeRoot?: string): void;
export declare function resolveWorkflowInputWithWarning(rawInput: string, sessionId?: string, worktreeRoot?: string): AliasResolution & {
    warningToEmit: string | null;
};
//# sourceMappingURL=alias-resolver.d.ts.map