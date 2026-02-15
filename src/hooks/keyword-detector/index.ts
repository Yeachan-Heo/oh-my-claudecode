/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */

import { isEcomodeEnabled, isLowTierAgentsEnabled, isTeamEnabled } from '../../features/auto-update.js';

export type KeywordType =
  | 'cancel'      // Priority 1
  | 'ralph'       // Priority 2
  | 'autopilot'   // Priority 3
  | 'ultrapilot'  // Priority 4
  | 'team'        // Priority 4.5 (team mode)
  | 'ultrawork'   // Priority 5
  | 'ecomode'     // Priority 6
  | 'swarm'       // Priority 7
  | 'pipeline'    // Priority 8
  | 'ralplan'     // Priority 9
  | 'plan'        // Priority 10
  | 'tdd'         // Priority 11
  | 'ultrathink'  // Priority 13
  | 'deepsearch'  // Priority 14
  | 'analyze'     // Priority 15
  | 'codex'       // Priority 16
  | 'gemini';     // Priority 17

export interface DetectedKeyword {
  type: KeywordType;
  keyword: string;
  position: number;
}

/**
 * Autopilot keywords
 */
const AUTOPILOT_KEYWORDS = [
  'autopilot',
  'auto pilot',
  'auto-pilot',
  'autonomous',
  'full auto',
  'fullsend',
];

const AUTOPILOT_PHRASE_PATTERNS = [
  /\bbuild\s+me\s+/i,
  /\bcreate\s+me\s+/i,
  /\bmake\s+me\s+/i,
  /\bi\s+want\s+a\s+/i,
  /\bi\s+want\s+an\s+/i,
  /\bhandle\s+it\s+all\b/i,
  /\bend\s+to\s+end\b/i,
  /\be2e\s+this\b/i,
];

/**
 * Keyword patterns for each mode
 */
const KEYWORD_PATTERNS: Record<KeywordType, RegExp> = {
  cancel: /\b(cancelomc|stopomc)\b/i,
  ralph: /\b(ralph|don't stop|must complete|until done)\b/i,
  autopilot: /\b(autopilot|auto pilot|auto-pilot|autonomous|full auto|fullsend)\b/i,
  ultrapilot: /\b(ultrapilot|ultra-pilot)\b|\bparallel\s+build\b|\bswarm\s+build\b/i,
  ultrawork: /\b(ultrawork|ulw|uw)\b/i,
  // Keep `eco` first so "eco mode" matches "eco" (tests + docs expect keyword="eco").
  ecomode: /\b(eco|ecomode|eco-mode|eco\s+mode|efficient|budget|save-tokens)\b/i,
  swarm: /\bswarm\s+\d+\s+agents?\b|\bcoordinated\s+agents\b|\bteam\s+mode\b/i,
  team: /(?<!\b(?:my|the|our|a|his|her|their|its)\s)\bteam\b|\bcoordinated\s+team\b/i,
  pipeline: /\b(pipeline)\b|\bchain\s+agents\b/i,
  ralplan: /\b(ralplan)\b/i,
  plan: /\bplan\s+(this|the)\b/i,
  tdd: /\b(tdd)\b|\btest\s+first\b|\bred\s+green\b/i,
  ultrathink: /\b(ultrathink|think hard|think deeply)\b/i,
  deepsearch: /\b(deepsearch)\b|\bsearch\s+(the\s+)?(codebase|code|files?|project)\b|\bfind\s+(in\s+)?(codebase|code|all\s+files?)\b/i,
  analyze: /\b(deep\s*analyze)\b|\binvestigate\s+(the|this|why)\b|\bdebug\s+(the|this|why)\b/i,
  codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
  gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i
};

/**
 * Priority order for keyword detection
 */
const KEYWORD_PRIORITY: KeywordType[] = [
  'cancel', 'ralph', 'autopilot', 'ultrapilot', 'team', 'ultrawork', 'ecomode',
  'swarm', 'pipeline', 'ralplan', 'plan', 'tdd',
  'ultrathink', 'deepsearch', 'analyze', 'codex', 'gemini'
];

/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export function removeCodeBlocks(text: string): string {
  // Remove fenced code blocks (``` or ~~~)
  let result = text.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/~~~[\s\S]*?~~~/g, '');

  // Remove inline code (single backticks)
  result = result.replace(/`[^`]+`/g, '');

  return result;
}

/**
 * Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
 */
export function sanitizeForKeywordDetection(text: string): string {
  // Remove XML tag blocks (opening + content + closing; tag names must match)
  let result = text.replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '');
  // Remove self-closing XML tags
  result = result.replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '');
  // Remove URLs
  result = result.replace(/https?:\/\/\S+/g, '');
  // Remove file paths — requires leading / or ./ or multi-segment dir/file.ext
  result = result.replace(/(^|[\s"'`(])(?:\.?\/(?:[\w.-]+\/)*[\w.-]+|(?:[\w.-]+\/)+[\w.-]+\.\w+)/gm, '$1');
  // Remove code blocks (fenced and inline)
  result = removeCodeBlocks(result);
  return result;
}

/**
 * Extract prompt text from message parts
 */
export function extractPromptText(
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>
): string {
  return parts
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text!)
    .join(' ');
}

/**
 * Detect keywords in text and return matches with type info
 */
export function detectKeywordsWithType(
  text: string,
  _agentName?: string
): DetectedKeyword[] {
  const detected: DetectedKeyword[] = [];
  const cleanedText = sanitizeForKeywordDetection(text);
  const ecomodeActive = isEcomodeEnabled() && isLowTierAgentsEnabled();

  // Check autopilot phrases first (more specific than keywords)
  for (const pattern of AUTOPILOT_PHRASE_PATTERNS) {
    const match = cleanedText.match(pattern);
    if (match && match.index !== undefined) {
      detected.push({
        type: 'autopilot',
        keyword: match[0],
        position: match.index
      });
      break; // Only need one autopilot match
    }
  }

  // Check autopilot keywords
  for (const keyword of AUTOPILOT_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    const match = cleanedText.match(regex);
    if (match && match.index !== undefined) {
      // Avoid duplicates from phrase detection
      const position = cleanedText.toLowerCase().indexOf(keyword.toLowerCase());
      detected.push({
        type: 'autopilot',
        keyword,
        position: position >= 0 ? position : 0
      });
    }
  }

  // Check each keyword type
  for (const type of KEYWORD_PRIORITY) {
    // Skip team-related types when team feature is disabled
    if ((type === 'team' || type === 'ultrapilot' || type === 'swarm') && !isTeamEnabled()) {
      continue;
    }

    // Skip ecomode detection if disabled in config
    if (type === 'ecomode' && !ecomodeActive) {
      continue;
    }

    const pattern = KEYWORD_PATTERNS[type];
    const match = cleanedText.match(pattern);

    if (match && match.index !== undefined) {
      detected.push({
        type,
        keyword: match[0],
        position: match.index
      });

      // Legacy ultrapilot/swarm also activate team mode internally
      if (type === 'ultrapilot' || type === 'swarm') {
        detected.push({
          type: 'team',
          keyword: match[0],
          position: match.index
        });
      }
    }
  }

  return detected;
}

/**
 * Check if text contains any magic keyword
 */
export function hasKeyword(text: string): boolean {
  return detectKeywordsWithType(text).length > 0;
}

/**
 * Get all detected keywords with conflict resolution applied
 */
export function getAllKeywords(text: string): KeywordType[] {
  const detected = detectKeywordsWithType(text);

  if (detected.length === 0) return [];

  let types = [...new Set(detected.map(d => d.type))];
  const ecomodeActive = isEcomodeEnabled() && isLowTierAgentsEnabled();

  // Exclusive: cancel suppresses everything
  if (types.includes('cancel')) return ['cancel'];

  // Mutual exclusion: ecomode beats ultrawork (only if ecomode is enabled)
  if (types.includes('ecomode') && types.includes('ultrawork') && ecomodeActive) {
    types = types.filter(t => t !== 'ultrawork');
  }

  // Mutual exclusion: team beats autopilot (ultrapilot/swarm now map to team at detection)
  if (types.includes('team') && types.includes('autopilot')) {
    types = types.filter(t => t !== 'autopilot');
  }

  // Sort by priority order
  return KEYWORD_PRIORITY.filter(k => types.includes(k));
}

/**
 * Get the highest priority keyword detected with conflict resolution
 */
export function getPrimaryKeyword(text: string): DetectedKeyword | null {
  const allKeywords = getAllKeywords(text);

  if (allKeywords.length === 0) {
    return null;
  }

  // Get the highest priority keyword type
  const primaryType = allKeywords[0];

  // Find the original detected keyword for this type
  const detected = detectKeywordsWithType(text);
  const match = detected.find(d => d.type === primaryType);

  return match || null;
}
