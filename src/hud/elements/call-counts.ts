/**
 * OMC HUD - Call Counts Element
 *
 * Renders real-time counts of tool calls, agent invocations, and skill usages
 * on the right side of the HUD status line. (Issue #710)
 *
 * Format: 🔧42 🤖7 ⚡3  (emoji)
 * Format: T:42 A:7 S:3   (ASCII fallback / explicit override)
 */

// Windows terminals (cmd.exe, PowerShell, Windows Terminal) may not render
// multi-byte emoji correctly, causing HUD layout corruption.
// WSL terminals may also lack emoji support.
import { isWSL } from '../../platform/index.js';
import type { CallCountsFormat } from '../types.js';

function shouldUseAscii(format: CallCountsFormat = 'auto'): boolean {
  if (format === 'ascii') return true;
  if (format === 'emoji') return false;
  return process.platform === 'win32' || isWSL();
}

function getIcons(format: CallCountsFormat = 'auto') {
  const useAscii = shouldUseAscii(format);
  return {
    tool: useAscii ? 'T:' : '\u{1F527}',
    agent: useAscii ? 'A:' : '\u{1F916}',
    skill: useAscii ? 'S:' : '\u26A1',
  };
}

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
  format: CallCountsFormat = 'auto',
): string | null {
  const parts: string[] = [];
  const icons = getIcons(format);

  if (toolCalls > 0) {
    parts.push(`${icons.tool}${toolCalls}`);
  }
  if (agentInvocations > 0) {
    parts.push(`${icons.agent}${agentInvocations}`);
  }
  if (skillUsages > 0) {
    parts.push(`${icons.skill}${skillUsages}`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
