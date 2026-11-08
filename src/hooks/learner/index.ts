/**
 * Learned Skills Hook
 *
 * Automatically injects relevant learned skills into context
 * based on message content triggers.
 */

import { contextCollector } from "../../features/context-injector/index.js";
import { loadAllSkills, findMatchingSkills } from "./loader.js";
import { MAX_SKILLS_PER_SESSION } from "./constants.js";
import { loadConfig } from "./config.js";
import type { LearnedSkill } from "./types.js";

// Re-export submodules
export * from "./types.js";
export * from "./constants.js";
export * from "./finder.js";
export * from "./parser.js";
export * from "./loader.js";
export * from "./validator.js";
export * from "./writer.js";
export * from "./detector.js";
export * from "./detection-hook.js";
export * from "./promotion.js";
export * from "./config.js";
export * from "./matcher.js";
export * from "./auto-invoke.js";
// Note: auto-learner exports are renamed to avoid collision with ralph's recordPattern
export {
  type PatternDetection,
  type AutoLearnerState,
  initAutoLearner,
  calculateSkillWorthiness,
  extractTriggers,
  getSuggestedSkills,
  patternToSkillMetadata,
  recordPattern as recordSkillPattern,
} from "./auto-learner.js";

/**
 * Session cache for tracking injected skills.
 */
const sessionCaches = new Map<string, Set<string>>();
const MAX_SESSIONS = 100;

/**
 * Check if feature is enabled.
 */
export function isLearnerEnabled(): boolean {
  return loadConfig().enabled;
}

const MAX_LEARNED_SKILL_DESCRIPTOR_CHARS = 1000;
const MAX_LEARNED_SKILLS_CONTEXT_CHARS = 3000;

function compactText(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function summarizeSkillContent(content: string): string {
  const firstUsefulLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line && !line.startsWith("---"));
  return compactText(firstUsefulLine || content.replace(/\s+/g, " ").trim(), 240);
}

function formatSkillDescriptor(skill: LearnedSkill): string {
  const summary = skill.metadata.description || summarizeSkillContent(skill.content);
  const lines = [
    `### ${skill.metadata.name}`,
    `**Path:** ${skill.path}`,
    `**Triggers:** ${skill.metadata.triggers.join(", ")}`,
    skill.metadata.tags && skill.metadata.tags.length > 0
      ? `**Tags:** ${skill.metadata.tags.join(", ")}`
      : "",
    `**Summary:** ${summary}`,
    `**Load instructions:** If this skill is needed, read ${skill.path} and follow the full instructions there.`,
  ].filter(Boolean);
  return compactText(lines.join("\n"), MAX_LEARNED_SKILL_DESCRIPTOR_CHARS);
}

/**
 * Format skills for context injection.
 */
function formatSkillsForContext(skills: LearnedSkill[]): string {
  if (skills.length === 0) return "";

  const header = [
    "<learner>",
    "",
    "## Relevant Learned Skills",
    "",
    "Compact descriptors only; full learned skill bodies stay on disk to avoid prompt bloat.",
    "",
  ].join("\n");
  const footer = "\n</learner>";
  const budget = MAX_LEARNED_SKILLS_CONTEXT_CHARS - header.length - footer.length;
  const descriptors: string[] = [];
  let used = 0;

  for (const skill of skills) {
    const descriptor = formatSkillDescriptor(skill);
    const separator = descriptors.length > 0 ? "\n\n---\n\n" : "";
    if (used + separator.length + descriptor.length > budget) {
      const omission = `${separator}[Additional learned skills omitted due to ${MAX_LEARNED_SKILLS_CONTEXT_CHARS}-character context budget; use skill metadata paths if needed.]`;
      const remainingBudget = budget - used;
      if (remainingBudget > 0) {
        descriptors.push(compactText(omission, remainingBudget));
      }
      break;
    }
    descriptors.push(`${separator}${descriptor}`);
    used += separator.length + descriptor.length;
  }

  return `${header}${descriptors.join("")}${footer}`;
}

/**
 * Process a user message and inject matching skills.
 */
export function processMessageForSkills(
  message: string,
  sessionId: string,
  projectRoot: string | null,
): { injected: number; skills: LearnedSkill[] } {
  if (!isLearnerEnabled()) {
    return { injected: 0, skills: [] };
  }

  // Get or create session cache
  if (!sessionCaches.has(sessionId)) {
    if (sessionCaches.size >= MAX_SESSIONS) {
      const firstKey = sessionCaches.keys().next().value;
      if (firstKey !== undefined) sessionCaches.delete(firstKey);
    }
    sessionCaches.set(sessionId, new Set());
  }
  const injectedHashes = sessionCaches.get(sessionId)!;

  // Find matching skills not already injected
  const matchingSkills = findMatchingSkills(
    message,
    projectRoot,
    MAX_SKILLS_PER_SESSION,
  );
  const newSkills = matchingSkills.filter(
    (s) => !injectedHashes.has(s.contentHash),
  );

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
    id: "learner",
    source: "learner",
    content,
    priority: "normal",
    metadata: {
      skillCount: newSkills.length,
      skillIds: newSkills.map((s) => s.metadata.id),
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
