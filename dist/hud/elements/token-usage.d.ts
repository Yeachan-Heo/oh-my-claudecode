/**
 * OMC HUD - Token Usage Element
 *
 * Renders last-request input/output token usage from transcript metadata.
 */
import type { HudLabels, LastRequestTokenUsage } from '../types.js';
export declare function renderTokenUsage(usage: LastRequestTokenUsage | null | undefined, sessionTotalTokens?: number | null, labels?: Pick<HudLabels, 'tokens'>): string | null;
//# sourceMappingURL=token-usage.d.ts.map