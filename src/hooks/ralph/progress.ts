/**
 * Ralph Progress Log Support
 *
 * Implements append-only progress tracking using progress.txt format from original Ralph.
 * This provides memory persistence between ralph iterations.
 *
 * Structure:
 * - Codebase Patterns section at top (consolidated learnings)
 * - Per-story progress entries appended
 * - Learnings captured for future iterations
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';

// ============================================================================
// Types
// ============================================================================

export interface ProgressEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Story ID (e.g., "US-001") */
  storyId: string;
  /** What was implemented */
  implementation: string[];
  /** Files changed */
  filesChanged: string[];
  /** Learnings for future iterations */
  learnings: string[];
}

export interface CodebasePattern {
  /** The pattern description */
  pattern: string;
  /** When it was discovered */
  discoveredAt?: string;
}

export interface ProgressLog {
  /** Consolidated codebase patterns at top */
  patterns: CodebasePattern[];
  /** Progress entries (append-only) */
  entries: ProgressEntry[];
  /** When the log was started */
  startedAt: string;
}

// ============================================================================
// Constants
// ============================================================================

export const PROGRESS_FILENAME = 'progress.txt';
export const PATTERNS_HEADER = '## Codebase Patterns';
export const ENTRY_SEPARATOR = '---';

// ============================================================================
// File Operations
// ============================================================================

/**
 * Get the path to progress.txt in a directory
 */
export function getProgressPath(directory: string): string {
  return join(directory, PROGRESS_FILENAME);
}

/**
 * Get the path to progress.txt in .omc subdirectory
 */
export function getOmcProgressPath(directory: string): string {
  return join(getOmcRoot(directory), PROGRESS_FILENAME);
}

/**
 * Find progress.txt in a directory (checks both root and .omc)
 */
export function findProgressPath(directory: string): string | null {
  const rootPath = getProgressPath(directory);
  if (existsSync(rootPath)) {
    return rootPath;
  }

  const omcPath = getOmcProgressPath(directory);
  if (existsSync(omcPath)) {
    return omcPath;
  }

  return null;
}

/**
 * Read raw progress.txt content
 */
export function readProgressRaw(directory: string): string | null {
  const progressPath = findProgressPath(directory);
  if (!progressPath) {
    return null;
  }

  try {
    return readFileSync(progressPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse progress.txt content into structured format
 */
export function parseProgress(content: string): ProgressLog {
  const lines = content.split('\n');
  const patterns: CodebasePattern[] = [];
  const entries: ProgressEntry[] = [];
  let startedAt = '';

  let inPatterns = false;
  let currentEntry: Partial<ProgressEntry> | null = null;
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for started timestamp
    if (trimmed.startsWith('Started:')) {
      startedAt = trimmed.replace('Started:', '').trim();
      continue;
    }

    // Check for patterns section
    if (trimmed === PATTERNS_HEADER) {
      inPatterns = true;
      continue;
    }

    // Check for separator (ends patterns section, separates entries)
    if (trimmed === ENTRY_SEPARATOR) {
      inPatterns = false;
      if (currentEntry && currentEntry.storyId) {
        entries.push(currentEntry as ProgressEntry);
      }
      currentEntry = null;
      currentSection = '';
      continue;
    }

    // Parse patterns
    if (inPatterns && trimmed.startsWith('-')) {
      patterns.push({
        pattern: trimmed.slice(1).trim()
      });
      continue;
    }

    // Parse entry header (## [Date] - [Story ID])
    const headerMatch = trimmed.match(/^##\s*\[(.+?)\]\s*-\s*(.+)$/);
    if (headerMatch) {
      if (currentEntry && currentEntry.storyId) {
        entries.push(currentEntry as ProgressEntry);
      }
      currentEntry = {
        timestamp: headerMatch[1],
        storyId: headerMatch[2],
        implementation: [],
        filesChanged: [],
        learnings: []
      };
      currentSection = '';
      continue;
    }

    // Parse sections within entry
    if (currentEntry) {
      if (trimmed.toLowerCase().includes('learnings')) {
        currentSection = 'learnings';
        continue;
      }
      if (trimmed.toLowerCase().includes('files changed') || trimmed.toLowerCase().includes('files:')) {
        currentSection = 'files';
        continue;
      }
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        const item = trimmed.slice(1).trim();
        if (currentSection === 'learnings') {
          currentEntry.learnings!.push(item);
        } else if (currentSection === 'files') {
          currentEntry.filesChanged!.push(item);
        } else {
          currentEntry.implementation!.push(item);
        }
      }
    }
  }

  // Don't forget the last entry
  if (currentEntry && currentEntry.storyId) {
    entries.push(currentEntry as ProgressEntry);
  }

  return {
    patterns,
    entries,
    startedAt
  };
}

/**
 * Read and parse progress.txt
 */
export function readProgress(directory: string): ProgressLog | null {
  const content = readProgressRaw(directory);
  if (!content) {
    return null;
  }

  return parseProgress(content);
}

// ============================================================================
// Progress Operations
// ============================================================================

/**
 * Initialize a new progress.txt file
 */
export function initProgress(directory: string): boolean {
  const omcDir = getOmcRoot(directory);
  if (!existsSync(omcDir)) {
    try {
      mkdirSync(omcDir, { recursive: true });
    } catch {
      return false;
    }
  }

  const progressPath = getOmcProgressPath(directory);
  const now = new Date().toISOString();

  const content = `# Ralph Progress Log
Started: ${now}

${PATTERNS_HEADER}
(No patterns discovered yet)

${ENTRY_SEPARATOR}

`;

  try {
    writeFileSync(progressPath, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a progress entry
 */
export function appendProgress(
  directory: string,
  entry: Omit<ProgressEntry, 'timestamp'>
): boolean {
  let progressPath = findProgressPath(directory);

  if (!progressPath) {
    // Initialize if doesn't exist
    if (!initProgress(directory)) {
      return false;
    }
    progressPath = getOmcProgressPath(directory);
  }

  const now = new Date().toISOString();
  const dateStr = now.split('T')[0];
  const timeStr = now.split('T')[1].slice(0, 5);

  const lines: string[] = [
    '',
    `## [${dateStr} ${timeStr}] - ${entry.storyId}`,
    ''
  ];

  if (entry.implementation.length > 0) {
    lines.push('**What was implemented:**');
    entry.implementation.forEach(item => {
      lines.push(`- ${item}`);
    });
    lines.push('');
  }

  if (entry.filesChanged.length > 0) {
    lines.push('**Files changed:**');
    entry.filesChanged.forEach(file => {
      lines.push(`- ${file}`);
    });
    lines.push('');
  }

  if (entry.learnings.length > 0) {
    lines.push('**Learnings for future iterations:**');
    entry.learnings.forEach(learning => {
      lines.push(`- ${learning}`);
    });
    lines.push('');
  }

  lines.push(ENTRY_SEPARATOR);
  lines.push('');

  try {
    appendFileSync(progressPath, lines.join('\n'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a codebase pattern to the patterns section
 * @param retryCount - Internal retry counter to prevent infinite recursion
 */
export function addPattern(directory: string, pattern: string, retryCount: number = 0): boolean {
  // Guard against infinite recursion
  if (retryCount > 1) {
    return false;
  }

  const progressPath = findProgressPath(directory);
  if (!progressPath) {
    // Initialize if doesn't exist
    if (!initProgress(directory)) {
      return false;
    }
    // Retry once after initialization
    return addPattern(directory, pattern, retryCount + 1);
  }

  try {
    let content = readFileSync(progressPath, 'utf-8');

    // Remove placeholder if present (do this FIRST before calculating positions)
    content = content.replace('(No patterns discovered yet)\n', '');

    // Find the patterns section and add the new pattern
    const patternsSectionStart = content.indexOf(PATTERNS_HEADER);
    if (patternsSectionStart === -1) {
      return false;
    }

    // Find the first separator after patterns
    const separatorPos = content.indexOf(ENTRY_SEPARATOR, patternsSectionStart);
    if (separatorPos === -1) {
      return false;
    }

    // Insert the pattern before the separator
    const before = content.slice(0, separatorPos);
    const after = content.slice(separatorPos);
    const newContent = before + `- ${pattern}\n\n` + after;

    writeFileSync(progressPath, newContent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get patterns from progress.txt for injection into context
 */
export function getPatterns(directory: string): string[] {
  const progress = readProgress(directory);
  if (!progress) {
    return [];
  }

  return progress.patterns.map(p => p.pattern);
}

/**
 * Get recent learnings for context injection
 */
export function getRecentLearnings(directory: string, limit: number = 5): string[] {
  const progress = readProgress(directory);
  if (!progress) {
    return [];
  }

  const learnings: string[] = [];
  const recentEntries = progress.entries.slice(-limit);

  for (const entry of recentEntries) {
    learnings.push(...entry.learnings);
  }

  return learnings;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format patterns for context injection
 */
export function formatPatternsForContext(directory: string): string {
  const patterns = getPatterns(directory);

  if (patterns.length === 0) {
    return '';
  }

  const lines = [
    '<codebase-patterns>',
    '',
    '## Known Patterns from Previous Iterations',
    ''
  ];

  patterns.forEach(pattern => {
    lines.push(`- ${pattern}`);
  });

  lines.push('');
  lines.push('</codebase-patterns>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format recent progress for context injection
 */
export function formatProgressForContext(directory: string, limit: number = 3): string {
  const progress = readProgress(directory);
  if (!progress || progress.entries.length === 0) {
    return '';
  }

  const recent = progress.entries.slice(-limit);

  const lines = [
    '<recent-progress>',
    '',
    '## Recent Progress',
    ''
  ];

  for (const entry of recent) {
    lines.push(`### ${entry.storyId} (${entry.timestamp})`);
    if (entry.implementation.length > 0) {
      entry.implementation.forEach(item => {
        lines.push(`- ${item}`);
      });
    }
    lines.push('');
  }

  lines.push('</recent-progress>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format learnings for context injection
 */
export function formatLearningsForContext(directory: string): string {
  const learnings = getRecentLearnings(directory, 10);

  if (learnings.length === 0) {
    return '';
  }

  const lines = [
    '<learnings>',
    '',
    '## Learnings from Previous Iterations',
    ''
  ];

  // Deduplicate learnings
  const unique = [...new Set(learnings)];
  unique.forEach(learning => {
    lines.push(`- ${learning}`);
  });

  lines.push('');
  lines.push('</learnings>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Get full context injection for ralph
 */
export function getProgressContext(directory: string): string {
  const patterns = formatPatternsForContext(directory);
  const learnings = formatLearningsForContext(directory);
  const recent = formatProgressForContext(directory, 2);

  if (!patterns && !learnings && !recent) {
    return '';
  }

  return [patterns, learnings, recent].filter(Boolean).join('\n');
}
