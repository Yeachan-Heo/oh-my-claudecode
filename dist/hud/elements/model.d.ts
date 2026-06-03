/**
 * OMC HUD - Model Element
 *
 * Renders the current model name.
 */
import { type HudLabels, type ModelFormat } from '../types.js';
/**
 * Detect whether the current session is running with a 1M context window.
 *
 * The authoritative signal is `context_window_size` reported by Claude Code's
 * statusline stdin: it is 1,000,000 for both `[1m]`-tagged models AND natively
 * 1M models (e.g. `claude-opus-4-8`) whose display name carries no "1M" hint.
 * The `[1m]` id tag is a defensive fallback for when the size is unavailable.
 */
export declare function hasOneMillionContext(modelId: string | null | undefined, contextWindowSize?: number | null): boolean;
/**
 * Format model name for display.
 * Converts model IDs to friendly names based on the requested format.
 */
export declare function formatModelName(modelId: string | null | undefined, format?: ModelFormat): string | null;
/**
 * Render model element.
 */
export declare function renderModel(modelId: string | null | undefined, format?: ModelFormat, labels?: Pick<HudLabels, 'model'>, contextWindowSize?: number | null): string | null;
//# sourceMappingURL=model.d.ts.map