/**
 * OMC HUD - Last Tool Element
 *
 * Renders the name of the most recently called tool in this session.
 */

import { dim } from '../colors.js';

/**
 * Render last tool name.
 *
 * Format: tool:Read
 */
export function renderLastTool(lastToolName: string | null): string | null {
  if (!lastToolName) return null;
  return `${dim('tool:')}${lastToolName}`;
}
