/**
 * OMC HUD - PRD Element
 *
 * Renders current PRD story display.
 */

import type { PrdStateForHud } from '../types.js';
import { RESET } from '../colors.js';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';

/**
 * Render current PRD story.
 * Returns null if no PRD is active.
 *
 * Format: US-002
 */
export function renderPrd(state: PrdStateForHud | null): string | null {
  if (!state) {
    return null;
  }

  const { currentStoryId, completed, total } = state;

  // If all complete, show completion
  if (completed === total) {
    return `${GREEN}PRD:done${RESET}`;
  }

  // Show current story ID
  if (currentStoryId) {
    return `${CYAN}${currentStoryId}${RESET}`;
  }

  return null;
}

/**
 * Render PRD with progress (for full mode).
 *
 * Format: US-002 (2/5)
 */
export function renderPrdWithProgress(state: PrdStateForHud | null): string | null {
  if (!state) {
    return null;
  }

  const { currentStoryId, completed, total } = state;

  // If all complete, show completion
  if (completed === total) {
    return `${GREEN}PRD:${completed}/${total} done${RESET}`;
  }

  // Show current story with progress
  if (currentStoryId) {
    return `${CYAN}${currentStoryId}${RESET} ${DIM}(${completed}/${total})${RESET}`;
  }

  // No current story but PRD exists
  return `${DIM}PRD:${completed}/${total}${RESET}`;
}
