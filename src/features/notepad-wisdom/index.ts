/**
 * Notepad Wisdom Module
 *
 * Plan-scoped notepad system for capturing learnings, decisions, issues, and problems.
 * Creates wisdom files at: .omc/notepads/{plan-name}/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import type { WisdomEntry, WisdomCategory, PlanWisdom } from './types.js';
import { NOTEPAD_BASE_PATH } from '../boulder-state/constants.js';

// Constants
const WISDOM_FILES = {
  learnings: 'learnings.md',
  decisions: 'decisions.md',
  issues: 'issues.md',
  problems: 'problems.md',
} as const;

/**
 * Sanitize plan name to prevent path traversal
 */
function sanitizePlanName(planName: string): string {
  // Remove any path separators and dangerous characters
  return planName.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Get the notepad directory for a specific plan
 */
function getNotepadDir(planName: string, directory: string): string {
  const sanitized = sanitizePlanName(planName);
  return join(directory, NOTEPAD_BASE_PATH, sanitized);
}

/**
 * Get the full path to a wisdom file
 */
function getWisdomFilePath(
  planName: string,
  category: WisdomCategory,
  directory: string
): string {
  const notepadDir = getNotepadDir(planName, directory);
  return join(notepadDir, WISDOM_FILES[category]);
}

/**
 * Initialize notepad directory for a plan
 * Creates .omc/notepads/{plan-name}/ with 4 empty markdown files
 */
export function initPlanNotepad(planName: string, directory: string = process.cwd()): boolean {
  const notepadDir = getNotepadDir(planName, directory);

  try {
    // Create the notepad directory
    if (!existsSync(notepadDir)) {
      mkdirSync(notepadDir, { recursive: true });
    }

    // Create all wisdom files if they don't exist
    const categories: WisdomCategory[] = ['learnings', 'decisions', 'issues', 'problems'];

    for (const category of categories) {
      const filePath = getWisdomFilePath(planName, category, directory);

      if (!existsSync(filePath)) {
        const header = `# ${category.charAt(0).toUpperCase() + category.slice(1)} - ${planName}\n\n`;
        writeFileSync(filePath, header, 'utf-8');
      }
    }

    return true;
  } catch (error) {
    console.error('Failed to initialize plan notepad:', error);
    return false;
  }
}

/**
 * Read all wisdom entries from a specific category
 */
function readWisdomCategory(
  planName: string,
  category: WisdomCategory,
  directory: string
): WisdomEntry[] {
  const filePath = getWisdomFilePath(planName, category, directory);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const entries: WisdomEntry[] = [];

    // Parse entries in format: ## YYYY-MM-DD HH:MM:SS\ncontent\n
    const entryRegex = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\n([\s\S]*?)(?=\n## \d{4}-\d{2}-\d{2}|$)/gm;
    let match;

    while ((match = entryRegex.exec(content)) !== null) {
      entries.push({
        timestamp: match[1],
        content: match[2].trim(),
      });
    }

    return entries;
  } catch (error) {
    console.error(`Failed to read ${category}:`, error);
    return [];
  }
}

/**
 * Read all wisdom from a plan's notepad
 * Returns concatenated wisdom from all 4 categories
 */
export function readPlanWisdom(planName: string, directory: string = process.cwd()): PlanWisdom {
  return {
    planName,
    learnings: readWisdomCategory(planName, 'learnings', directory),
    decisions: readWisdomCategory(planName, 'decisions', directory),
    issues: readWisdomCategory(planName, 'issues', directory),
    problems: readWisdomCategory(planName, 'problems', directory),
  };
}

/**
 * Add a timestamped entry to a wisdom category
 */
function addWisdomEntry(
  planName: string,
  category: WisdomCategory,
  content: string,
  directory: string
): boolean {
  const filePath = getWisdomFilePath(planName, category, directory);

  // Ensure notepad is initialized
  if (!existsSync(dirname(filePath))) {
    initPlanNotepad(planName, directory);
  }

  try {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const entry = `\n## ${timestamp}\n\n${content}\n`;

    appendFileSync(filePath, entry, 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to add ${category} entry:`, error);
    return false;
  }
}

/**
 * Add a learning entry
 */
export function addLearning(
  planName: string,
  content: string,
  directory: string = process.cwd()
): boolean {
  return addWisdomEntry(planName, 'learnings', content, directory);
}

/**
 * Add a decision entry
 */
export function addDecision(
  planName: string,
  content: string,
  directory: string = process.cwd()
): boolean {
  return addWisdomEntry(planName, 'decisions', content, directory);
}

/**
 * Add an issue entry
 */
export function addIssue(
  planName: string,
  content: string,
  directory: string = process.cwd()
): boolean {
  return addWisdomEntry(planName, 'issues', content, directory);
}

/**
 * Add a problem entry
 */
export function addProblem(
  planName: string,
  content: string,
  directory: string = process.cwd()
): boolean {
  return addWisdomEntry(planName, 'problems', content, directory);
}

/**
 * Get a formatted string of all wisdom for a plan
 */
export function getWisdomSummary(planName: string, directory: string = process.cwd()): string {
  const wisdom = readPlanWisdom(planName, directory);
  const sections: string[] = [];

  if (wisdom.learnings.length > 0) {
    sections.push('# Learnings\n\n' + wisdom.learnings.map(e => `- [${e.timestamp}] ${e.content}`).join('\n'));
  }

  if (wisdom.decisions.length > 0) {
    sections.push('# Decisions\n\n' + wisdom.decisions.map(e => `- [${e.timestamp}] ${e.content}`).join('\n'));
  }

  if (wisdom.issues.length > 0) {
    sections.push('# Issues\n\n' + wisdom.issues.map(e => `- [${e.timestamp}] ${e.content}`).join('\n'));
  }

  if (wisdom.problems.length > 0) {
    sections.push('# Problems\n\n' + wisdom.problems.map(e => `- [${e.timestamp}] ${e.content}`).join('\n'));
  }

  return sections.join('\n\n');
}

// Re-export types
export type { WisdomEntry, WisdomCategory, PlanWisdom } from './types.js';
