/**
 * OMC HUD - Background Tasks Element
 *
 * Renders background task count display.
 */
import type { BackgroundTask } from '../types.js';
/**
 * Render background task count.
 * Returns null if no tasks are running.
 *
 * Format: bg:3/5
 */
export declare function renderBackground(tasks: BackgroundTask[]): string | null;
/**
 * Render background tasks with descriptions (for full mode).
 *
 * Format: bg:3/5 [explore,architect,...]
 */
export declare function renderBackgroundDetailed(tasks: BackgroundTask[]): string | null;
//# sourceMappingURL=background.d.ts.map