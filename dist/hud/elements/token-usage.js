/**
 * OMC HUD - Token Usage Element
 *
 * Renders last-request input/output token usage from transcript metadata.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { formatTokenCount } from '../../cli/utils/formatting.js';
export function renderTokenUsage(usage, sessionTotalTokens, labels = DEFAULT_HUD_LABELS) {
    if (!usage)
        return null;
    const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
    if (!hasUsage)
        return null;
    const parts = [
        `${labels.tokens}:i${formatTokenCount(usage.inputTokens)}/o${formatTokenCount(usage.outputTokens)}`,
    ];
    if (usage.reasoningTokens && usage.reasoningTokens > 0) {
        parts.push(`r${formatTokenCount(usage.reasoningTokens)}`);
    }
    if (sessionTotalTokens && sessionTotalTokens > 0) {
        parts.push(`s${formatTokenCount(sessionTotalTokens)}`);
    }
    return parts.join(' ');
}
//# sourceMappingURL=token-usage.js.map