/**
 * OMC HUD - State Readers
 *
 * Read ralph, ultrawork, and PRD state from existing OMC files.
 * These are read-only functions that don't modify the state files.
 */
import type { RalphStateForHud, UltraworkStateForHud, PrdStateForHud } from './types.js';
import type { AutopilotStateForHud } from './elements/autopilot.js';
import type { GraphStateForHud } from './elements/graph.js';
/**
 * Read Ralph Loop state for HUD display.
 * Returns null if no state file exists or on error.
 */
export declare function readRalphStateForHud(directory: string, sessionId?: string): RalphStateForHud | null;
/**
 * Read Ultrawork state for HUD display.
 * Checks only local .omc/state location.
 */
export declare function readUltraworkStateForHud(directory: string, sessionId?: string): UltraworkStateForHud | null;
/**
 * Read PRD state for HUD display.
 * Checks both root prd.json and .omc/prd.json.
 */
export declare function readPrdStateForHud(directory: string): PrdStateForHud | null;
/**
 * Read Autopilot state for HUD display.
 * Returns shape matching AutopilotStateForHud from elements/autopilot.ts.
 */
export declare function readAutopilotStateForHud(directory: string, sessionId?: string): AutopilotStateForHud | null;
/**
 * Read the validated Graph state and return a bounded public projection.
 * Durable waits are intentionally not hidden by the legacy two-hour HUD cutoff.
 */
export declare function readGraphStateForHud(directory: string, sessionId?: string): GraphStateForHud | null;
/**
 * Check if any OMC mode is currently active
 */
export declare function isAnyModeActive(directory: string, sessionId?: string): boolean;
/**
 * Get active skill names for display
 */
export declare function getActiveSkills(directory: string, sessionId?: string): string[];
export type { AutopilotStateForHud } from './elements/autopilot.js';
//# sourceMappingURL=omc-state.d.ts.map