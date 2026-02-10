/**
 * OMC HUD - Context Element
 *
 * Renders context window usage display.
 */
import type { HudThresholds } from '../types.js';
/**
 * Render context window percentage.
 *
 * Format: ctx:67%
 */
export declare function renderContext(percent: number, thresholds: HudThresholds): string | null;
/**
 * Render context window with visual bar.
 *
 * Format: ctx:[████░░░░░░]67%
 */
export declare function renderContextWithBar(percent: number, thresholds: HudThresholds, barWidth?: number): string | null;
//# sourceMappingURL=context.d.ts.map