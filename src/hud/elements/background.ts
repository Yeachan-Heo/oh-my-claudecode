/**
 * OMC HUD - Background Tasks Element
 *
 * Renders background task count display.
 */

import type { BackgroundTask } from '../types.js';
import { RESET } from '../colors.js';
import { truncateToWidth } from '../../utils/string-width.js';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

const MAX_CONCURRENT = 5;

/**
 * Render background task count.
 * Returns null if no tasks are running.
 *
 * Format: bg:3/5
 */
export function renderBackground(tasks: BackgroundTask[]): string | null {
  const running = tasks.filter((t) => t.status === 'running').length;

  if (running === 0) {
    return null;
  }

  // Color based on capacity usage
  let color: string;
  if (running >= MAX_CONCURRENT) {
    color = YELLOW; // At capacity
  } else if (running >= MAX_CONCURRENT - 1) {
    color = CYAN; // Near capacity
  } else {
    color = GREEN; // Plenty of room
  }

  return `bg:${color}${running}/${MAX_CONCURRENT}${RESET}`;
}

/**
 * Render background tasks with descriptions (for full mode).
 *
 * Format: bg:3/5 [explore,architect,...]
 */
export function renderBackgroundDetailed(tasks: BackgroundTask[]): string | null {
  const running = tasks.filter((t) => t.status === 'running');

  if (running.length === 0) {
    return null;
  }

  // Color based on capacity
  let color: string;
  if (running.length >= MAX_CONCURRENT) {
    color = YELLOW;
  } else if (running.length >= MAX_CONCURRENT - 1) {
    color = CYAN;
  } else {
    color = GREEN;
  }

  // Get short descriptions
  const descriptions = running.slice(0, 3).map((t) => {
    // Extract agent type short name if available
    if (t.agentType) {
      const parts = t.agentType.split(':');
      return parts[parts.length - 1];
    }
    // Otherwise use truncated description (CJK-aware)
    return truncateToWidth(t.description, 8, '');
  });

  const suffix = running.length > 3 ? ',+' + (running.length - 3) : '';
  return `bg:${color}${running.length}/${MAX_CONCURRENT}${RESET} ${DIM}[${descriptions.join(',')}${suffix}]${RESET}`;
}
