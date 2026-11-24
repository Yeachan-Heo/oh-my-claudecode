/**
 * OMC HUD - PRD Element
 *
 * Renders current PRD story display.
 */
import type { PrdStateForHud } from '../types.js';
/**
 * Render current PRD story.
 * Returns null if no PRD is active.
 *
 * Format: US-002
 */
export declare function renderPrd(state: PrdStateForHud | null): string | null;
/**
 * Render PRD with progress (for full mode).
 *
 * Format: US-002 (2/5)
 */
export declare function renderPrdWithProgress(state: PrdStateForHud | null): string | null;
//# sourceMappingURL=prd.d.ts.map