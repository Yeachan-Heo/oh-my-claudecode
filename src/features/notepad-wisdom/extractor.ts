/**
 * Wisdom Extractor
 *
 * Parses agent completion responses to extract wisdom entries.
 */

import type { WisdomCategory } from './types.js';

export interface ExtractedWisdom {
  category: WisdomCategory;
  content: string;
}

/**
 * Extract wisdom from agent completion response
 *
 * Looks for wisdom blocks in formats like:
 * - <wisdom category="learnings">content</wisdom>
 * - <learning>content</learning>
 * - <decision>content</decision>
 * - <issue>content</issue>
 * - <problem>content</problem>
 */
export function extractWisdomFromCompletion(response: string): ExtractedWisdom[] {
  const extracted: ExtractedWisdom[] = [];

  // Pattern 1: <wisdom category="...">content</wisdom>
  const wisdomTagRegex = /<wisdom\s+category=["'](\w+)["']>([\s\S]*?)<\/wisdom>/gi;
  let match;

  while ((match = wisdomTagRegex.exec(response)) !== null) {
    const category = match[1].toLowerCase() as WisdomCategory;
    const content = match[2].trim();

    if (isValidCategory(category) && content) {
      extracted.push({ category, content });
    }
  }

  // Pattern 2: <learning>, <decision>, <issue>, <problem> tags
  const _categories: WisdomCategory[] = ['learnings', 'decisions', 'issues', 'problems'];
  const singularMap: Record<string, WisdomCategory> = {
    learning: 'learnings',
    decision: 'decisions',
    issue: 'issues',
    problem: 'problems',
  };

  for (const [singular, category] of Object.entries(singularMap)) {
    const tagRegex = new RegExp(String.raw`<${singular}>([\s\S]*?)</${singular}>`, 'gi');

    while ((match = tagRegex.exec(response)) !== null) {
      const content = match[1].trim();
      if (content) {
        extracted.push({ category, content });
      }
    }
  }

  return extracted;
}

/**
 * Validate wisdom category
 */
function isValidCategory(category: string): category is WisdomCategory {
  return ['learnings', 'decisions', 'issues', 'problems'].includes(category);
}

/**
 * Extract wisdom by category
 */
export function extractWisdomByCategory(
  response: string,
  targetCategory: WisdomCategory
): string[] {
  const allWisdom = extractWisdomFromCompletion(response);
  return allWisdom
    .filter(w => w.category === targetCategory)
    .map(w => w.content);
}

/**
 * Check if response contains wisdom
 */
export function hasWisdom(response: string): boolean {
  return extractWisdomFromCompletion(response).length > 0;
}
