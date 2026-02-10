/**
 * OMC HUD - State Readers
 *
 * Read ralph, ultrawork, and PRD state from existing OMC files.
 * These are read-only functions that don't modify the state files.
 */
import type { RalphStateForHud, UltraworkStateForHud, PrdStateForHud } from './types.js';
import type { AutopilotStateForHud } from './elements/autopilot.js';
/**
 * Read Ralph Loop state for HUD display.
 * Returns null if no state file exists or on error.
 */
export declare function readRalphStateForHud(directory: string): RalphStateForHud | null;
/**
 * Read Ultrawork state for HUD display.
 * Checks only local .omc/state location.
 */
export declare function readUltraworkStateForHud(directory: string): UltraworkStateForHud | null;
/**
 * Read PRD state for HUD display.
 * Checks both root prd.json and .omc/prd.json.
 */
export declare function readPrdStateForHud(directory: string): PrdStateForHud | null;
/**
 * Read Autopilot state for HUD display.
 * Returns shape matching AutopilotStateForHud from elements/autopilot.ts.
 */
export declare function readAutopilotStateForHud(directory: string): AutopilotStateForHud | null;
/**
 * Check if any OMC mode is currently active
 */
export declare function isAnyModeActive(directory: string): boolean;
/**
 * Get active skill names for display
 */
export declare function getActiveSkills(directory: string): string[];
export type { AutopilotStateForHud } from './elements/autopilot.js';
//# sourceMappingURL=omc-state.d.ts.map