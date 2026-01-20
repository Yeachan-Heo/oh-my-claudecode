/**
 * Ralph-Progress Promotion
 *
 * Promotes learnings from ralph-progress to full skills.
 */

import { readProgress } from '../ralph-progress/index.js';
import { writeSkill } from './writer.js';
import type { SkillExtractionRequest } from './types.js';
import type { WriteSkillResult } from './writer.js';

export interface PromotionCandidate {
  /** The learning text */
  learning: string;
  /** Story ID it came from */
  storyId: string;
  /** Timestamp */
  timestamp: string;
  /** Suggested triggers (extracted from text) */
  suggestedTriggers: string[];
}

/**
 * Extract trigger keywords from learning text.
 */
function extractTriggers(text: string): string[] {
  const technicalKeywords = [
    'react', 'typescript', 'javascript', 'python', 'api', 'database',
    'testing', 'debugging', 'performance', 'async', 'state', 'component',
    'error', 'validation', 'authentication', 'cache', 'query', 'mutation',
  ];

  const textLower = text.toLowerCase();
  return technicalKeywords.filter(kw => textLower.includes(kw));
}

/**
 * Get promotion candidates from ralph-progress learnings.
 */
export function getPromotionCandidates(
  directory: string,
  limit: number = 10
): PromotionCandidate[] {
  const progress = readProgress(directory);
  if (!progress) {
    return [];
  }

  const candidates: PromotionCandidate[] = [];

  // Get recent entries with learnings
  const recentEntries = progress.entries.slice(-limit);

  for (const entry of recentEntries) {
    for (const learning of entry.learnings) {
      // Skip very short learnings
      if (learning.length < 20) continue;

      candidates.push({
        learning,
        storyId: entry.storyId,
        timestamp: entry.timestamp,
        suggestedTriggers: extractTriggers(learning),
      });
    }
  }

  // Sort by number of triggers (more specific = better candidate)
  return candidates.sort((a, b) => b.suggestedTriggers.length - a.suggestedTriggers.length);
}

/**
 * Promote a learning to a full skill.
 */
export function promoteLearning(
  candidate: PromotionCandidate,
  skillName: string,
  additionalTriggers: string[],
  targetScope: 'user' | 'project',
  projectRoot: string | null
): WriteSkillResult {
  const request: SkillExtractionRequest = {
    problem: `Learning from ${candidate.storyId}: ${candidate.learning.slice(0, 100)}...`,
    solution: candidate.learning,
    triggers: [...new Set([...candidate.suggestedTriggers, ...additionalTriggers])],
    targetScope,
  };

  return writeSkill(request, projectRoot, skillName);
}

/**
 * List learnings that could be promoted.
 */
export function listPromotableLearnings(directory: string): string {
  const candidates = getPromotionCandidates(directory);

  if (candidates.length === 0) {
    return 'No promotion candidates found in ralph-progress learnings.';
  }

  const lines = [
    '# Promotion Candidates',
    '',
    'The following learnings from ralph-progress could be promoted to skills:',
    '',
  ];

  candidates.forEach((candidate, index) => {
    lines.push(`## ${index + 1}. From ${candidate.storyId} (${candidate.timestamp})`);
    lines.push('');
    lines.push(candidate.learning);
    lines.push('');
    if (candidate.suggestedTriggers.length > 0) {
      lines.push(`**Suggested triggers:** ${candidate.suggestedTriggers.join(', ')}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}
