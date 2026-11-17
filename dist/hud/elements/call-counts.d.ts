/**
 * OMC HUD - Call Counts Element
 *
 * Renders real-time counts of tool calls, agent invocations, and skill usages
 * on the right side of the HUD status line. (Issue #710)
 *
 * Format: 🔧42 🤖7 ⚡3  (emoji)
 * Format: T:42 A:7 S:3   (ASCII fallback / explicit override)
 */
import type { CallCountsFormat, HudLabels } from '../types.js';
/**
 * Render call counts badge.
 *
 * Omits a counter entirely when its count is zero to keep output terse.
 * Returns null if all counts are zero (nothing to show).
 *
 * @param toolCalls - Total tool_use blocks seen in transcript
 * @param agentInvocations - Total Task/proxy_Task calls seen in transcript
 * @param skillUsages - Total Skill/proxy_Skill calls seen in transcript
 */
export declare function renderCallCounts(toolCalls: number, agentInvocations: number, skillUsages: number, format?: CallCountsFormat, labels?: Pick<HudLabels, 'tool' | 'agent' | 'skill'>): string | null;
//# sourceMappingURL=call-counts.d.ts.map