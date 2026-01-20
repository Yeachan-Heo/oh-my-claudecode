/**
 * Learned Skills Hook
 *
 * Automatically injects relevant learned skills into context
 * based on message content triggers.
 */

import { contextCollector } from '../../features/context-injector/index.js';
import { loadAllSkills, findMatchingSkills } from './loader.js';
import { MAX_SKILLS_PER_SESSION } from './constants.js';
import { loadConfig } from './config.js';
import type { LearnedSkill } from './types.js';

// Re-export submodules
export * from './types.js';
export * from './constants.js';
export * from './finder.js';
export * from './parser.js';
export * from './loader.js';
export * from './validator.js';
export * from './writer.js';
export * from './detector.js';
export * from './detection-hook.js';
export * from './promotion.js';
export * from './config.js';

/**
 * Session cache for tracking injected skills.
 */
const sessionCaches = new Map<string, Set<string>>();

/**
 * Check if feature is enabled.
 */
export function isLearnerEnabled(): boolean {
  return loadConfig().enabled;
}

/**
 * Format skills for context injection.
 */
function formatSkillsForContext(skills: LearnedSkill[]): string {
  if (skills.length === 0) return '';

  const lines = [
    '<learner>',
    '',
    '## Relevant Learned Skills',
    '',
    'The following skills have been learned from previous sessions and may be helpful:',
    '',
  ];

  for (const skill of skills) {
    lines.push(`### ${skill.metadata.name}`);
    lines.push(`**Triggers:** ${skill.metadata.triggers.join(', ')}`);
    if (skill.metadata.tags && skill.metadata.tags.length > 0) {
      lines.push(`**Tags:** ${skill.metadata.tags.join(', ')}`);
    }
    lines.push('');
    lines.push(skill.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('</learner>');
  return lines.join('\n');
}

/**
 * Process a user message and inject matching skills.
 */
export function processMessageForSkills(
  message: string,
  sessionId: string,
  projectRoot: string | null
): { injected: number; skills: LearnedSkill[] } {
  if (!isLearnerEnabled()) {
    return { injected: 0, skills: [] };
  }

  // Get or create session cache
  if (!sessionCaches.has(sessionId)) {
    sessionCaches.set(sessionId, new Set());
  }
  const injectedHashes = sessionCaches.get(sessionId)!;

  // Find matching skills not already injected
  const matchingSkills = findMatchingSkills(message, projectRoot, MAX_SKILLS_PER_SESSION);
  const newSkills = matchingSkills.filter(s => !injectedHashes.has(s.contentHash));

  if (newSkills.length === 0) {
    return { injected: 0, skills: [] };
  }

  // Mark as injected
  for (const skill of newSkills) {
    injectedHashes.add(skill.contentHash);
  }

  // Register with context collector
  const content = formatSkillsForContext(newSkills);
  contextCollector.register(sessionId, {
    id: 'learner',
    source: 'learner',
    content,
    priority: 'normal',
    metadata: {
      skillCount: newSkills.length,
      skillIds: newSkills.map(s => s.metadata.id),
    },
  });

  return { injected: newSkills.length, skills: newSkills };
}

/**
 * Clear session cache.
 */
export function clearSkillSession(sessionId: string): void {
  sessionCaches.delete(sessionId);
}

/**
 * Get all loaded skills (for debugging/display).
 */
export function getAllSkills(projectRoot: string | null): LearnedSkill[] {
  return loadAllSkills(projectRoot);
}

/**
 * Create the learned skills hook for Claude Code.
 */
export function createLearnedSkillsHook(projectRoot: string | null) {
  return {
    /**
     * Process user message for skill injection.
     */
    processMessage: (message: string, sessionId: string) => {
      return processMessageForSkills(message, sessionId, projectRoot);
    },

    /**
     * Clear session when done.
     */
    clearSession: (sessionId: string) => {
      clearSkillSession(sessionId);
    },

    /**
     * Get all skills for display.
     */
    getAllSkills: () => getAllSkills(projectRoot),

    /**
     * Check if feature enabled.
     */
    isEnabled: isLearnerEnabled,
  };
}
