/**
 * Mode Names - Single source of truth for all execution mode name constants.
 *
 * Every module that references mode names by string should import from here
 * instead of hardcoding literals. This prevents drift when modes are added,
 * renamed, or removed.
 */
/** All supported execution mode identifiers. */
export const MODE_NAMES = {
    AUTOPILOT: 'autopilot',
    TEAM: 'team',
    RALPH: 'ralph',
    ULTRAWORK: 'ultrawork',
    ULTRAQA: 'ultraqa',
};
/**
 * Deprecated mode names removed in #1131 (pipeline unification).
 * Kept as constants for deprecation warnings and migration paths.
 */
export const DEPRECATED_MODE_NAMES = {
    ULTRAPILOT: 'ultrapilot',
    SWARM: 'swarm',
    PIPELINE: 'pipeline',
};
/**
 * All mode names as an array (useful for iteration).
 * Order matches the canonical ExecutionMode union in mode-registry/types.ts.
 */
export const ALL_MODE_NAMES = [
    MODE_NAMES.AUTOPILOT,
    MODE_NAMES.TEAM,
    MODE_NAMES.RALPH,
    MODE_NAMES.ULTRAWORK,
    MODE_NAMES.ULTRAQA,
];
/**
 * Mode state file mapping — the canonical filename for each mode's state file
 * relative to `.omc/state/`.
 */
export const MODE_STATE_FILE_MAP = {
    [MODE_NAMES.AUTOPILOT]: 'autopilot-state.json',
    [MODE_NAMES.TEAM]: 'team-state.json',
    [MODE_NAMES.RALPH]: 'ralph-state.json',
    [MODE_NAMES.ULTRAWORK]: 'ultrawork-state.json',
    [MODE_NAMES.ULTRAQA]: 'ultraqa-state.json',
};
/**
 * Mode state files used by session-end cleanup.
 * Includes marker files for modes that use them.
 */
export const SESSION_END_MODE_STATE_FILES = [
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT], mode: MODE_NAMES.AUTOPILOT },
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK], mode: MODE_NAMES.ULTRAWORK },
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAQA], mode: MODE_NAMES.ULTRAQA },
];
/**
 * Modes detected by session-end for metrics reporting.
 */
export const SESSION_METRICS_MODE_FILES = [
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT], mode: MODE_NAMES.AUTOPILOT },
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
    { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK], mode: MODE_NAMES.ULTRAWORK },
];
//# sourceMappingURL=mode-names.js.map