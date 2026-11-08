export type ChainOutcome = 'success' | 'failed' | 'needs-human';
export interface ChainDirective {
    stage: string;
    skill: string;
    /**
     * Verification commands the AFK link to this stage may run. A development-type
     * ring cannot execute its spec's acceptance criteria without them: the AFK
     * permission profile (see AFK_ALLOWED_TOOLS) grants no general Bash, so a
     * declared `verify` list is the only way a chain link runs tests or builds.
     */
    verify?: readonly string[];
}
export type RouteTable = Readonly<Record<string, ChainDirective>>;
/**
 * A declared verify command is interpolated into the link's `--allowedTools`
 * argv, which is comma-separated — so a comma, a shell metacharacter, or a
 * leading option dash would either split the allowlist entry or smuggle shell
 * syntax past the profile. Only plain command lines survive; anything else is
 * dropped, and a directive that keeps none of its commands simply runs with the
 * base profile.
 */
export declare const VERIFY_COMMAND_PATTERN: RegExp;
export declare const MAX_VERIFY_COMMANDS = 10;
export declare const MAX_VERIFY_COMMAND_LENGTH = 120;
/**
 * Keep only well-formed `outcome:reason` directives. A table written in the
 * nested shape (`{ success: { other: {...} } }`) yields no flat key, so
 * `decideNextStage` returns null and the chain halts as `no-route` — silently,
 * because a malformed table and a deliberate terminal look identical downstream.
 * Nested groups (keys without `:`) and non-directive entries are dropped.
 * Returns null for non-objects; an empty object is a valid, authoritative
 * empty table.
 */
export declare function normalizeRouteTable(input: unknown): RouteTable | null;
export declare function decideNextStage(outcome: ChainOutcome, reason: string, table: RouteTable): ChainDirective | null;
export type GateName = 'intent-accept' | 'spec-approve' | 'harbor-review' | 'review-approve';
export interface GateFacts {
    irreversibleOrExternal: boolean;
    precedentSetting: boolean;
    valueJudgment: boolean;
    mechanicalChecksPassed: boolean;
    /** Primary-source requirement: the signoff must reference the diff or changed-file list, not the agent's summary. */
    diffAttached?: boolean;
}
export type GateVerdict = {
    kind: 'human';
    criterion: string;
} | {
    kind: 'auto-pass';
    signerFact: string;
};
export declare function gradeGate(gate: GateName, facts: GateFacts): GateVerdict;
//# sourceMappingURL=routing.d.ts.map