/**
 * Mode Names - Single source of truth for all execution mode name constants.
 *
 * Every module that references mode names by string should import from here
 * instead of hardcoding literals. This prevents drift when modes are added,
 * renamed, or removed.
 */
/** All supported execution mode identifiers. */
export declare const MODE_NAMES: {
    readonly AUTOPILOT: "autopilot";
    readonly TEAM: "team";
    readonly RALPH: "ralph";
    readonly ULTRAWORK: "ultrawork";
    readonly ULTRAQA: "ultraqa";
};
/**
 * Deprecated mode names removed in #1131 (pipeline unification).
 * Kept as constants for deprecation warnings and migration paths.
 */
export declare const DEPRECATED_MODE_NAMES: {
    readonly ULTRAPILOT: "ultrapilot";
    readonly SWARM: "swarm";
    readonly PIPELINE: "pipeline";
};
/** Union type derived from the constant map. */
export type ModeName = typeof MODE_NAMES[keyof typeof MODE_NAMES];
/**
 * All mode names as an array (useful for iteration).
 * Order matches the canonical ExecutionMode union in mode-registry/types.ts.
 */
export declare const ALL_MODE_NAMES: readonly ModeName[];
/**
 * Mode state file mapping — the canonical filename for each mode's state file
 * relative to `.omc/state/`.
 */
export declare const MODE_STATE_FILE_MAP: Readonly<Record<ModeName, string>>;
/**
 * Mode state files used by session-end cleanup.
 * Includes marker files for modes that use them.
 */
export declare const SESSION_END_MODE_STATE_FILES: readonly {
    file: string;
    mode: string;
}[];
/**
 * Modes detected by session-end for metrics reporting.
 */
export declare const SESSION_METRICS_MODE_FILES: readonly {
    file: string;
    mode: string;
}[];
//# sourceMappingURL=mode-names.d.ts.map