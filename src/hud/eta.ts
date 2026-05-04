/**
 * OMC HUD - Context ETA
 *
 * Predicts time-to-context-full based on rolling percent samples.
 * Stub only — implementation lands in the next PR.
 */

export type ContextEtaSample = {
  timestampMs: number;
  percent: number; // 0-100
};

export type ContextEtaResult = {
  etaMinutes: number | null; // null = don't display
  samples: ContextEtaSample[]; // updated rolling window, max 36
};

/**
 * Stub implementation — returns sentinel values so TDD red tests fail
 * on assertions. Replace with real algorithm in the implementation PR.
 */
export function updateContextEta(
  _currentPercent: number,
  _previousSamples: ContextEtaSample[],
  _nowMs: number,
): ContextEtaResult {
  return { etaMinutes: null, samples: [] };
}
