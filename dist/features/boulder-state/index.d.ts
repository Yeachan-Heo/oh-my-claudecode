/**
 * Boulder State Module
 *
 * Manages the active work plan state for OMC orchestrator.
 * Named after OMC's boulder - the eternal task that must be rolled.
 *
 * Ported from oh-my-opencode's boulder-state.
 */
export type { BoulderState, PlanProgress, PlanSummary } from './types.js';
export { BOULDER_DIR, BOULDER_FILE, BOULDER_STATE_PATH, NOTEPAD_DIR, NOTEPAD_BASE_PATH, PLANNER_PLANS_DIR, PLAN_EXTENSION } from './constants.js';
export { getBoulderFilePath, readBoulderState, writeBoulderState, appendSessionId, clearBoulderState, findPlannerPlans, getPlanProgress, getPlanName, createBoulderState, getPlanSummaries, hasBoulder, getActivePlanPath } from './storage.js';
//# sourceMappingURL=index.d.ts.map