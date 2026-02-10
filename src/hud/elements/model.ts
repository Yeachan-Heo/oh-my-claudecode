/**
 * OMC HUD - Model Element
 *
 * Renders the current model name.
 */

import { dim, cyan } from '../colors.js';
import { truncateToWidth } from '../../utils/string-width.js';

/**
 * Format model name for display.
 * Converts model IDs to friendly names.
 */
export function formatModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null;

  const id = modelId.toLowerCase();

  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';

  // Return original if not recognized (CJK-aware truncation)
  return truncateToWidth(modelId, 20);
}

/**
 * Render model element.
 */
export function renderModel(modelId: string | null | undefined): string | null {
  const name = formatModelName(modelId);
  if (!name) return null;
  return `${dim('model:')}${cyan(name)}`;
}
