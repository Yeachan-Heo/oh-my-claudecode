/**
 * Skill Loader
 *
 * Loads and caches skills from disk.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { relative, normalize } from 'path';
import { findSkillFiles } from './finder.js';
import { parseSkillFile } from './parser.js';
import { DEBUG_ENABLED } from './constants.js';
import type { LearnedSkill, SkillMetadata } from './types.js';

/**
 * Create SHA-256 hash of content.
 */
function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Load all skills for a project.
 * Project skills override user skills with same ID.
 */
export function loadAllSkills(projectRoot: string | null): LearnedSkill[] {
  const candidates = findSkillFiles(projectRoot);
  const seenIds = new Map<string, LearnedSkill>();

  for (const candidate of candidates) {
    try {
      const rawContent = readFileSync(candidate.path, 'utf-8');
      const { metadata, content, valid, errors } = parseSkillFile(rawContent);

      if (!valid) {
        if (DEBUG_ENABLED) {
          console.warn(`Invalid skill file ${candidate.path}: ${errors.join(', ')}`);
        }
        continue;
      }

      const skillId = metadata.id!;
      const relativePath = normalize(relative(candidate.sourceDir, candidate.path));

      const skill: LearnedSkill = {
        path: candidate.path,
        relativePath,
        scope: candidate.scope,
        metadata: metadata as SkillMetadata,
        content,
        contentHash: createContentHash(content),
        priority: candidate.scope === 'project' ? 1 : 0,
      };

      // Project skills override user skills with same ID
      const existing = seenIds.get(skillId);
      if (!existing || skill.priority > existing.priority) {
        seenIds.set(skillId, skill);
      }
    } catch (e) {
      if (DEBUG_ENABLED) {
        console.warn(`Error loading skill ${candidate.path}:`, e);
      }
    }
  }

  // Return skills sorted by priority (project first)
  return Array.from(seenIds.values()).sort((a, b) => b.priority - a.priority);
}

/**
 * Load a specific skill by ID.
 */
export function loadSkillById(skillId: string, projectRoot: string | null): LearnedSkill | null {
  const skills = loadAllSkills(projectRoot);
  return skills.find(s => s.metadata.id === skillId) || null;
}

/**
 * Find skills matching keywords in user message.
 */
export function findMatchingSkills(
  message: string,
  projectRoot: string | null,
  limit: number = 5
): LearnedSkill[] {
  const skills = loadAllSkills(projectRoot);
  const messageLower = message.toLowerCase();

  const scored = skills.map(skill => {
    let score = 0;
    let hasMatch = false;

    // Check trigger matches
    for (const trigger of skill.metadata.triggers) {
      if (messageLower.includes(trigger.toLowerCase())) {
        score += 10;
        hasMatch = true;
      }
    }

    // Check tag matches
    if (skill.metadata.tags) {
      for (const tag of skill.metadata.tags) {
        if (messageLower.includes(tag.toLowerCase())) {
          score += 5;
          hasMatch = true;
        }
      }
    }

    // Only apply quality/usage boosts if there was a trigger or tag match
    if (hasMatch) {
      // Boost by quality score
      if (skill.metadata.quality) {
        score += skill.metadata.quality / 20;
      }

      // Boost by usage count
      if (skill.metadata.usageCount) {
        score += Math.min(skill.metadata.usageCount, 10);
      }
    }

    return { skill, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.skill);
}
