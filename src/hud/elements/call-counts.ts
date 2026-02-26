/**
 * OMC HUD - Call Counts Element
 *
 * Renders real-time counts of tool calls, agent invocations, and skill usages
 * on the right side of the HUD status line. (Issue #710)
 *
 * Format: 🔧42 🤖7 ⚡3  (Unix)
 * Format: T:42 A:7 S:3   (Windows - ASCII fallback to avoid rendering issues)
 */

// Windows terminals (cmd.exe, PowerShell, Windows Terminal) may not render
// multi-byte emoji correctly, causing HUD layout corruption.
// WSL terminals may also lack emoji support.
import { isWSL } from '../../platform/index.js';
const useAscii = process.platform === 'win32' || isWSL();
const TOOL_ICON = useAscii ? 'T:' : '\u{1F527}';
const AGENT_ICON = useAscii ? 'A:' : '\u{1F916}';
const SKILL_ICON = useAscii ? 'S:' : '\u26A1';

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
export function renderCallCounts(
  toolCalls: number,
  agentInvocations: number,
  skillUsages: number,
): string | null {
  const parts: string[] = [];

  if (toolCalls > 0) {
    parts.push(`${TOOL_ICON}${toolCalls}`);
  }
  if (agentInvocations > 0) {
    parts.push(`${AGENT_ICON}${agentInvocations}`);
  }
  if (skillUsages > 0) {
    parts.push(`${SKILL_ICON}${skillUsages}`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
