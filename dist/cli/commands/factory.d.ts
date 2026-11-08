/**
 * Factory command (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * `omc factory listen` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless intent session spawn).
 *
 * `omc factory init` — seeds the project route table (`.omc/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. Default seeds the narrow starter loop; --no-narrow
 * seeds the full-pipeline widening template. Never overwrites without --force.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */
import { Command } from 'commander';
import { type RouteTable } from '../../hooks/session-end/routing.js';
export declare function factoryCommand(): Command;
/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> intent hop. Everything after a completed intent session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export declare function buildRouteTableNarrow(): RouteTable;
/**
 * Full-pipeline widening template: a documented example widening the starter
 * loop into the intent -> launch -> diagnose progression. Keys are
 * `outcome:reason` pairs (the listener's intake label event, or the ending
 * session's outcome + hook reason); values name the next stage/skill. This is
 * a starting point to edit per project — a missing route halts the chain, and
 * `skill: "stop"` declares a terminal stage.
 */
export declare function buildRouteTableFull(): RouteTable;
/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omc/state/`) and the shipyard layout
 * needs `docs/design/`.
 */
export declare function validateFactoryPrerequisites(cwd: string): {
    ok: boolean;
    missing: string[];
};
export interface FactoryInitResult {
    exitCode: number;
    message: string;
}
/**
 * `omc factory init`: seed `.omc/factory-routes.json` — narrow starter table
 * by default, full widening template with narrow:false. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export declare function runFactoryInit(options?: {
    narrow?: boolean;
    cwd?: string;
    force?: boolean;
}): FactoryInitResult;
//# sourceMappingURL=factory.d.ts.map