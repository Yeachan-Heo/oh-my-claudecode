/**
 * Factory listener daemon (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * Resident intake daemon: transport adapters (smee/cloudflared/direct) live
 * outside the OMC boundary — the daemon only receives already-unpacked
 * webhook events as POSTs. It verifies the HMAC signature, enforces the repo
 * whitelist, applies the intake label gate (tracker issues) or the completed
 * CI failure gate (check-suite webhooks), and routes through the shared
 * routing pure function (T1 seam). v1 processes events serially.
 */
import { type Server } from 'http';
import { type ChainDirective, type RouteTable } from '../hooks/session-end/routing.js';
import { type SpawnContext } from '../hooks/session-end/spawn-next.js';
export declare const INTAKE_LABEL = "intake";
export declare const INTAKE_ROUTE_TABLE: RouteTable;
/** CI check-suite failures feed the diagnose stage of the same chain. */
export declare const CI_ROUTE_TABLE: RouteTable;
/** GitHub issue webhook payload subset the daemon needs. */
export interface TrackerEvent {
    action?: string;
    repository?: {
        full_name?: string;
    };
    label?: {
        name?: string;
    };
    issue?: {
        number?: number;
        title?: string;
        html_url?: string;
        labels?: Array<{
            name?: string;
        }>;
    };
}
/** GitHub check-run webhook payload subset the daemon needs (CI failure intake). */
export interface CheckRunEvent {
    action?: string;
    check_suite?: {
        conclusion?: string;
        head_branch?: string;
    };
    repository?: {
        full_name?: string;
    };
}
export declare function verifySignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean;
export type RouteOutcome = {
    kind: 'routed';
    directive: ChainDirective;
    issueNumber?: number;
    issueUrl?: string;
} | {
    kind: 'discarded';
    reason: string;
} | {
    kind: 'rejected';
    status: number;
    reason: string;
};
/** Pure intake decision: whitelist -> label gate -> shared routing seam. */
export declare function routeTrackerEvent(event: TrackerEvent, whitelist: ReadonlyArray<string>, table?: RouteTable): RouteOutcome;
/**
 * Pure CI intake decision: whitelist -> completed/failure gate -> shared
 * routing seam. Same outcome shape as routeTrackerEvent so the listener
 * dispatches both webhook kinds uniformly.
 */
export declare function routeCheckFailure(event: CheckRunEvent, whitelist: ReadonlyArray<string>, table?: RouteTable): RouteOutcome;
export declare function buildIntentPrompt(directive: ChainDirective, issueNumber?: number, issueUrl?: string): string;
export declare function buildDiagnosePrompt(directive: ChainDirective, repo: string, branch?: string): string;
export interface ListenerConfig {
    port: number;
    secret: string;
    whitelist: ReadonlyArray<string>;
    cwd: string;
    host?: string;
}
export interface ListenerDeps {
    spawner?: (cmd: string, args: string[], ctx?: SpawnContext) => void;
    audit?: (record: Record<string, unknown>) => void;
    /** Test seam: overrides the one-shot stall check scheduling for spawned links. */
    scheduleStallCheck?: (session: string) => void;
}
export interface EventResult {
    status: number;
    kind: 'accepted' | 'discarded' | 'rejected';
    detail: string;
}
/** Orchestrates one tracker event: audit rejections, discard noise, spawn routed sessions. */
export declare function processEvent(event: TrackerEvent, config: ListenerConfig, deps?: ListenerDeps): EventResult;
/** Orchestrates one CI check-suite event: same guardrail/ledger/AFK flow, no tracker. */
export declare function processCheckFailureEvent(event: CheckRunEvent, config: ListenerConfig, deps?: ListenerDeps): EventResult;
export declare function startListener(config: ListenerConfig, deps?: ListenerDeps): Promise<Server>;
export declare function stopListener(server: Server, cwd: string): void;
export declare const MAX_BODY_BYTES: number;
//# sourceMappingURL=listener.d.ts.map