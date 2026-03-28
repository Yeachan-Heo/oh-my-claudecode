/**
 * OMC HUD - Token Usage Element
 *
 * Renders last-request input/output token usage from transcript metadata.
 * Format: tok:i45k/o2k [r2k] [cr:38k(84%)] [cw:1k] [s120k]
 */

import type { LastRequestTokenUsage } from '../types.js';
import { formatTokenCount } from '../../cli/utils/formatting.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';

export function renderTokenUsage(
  usage: LastRequestTokenUsage | null | undefined,
  sessionTotalTokens?: number | null,
): string | null {
  if (!usage) return null;

  const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (!hasUsage) return null;

  const parts = [
    `${DIM}tok:${RESET}i${formatTokenCount(usage.inputTokens)}/o${formatTokenCount(usage.outputTokens)}`,
  ];

  if (usage.reasoningTokens && usage.reasoningTokens > 0) {
    parts.push(`r${formatTokenCount(usage.reasoningTokens)}`);
  }

  if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
    const pct = usage.inputTokens > 0
      ? Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)
      : 0;
    parts.push(`${GREEN}cr:${formatTokenCount(usage.cacheReadTokens)}(${pct}%)${RESET}`);
  }

  if (usage.cacheCreationTokens && usage.cacheCreationTokens > 0) {
    parts.push(`${DIM}cw:${formatTokenCount(usage.cacheCreationTokens)}${RESET}`);
  }

  if (sessionTotalTokens && sessionTotalTokens > 0) {
    parts.push(`${DIM}s${formatTokenCount(sessionTotalTokens)}${RESET}`);
  }

  return parts.join(' ');
}
