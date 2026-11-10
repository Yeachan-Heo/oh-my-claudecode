/**
 * Jev config: env contract per issue-3669 "Implementation Decisions".
 *
 * - TYPESAFE_API_KEY: authenticates Jev calls (necessary but not sufficient)
 * - OMC_JEV=off: master switch, disables every point even with a key
 * - OMC_JEV=<point[,point...]>: explicit per-point opt-in; only these points
 *   run. Unset = no points enabled — a key alone sends nothing anywhere
 *   (zero egress by default, per the owner's data-egress review of #4058)
 * - OMC_JEV_TIMEOUT_MS: per-call timeout, default 2000 (measured single-question
 *   round-trips are 465-605 ms, so a sub-second default degrades every call)
 * - OMC_JEV_MAX_REQUESTS: per-process request cap (0/absent = unlimited)
 * - OMC_JEV_BREAKER=1: circuit breaker shared by every process of the machine
 *   (opt-in; read by scripts/lib/jev-breaker.mjs, not parsed here)
 * - OMC_JEV_MAX_RPM: requests per UTC minute for the machine, by point
 *   priority (opt-in; absent = no limit; also read by jev-breaker.mjs)
 * - OMC_JEV_BREAKER_DIR: state directory of both (tests)
 * - OMC_JEV_EXCERPT_CHARS: max excerpt length sent in state, default 200
 * - OMC_JEV_EXCERPT_CHARS_<POINT>: the same limit for one point (point name
 *   upper-cased, dashes as underscores, e.g. OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING).
 *   model-routing defaults to 12000 and loop-continuation to 2000; both ignore
 *   OMC_JEV_EXCERPT_CHARS; set the point's own variable to change them.
 *   Points with their own default (POINT_DEFAULT_EXCERPT_CHARS: model-routing,
 *   task-size, skill-trigger, intent, learner-extraction, loop-continuation)
 *   ignore OMC_JEV_EXCERPT_CHARS.
 * - OMC_JEV_ENDPOINT: address of the Jev API (default JEV_DEFAULT_ENDPOINT);
 *   base URL overlay for stub servers and tests. TYPESAFE_API_KEY is sent as
 *   a bearer token.
 * - OMC_JEV_LOG_DIR: shadow-log directory override (tests)
 * - OMC_JEV_QUIET=1: silence the env-activation stderr warning (hook
 *   processes are one-shot, so warn-once-per-process degrades to warn-every)
 *
 * Per-point activation defaults to shadow. A point runs active when listed in
 * the compile-time ACTIVATED_POINTS, activated via env (point:active suffix,
 * or the `all` wildcard — see below), or when the caller forces mode: 'active'
 * on a single resolveJudgment call. Promotion (ticket 07) flips entries in
 * ACTIVATED_POINTS; env activation is the user-facing one-line experiment
 * channel (ADR 03672).
 *
 * OMC_JEV entry syntax: `point` (shadow) | `point:active` (active) | `all`
 * (every registered point, shadow) | `all:active` (every point, active).
 * Unknown point names are ignored.
 */
export declare const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Points currently promoted to active. Empty until the promotion ticket (07). */
export declare const ACTIVATED_POINTS: ReadonlySet<string>;
/**
 * Points that `all` and `all:active` never enable: they send more than the
 * bounded excerpts of the other points (`compaction` sends tool results and
 * user messages from the conversation), so each needs its own entry in
 * OMC_JEV. Mirror of NAMED_ONLY_POINTS in scripts/jev-resolve.mjs.
 */
export declare const NAMED_ONLY_POINTS: ReadonlySet<string>;
export interface JevConfig {
    apiKey: string | null;
    masterOff: boolean;
    /** Explicit per-point opt-in; empty = no points enabled. */
    points: ReadonlySet<string>;
    /** `all` wildcard: every registered point is opted in. */
    allPoints: boolean;
    /** Points activated via env (`point:active` entries). */
    activatedPoints: ReadonlySet<string>;
    /** `all:active`: every opted-in point is active. */
    activateAll: boolean;
    timeoutMs: number;
    /** 0 = unlimited. */
    maxRequests: number;
    excerptChars: number;
    /** OMC_JEV_EXCERPT_CHARS_<POINT> overrides, keyed by the upper-cased variable suffix. */
    pointExcerptChars: Readonly<Record<string, number>>;
    endpoint: string;
    logDir: string;
}
export declare function parseJevConfig(env?: NodeJS.ProcessEnv): JevConfig;
/**
 * Points whose state needs more than the global default to be judged at all.
 * model-routing judges the work behind the task, which 200 characters hide.
 * loop-continuation judges whether the task is complete; the script hook
 * (scripts/persistent-mode.mjs) sends the last assistant message, which it
 * already bounds to 2000 characters, and a 200-character cut keeps only its
 * opening. Here the state carries the continuation message only.
 * compaction judges tool results by their start and end and the user's last
 * messages (hooks/jev-compaction.mjs bounds them itself, at most 4000
 * characters). task-size, skill-trigger and intent judge the user's prompt and
 * learner-extraction the assistant message; a 200-character cut keeps only
 * the opening of either. learner-extraction uses the same 2000 characters as
 * loop-continuation. Mirror of POINT_DEFAULT_EXCERPT_CHARS in scripts/jev-resolve.mjs
 * and DEFAULT_EXCERPT_CHARS in hooks/jev-compaction.mjs.
 */
export declare const POINT_DEFAULT_EXCERPT_CHARS: Readonly<Record<string, number>>;
/**
 * Excerpt limit for one point: its own variable, else the point's default
 * (POINT_DEFAULT_EXCERPT_CHARS: model-routing, task-size, skill-trigger, intent, learner-extraction, loop-continuation, compaction), else OMC_JEV_EXCERPT_CHARS.
 * The global variable does not apply to a point with its own default.
 */
export declare function excerptCharsFor(point: string, config: JevConfig): number;
/** Master gate: is Jev enabled at all, independent of per-point state? */
export declare function isJevEnabled(config: JevConfig): boolean;
/**
 * Tri-state for one point: off | shadow | active.
 * Config gates first (key presence, master off, opt-in incl. the `all`
 * wildcard); an enabled point is active when code-activated, env-activated
 * (union semantics: either source suffices), otherwise shadow.
 */
export declare function pointState(point: string, config: JevConfig, activated?: ReadonlySet<string>): 'off' | 'shadow' | 'active';
/**
 * Recursively bound every string value to `max` chars. Applied to the state
 * sent to Jev and to the state recorded in the shadow log. Question
 * definitions are static text and are not bounded.
 */
export declare function boundExcerpts(value: unknown, max: number): unknown;
//# sourceMappingURL=config.d.ts.map