/**
 * Task Size Detector
 *
 * Classifies user prompts as small/medium/large to prevent over-orchestration.
 *
 * Issue #790: OMC orchestration modes (ralph, autopilot, team) are overkill for small tasks.
 * This module provides a pre-execution gate that routes small tasks to lightweight paths.
 */

export type TaskSize = 'small' | 'medium' | 'large';

export interface TaskSizeResult {
  size: TaskSize;
  reason: string;
  wordCount: number;
  hasEscapeHatch: boolean;
  escapePrefixUsed?: string;
}

/**
 * Word limit thresholds for task size classification.
 * Prompts under smallLimit are classified as small (unless overridden).
 * Prompts over largeLimit are classified as large.
 */
export interface TaskSizeThresholds {
  smallWordLimit: number;
  largeWordLimit: number;
}

export const DEFAULT_THRESHOLDS: TaskSizeThresholds = {
  smallWordLimit: 50,
  largeWordLimit: 200,
};

/**
 * Escape hatch prefixes that force small/lightweight mode.
 * Users can prefix their prompt with these to skip heavy orchestration.
 */
const ESCAPE_HATCH_PREFIXES = [
  'quick:',
  'simple:',
  'tiny:',
  'minor:',
  'small:',
  'just:',
  'only:',
];

/**
 * Keywords/phrases that strongly indicate a small, bounded task.
 * If any of these appear and no large indicators are present, bias toward small.
 */
const SMALL_TASK_SIGNALS = [
  /\btypo\b/i,
  /\bspelling\b/i,
  /\brename\s+\w+\s+to\b/i,
  /\bone[\s-]liner?\b/i,
  /\bone[\s-]line\s+fix\b/i,
  /\bsingle\s+file\b/i,
  /\bin\s+this\s+file\b/i,
  /\bthis\s+function\b/i,
  /\bthis\s+line\b/i,
  /\bminor\s+(fix|change|update|tweak)\b/i,
  /\bfix\s+(a\s+)?typo\b/i,
  /\badd\s+a?\s*comment\b/i,
  /\bwhitespace\b/i,
  /\bindentation\b/i,
  /\bformat(ting)?\s+(this|the)\b/i,
  /\bquick\s+fix\b/i,
  /\bsmall\s+(fix|change|tweak|update)\b/i,
  /\bupdate\s+(the\s+)?version\b/i,
  /\bbump\s+version\b/i,
];

/**
 * Keywords/phrases that strongly indicate a large, cross-cutting task.
 * These bias toward large classification even for short prompts.
 */
const LARGE_TASK_SIGNALS = [
  /\barchitect(ure|ural)?\b/i,
  /\brefactor\b/i,
  /\bredesign\b/i,
  /\bfrom\s+scratch\b/i,
  /\bcross[\s-]cutting\b/i,
  /\bentire\s+(codebase|project|application|app|system)\b/i,
  /\ball\s+(files|modules|components)\b/i,
  /\bmultiple\s+files\b/i,
  /\bacross\s+(the\s+)?(codebase|project|files|modules)\b/i,
  /\bsystem[\s-]wide\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bfull[\s-]stack\b/i,
  /\bend[\s-]to[\s-]end\b/i,
  /\boverhaul\b/i,
  /\bcomprehensive\b/i,
  /\bextensive\b/i,
  /\bimplement\s+(a\s+)?(new\s+)?system\b/i,
  /\bbuild\s+(a\s+)?(complete|full|new)\b/i,
];

/**
 * Count words in a prompt (splits on whitespace).
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check if the prompt starts with a lightweight escape hatch prefix.
 * Returns the prefix if found, null otherwise.
 */
export function detectEscapeHatch(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  for (const prefix of ESCAPE_HATCH_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

/**
 * Check for small task signal patterns (single file, typo, minor, etc.)
 */
export function hasSmallTaskSignals(text: string): boolean {
  return SMALL_TASK_SIGNALS.some(pattern => pattern.test(text));
}

/**
 * Check for large task signal patterns (architecture, refactor, entire codebase, etc.)
 */
export function hasLargeTaskSignals(text: string): boolean {
  return LARGE_TASK_SIGNALS.some(pattern => pattern.test(text));
}

/**
 * Classify a user prompt as small, medium, or large.
 *
 * Classification rules (in priority order):
 * 1. Escape hatch prefix (`quick:`, `simple:`, etc.) → always small
 * 2. Large task signals (architecture, refactor, entire codebase) → large
 * 3. Prompt > largeWordLimit words → large
 * 4. Small task signals (typo, single file, rename) AND prompt < largeWordLimit → small
 * 5. Prompt < smallWordLimit words → small
 * 6. Everything else → medium
 */
export function classifyTaskSize(
  text: string,
  thresholds: TaskSizeThresholds = DEFAULT_THRESHOLDS,
): TaskSizeResult {
  const wordCount = countWords(text);
  const escapePrefix = detectEscapeHatch(text);

  // Rule 1: Explicit escape hatch → always small
  if (escapePrefix !== null) {
    return {
      size: 'small',
      reason: `Escape hatch prefix detected: "${escapePrefix}"`,
      wordCount,
      hasEscapeHatch: true,
      escapePrefixUsed: escapePrefix,
    };
  }

  const hasLarge = hasLargeTaskSignals(text);
  const hasSmall = hasSmallTaskSignals(text);

  // Rule 2: Large task signals always classify as large (explicit scope indicators beat word count)
  if (hasLarge) {
    return {
      size: 'large',
      reason: 'Large task signals detected (architecture/refactor/cross-cutting scope)',
      wordCount,
      hasEscapeHatch: false,
    };
  }

  // Rule 3: Long prompt → large
  if (wordCount > thresholds.largeWordLimit) {
    return {
      size: 'large',
      reason: `Prompt length (${wordCount} words) exceeds large task threshold (${thresholds.largeWordLimit})`,
      wordCount,
      hasEscapeHatch: false,
    };
  }

  // Rule 4: Small signals + within limits → small
  if (hasSmall && !hasLarge) {
    return {
      size: 'small',
      reason: 'Small task signals detected (single file / minor change)',
      wordCount,
      hasEscapeHatch: false,
    };
  }

  // Rule 5: Short prompt → small
  if (wordCount <= thresholds.smallWordLimit) {
    return {
      size: 'small',
      reason: `Prompt length (${wordCount} words) is within small task threshold (${thresholds.smallWordLimit})`,
      wordCount,
      hasEscapeHatch: false,
    };
  }

  // Rule 6: Default → medium
  return {
    size: 'medium',
    reason: `Prompt length (${wordCount} words) is in medium range`,
    wordCount,
    hasEscapeHatch: false,
  };
}

/**
 * Heavy orchestration keyword types that should be suppressed for small tasks.
 * These modes spin up multiple agents and are overkill for single-file/minor changes.
 */
export const HEAVY_MODE_KEYWORDS = new Set([
  'ralph',
  'autopilot',
  'team',
  'ultrawork',
  'ultrapilot',
  'swarm',
  'pipeline',
  'ralplan',
  'ccg',
]);

/**
 * Check if a keyword type is a heavy orchestration mode.
 */
export function isHeavyMode(keywordType: string): boolean {
  return HEAVY_MODE_KEYWORDS.has(keywordType);
}
