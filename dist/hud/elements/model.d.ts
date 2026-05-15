/**
 * OMC HUD - Model Element
 *
 * Renders the current model name.
 */
import { type HudLabels, type ModelFormat } from '../types.js';
/**
 * Format model name for display.
 * Converts model IDs to friendly names based on the requested format.
 */
export declare function formatModelName(modelId: string | null | undefined, format?: ModelFormat): string | null;
/**
 * Render model element.
 */
export declare function renderModel(modelId: string | null | undefined, format?: ModelFormat, labels?: Pick<HudLabels, 'model'>): string | null;
//# sourceMappingURL=model.d.ts.map