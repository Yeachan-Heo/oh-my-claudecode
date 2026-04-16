/**
 * OMC HUD - Model Element
 *
 * Renders the current model name.
 */

import { cyan } from '../colors.js';
import { truncateToWidth } from '../../utils/string-width.js';
import type { ModelFormat } from '../types.js';

/**
 * Extract version from a model ID string.
 * E.g., 'claude-opus-4-7-20260416' -> '4.7'
 *       'claude-sonnet-4-6-20260217' -> '4.6'
 *       'claude-haiku-4-5-20251001' -> '4.5'
 */
function extractVersion(modelId: string): string | null {
  // Match hyphenated ID patterns like opus-4-6, sonnet-4-5, haiku-4-5
  const idMatch = modelId.match(/(?:opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (idMatch) return `${idMatch[1]}.${idMatch[2]}`;

  // Match display name patterns like "Sonnet 4.5", "Opus 4.7"
  const displayMatch = modelId.match(/(?:opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i);
  if (displayMatch) return displayMatch[1];

  return null;
}

/**
 * Format model name for display.
 * Converts model IDs to friendly names based on the requested format.
 */
export function formatModelName(modelId: string | null | undefined, format: ModelFormat = 'short'): string | null {
  if (!modelId) return null;

  if (format === 'full') {
    return truncateToWidth(modelId, 40);
  }

  const id = modelId.toLowerCase();
  let shortName: string | null = null;

  if (id.includes('opus')) shortName = 'Opus';
  else if (id.includes('sonnet')) shortName = 'Sonnet';
  else if (id.includes('haiku')) shortName = 'Haiku';

  if (!shortName) {
    // Return original if not recognized (CJK-aware truncation)
    return truncateToWidth(modelId, 20);
  }

  if (format === 'versioned') {
    const version = extractVersion(id);
    if (version) return `${shortName} ${version}`;
  }

  return shortName;
}

/**
 * Render model element.
 */
export function renderModel(modelId: string | null | undefined, format: ModelFormat = 'short'): string | null {
  const name = formatModelName(modelId, format);
  if (!name) return null;
  return cyan(name);
}
