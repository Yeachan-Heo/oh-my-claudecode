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
  ULTRAPILOT: 'ultrapilot',
  SWARM: 'swarm',
  PIPELINE: 'pipeline',
  TEAM: 'team',
  RALPH: 'ralph',
  ULTRAWORK: 'ultrawork',
  ULTRAQA: 'ultraqa',
} as const;

/** Union type derived from the constant map. */
export type ModeName = typeof MODE_NAMES[keyof typeof MODE_NAMES];

/**
 * All mode names as an array (useful for iteration).
 * Order matches the canonical ExecutionMode union in mode-registry/types.ts.
 */
export const ALL_MODE_NAMES: readonly ModeName[] = [
  MODE_NAMES.AUTOPILOT,
  MODE_NAMES.ULTRAPILOT,
  MODE_NAMES.SWARM,
  MODE_NAMES.PIPELINE,
  MODE_NAMES.TEAM,
  MODE_NAMES.RALPH,
  MODE_NAMES.ULTRAWORK,
  MODE_NAMES.ULTRAQA,
] as const;

/**
 * Mode state file mapping — the canonical filename for each mode's state file
 * relative to `.omc/state/`.
 */
export const MODE_STATE_FILE_MAP: Readonly<Record<ModeName, string>> = {
  [MODE_NAMES.AUTOPILOT]: 'autopilot-state.json',
  [MODE_NAMES.ULTRAPILOT]: 'ultrapilot-state.json',
  [MODE_NAMES.SWARM]: 'swarm.db',
  [MODE_NAMES.PIPELINE]: 'pipeline-state.json',
  [MODE_NAMES.TEAM]: 'team-state.json',
  [MODE_NAMES.RALPH]: 'ralph-state.json',
  [MODE_NAMES.ULTRAWORK]: 'ultrawork-state.json',
  [MODE_NAMES.ULTRAQA]: 'ultraqa-state.json',
};

/**
 * Mode state files used by session-end cleanup.
 * Includes marker files for modes that use them.
 */
export const SESSION_END_MODE_STATE_FILES: readonly { file: string; mode: string }[] = [
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT], mode: MODE_NAMES.AUTOPILOT },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAPILOT], mode: MODE_NAMES.ULTRAPILOT },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK], mode: MODE_NAMES.ULTRAWORK },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAQA], mode: MODE_NAMES.ULTRAQA },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.PIPELINE], mode: MODE_NAMES.PIPELINE },
  // Swarm uses marker file + SQLite
  { file: 'swarm-active.marker', mode: MODE_NAMES.SWARM },
  { file: 'swarm-summary.json', mode: MODE_NAMES.SWARM },
];

/**
 * Modes detected by session-end for metrics reporting.
 */
export const SESSION_METRICS_MODE_FILES: readonly { file: string; mode: string }[] = [
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT], mode: MODE_NAMES.AUTOPILOT },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAPILOT], mode: MODE_NAMES.ULTRAPILOT },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK], mode: MODE_NAMES.ULTRAWORK },
  { file: 'swarm-state.json', mode: MODE_NAMES.SWARM },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.PIPELINE], mode: MODE_NAMES.PIPELINE },
];
