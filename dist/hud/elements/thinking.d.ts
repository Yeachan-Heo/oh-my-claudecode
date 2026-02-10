/**
 * OMC HUD - Thinking Indicator Element
 *
 * Renders extended thinking mode indicator with configurable format.
 */
import type { ThinkingState, ThinkingFormat } from '../types.js';
/**
 * Render thinking indicator based on format.
 *
 * @param state - Thinking state from transcript
 * @param format - Display format (bubble, brain, face, text)
 * @returns Formatted thinking indicator or null if not active
 */
export declare function renderThinking(state: ThinkingState | null, format?: ThinkingFormat): string | null;
//# sourceMappingURL=thinking.d.ts.map