/**
 * OMC HUD - Ralph Element
 *
 * Renders Ralph loop iteration display.
 */
import type { RalphStateForHud, HudLabels, HudThresholds } from '../types.js';
/**
 * Render Ralph loop state.
 * Returns null if ralph is not active.
 *
 * Format: ralph:3/10
 */
export declare function renderRalph(state: RalphStateForHud | null, thresholds: HudThresholds, labels?: Pick<HudLabels, 'ralph'>): string | null;
//# sourceMappingURL=ralph.d.ts.map