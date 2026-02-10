/**
 * Directive Detector
 * Detects and extracts user directives from messages and tool outputs
 */

import { UserDirective } from './types.js';

/**
 * Patterns that indicate user directives
 */
const DIRECTIVE_PATTERNS = [
  // Explicit directives
  /only (?:look at|focus on|work on|use) (.+)/i,
  /always (?:use|check|include|remember) (.+)/i,
  /never (?:use|modify|touch|change) (.+)/i,
  /ignore (?:all|any) (.+)/i,
  /focus on (.+)/i,
  /stick to (.+)/i,
  /don't (?:use|modify|touch|change) (.+)/i,

  // Constraint directives
  /must (?:use|include|have) (.+)/i,
  /requirement: (.+)/i,
  /constraint: (.+)/i,
  /rule: (.+)/i,

  // Scope directives
  /scope: (.+)/i,
  /in scope: (.+)/i,
  /out of scope: (.+)/i,

  // Priority directives
  /prioritize (.+)/i,
  /important: (.+)/i,
  /critical: (.+)/i,

  // Pattern directives
  /(?:when|if) (.+), (?:always|never|should) (.+)/i,
];

/**
 * Detect directives from user message
 */
export function detectDirectivesFromMessage(message: string): UserDirective[] {
  const directives: UserDirective[] = [];
  const lines = message.split('\n');

  for (const line of lines) {
    for (const pattern of DIRECTIVE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const directive = match[1]?.trim() || match[0].trim();

        if (directive && directive.length > 5) {
          directives.push({
            timestamp: Date.now(),
            directive: directive,
            context: line.trim(),
            source: 'explicit',
            priority: isPriorityDirective(line) ? 'high' : 'normal',
          });
        }
      }
    }
  }

  return directives;
}

/**
 * Check if directive is high priority
 */
function isPriorityDirective(text: string): boolean {
  const priorityKeywords = ['must', 'critical', 'important', 'always', 'never', 'requirement'];
  return priorityKeywords.some(keyword => text.toLowerCase().includes(keyword));
}

/**
 * Infer directives from repeated patterns
 */
export function inferDirectiveFromPattern(
  commandHistory: string[],
  threshold: number = 3
): UserDirective | null {
  // Look for repeated command patterns
  const commandCounts = new Map<string, number>();

  for (const cmd of commandHistory) {
    const normalized = normalizeCommand(cmd);
    commandCounts.set(normalized, (commandCounts.get(normalized) || 0) + 1);
  }

  // Find most common pattern
  let maxCount = 0;
  let mostCommon = '';

  for (const [cmd, count] of commandCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = cmd;
    }
  }

  if (maxCount >= threshold && mostCommon) {
    return {
      timestamp: Date.now(),
      directive: `User frequently runs: ${mostCommon}`,
      context: `Pattern detected from ${maxCount} executions`,
      source: 'inferred',
      priority: 'normal',
    };
  }

  return null;
}

/**
 * Normalize command for pattern matching
 */
function normalizeCommand(cmd: string): string {
  // Remove arguments, keep base command
  return cmd.split(/\s+/)[0] || cmd;
}

/**
 * Add directive if not duplicate
 */
export function addDirective(
  directives: UserDirective[],
  newDirective: UserDirective
): UserDirective[] {
  // Check for duplicates
  const isDuplicate = directives.some(d =>
    d.directive.toLowerCase() === newDirective.directive.toLowerCase()
  );

  if (!isDuplicate) {
    directives.push(newDirective);

    // Keep only most recent 20 directives
    if (directives.length > 20) {
      directives.sort((a, b) => {
        // Sort by priority first, then by timestamp
        if (a.priority !== b.priority) {
          return a.priority === 'high' ? -1 : 1;
        }
        return b.timestamp - a.timestamp;
      });
      directives.splice(20);
    }
  }

  return directives;
}

/**
 * Format directives for context injection
 */
export function formatDirectivesForContext(directives: UserDirective[]): string {
  if (directives.length === 0) return '';

  const lines = ['**User Directives (Must Follow):**'];

  // Group by priority
  const highPriority = directives.filter(d => d.priority === 'high');
  const normalPriority = directives.filter(d => d.priority === 'normal');

  if (highPriority.length > 0) {
    lines.push('');
    lines.push('🔴 **Critical:**');
    for (const d of highPriority) {
      lines.push(`- ${d.directive}`);
    }
  }

  if (normalPriority.length > 0) {
    lines.push('');
    for (const d of normalPriority) {
      lines.push(`- ${d.directive}`);
    }
  }

  return lines.join('\n');
}
