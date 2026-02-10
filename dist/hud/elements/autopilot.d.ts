/**
 * OMC HUD - Autopilot Element
 *
 * Renders autopilot phase and progress display.
 */
import type { HudThresholds } from '../types.js';
export interface AutopilotStateForHud {
    active: boolean;
    phase: string;
    iteration: number;
    maxIterations: number;
    tasksCompleted?: number;
    tasksTotal?: number;
    filesCreated?: number;
}
/**
 * Render autopilot state.
 * Returns null if autopilot is not active.
 *
 * Format: [AUTOPILOT] Phase 2/5: Plan | Tasks: 5/12
 */
export declare function renderAutopilot(state: AutopilotStateForHud | null, _thresholds?: HudThresholds): string | null;
/**
 * Render compact autopilot status for minimal displays.
 *
 * Format: AP:3/5 or AP:Done
 */
export declare function renderAutopilotCompact(state: AutopilotStateForHud | null): string | null;
//# sourceMappingURL=autopilot.d.ts.map