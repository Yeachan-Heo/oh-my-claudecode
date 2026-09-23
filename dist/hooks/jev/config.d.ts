/**
 * Jev config: env contract per issue-3669 "Implementation Decisions".
 *
 * - TYPESAFE_API_KEY: authenticates Jev calls (necessary but not sufficient)
 * - OMC_JEV=off: master switch, disables every point even with a key
 * - OMC_JEV=<point[,point...]>: explicit per-point opt-in; only these points
 *   run. Unset = no points enabled — a key alone sends nothing anywhere
 *   (zero egress by default, per the owner's data-egress review of #4058)
 * - OMC_JEV_TIMEOUT_MS: per-call timeout, default 250
 * - OMC_JEV_MAX_REQUESTS: per-process request cap (0/absent = unlimited)
 * - OMC_JEV_EXCERPT_CHARS: max excerpt length sent in state, default 200
 * - OMC_JEV_ENDPOINT: base URL overlay (stub servers / tests)
 * - OMC_JEV_LOG_DIR: shadow-log directory override (tests)
 *
 * There is no active-by-env syntax. Per-point activation defaults to shadow;
 * a point runs active only when listed in ACTIVATED_POINTS or when the caller
 * forces mode: 'active' on a single resolveJudgment call. Promotion
 * (ticket 07) flips entries in that set.
 */
export declare const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Points currently promoted to active. Empty until the promotion ticket (07). */
export declare const ACTIVATED_POINTS: ReadonlySet<string>;
export interface JevConfig {
    apiKey: string | null;
    masterOff: boolean;
    /** Explicit per-point opt-in; empty = no points enabled. */
    points: ReadonlySet<string>;
    timeoutMs: number;
    /** 0 = unlimited. */
    maxRequests: number;
    excerptChars: number;
    endpoint: string;
    logDir: string;
}
export declare function parseJevConfig(env?: NodeJS.ProcessEnv): JevConfig;
/** Master gate: is Jev enabled at all, independent of per-point state? */
export declare function isJevEnabled(config: JevConfig): boolean;
/**
 * Tri-state for one point: off | shadow | active.
 * Config gates first (key presence, master off, per-point opt-in); an enabled
 * point is active only when code-activated, otherwise shadow.
 */
export declare function pointState(point: string, config: JevConfig, activated?: ReadonlySet<string>): 'off' | 'shadow' | 'active';
/**
 * Recursively bound every string value to `max` chars. Applied to the state
 * sent to Jev and to the state recorded in the shadow log; question
 * definitions are bounded too since they can embed user text.
 */
export declare function boundExcerpts(value: unknown, max: number): unknown;
//# sourceMappingURL=config.d.ts.map