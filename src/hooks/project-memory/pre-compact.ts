/**
 * PreCompact Handler for Project Memory
 * Ensures project memory (especially user directives) survives compaction
 */

import { findProjectRoot } from '../rules-injector/finder.js';
import { loadProjectMemory } from './storage.js';
import { formatContextSummary } from './formatter.js';

export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}

export interface PreCompactOutput {
  continue: boolean;
  systemMessage?: string;
}

/**
 * Process PreCompact hook - inject project memory into system message
 * This ensures user directives and project context survive compaction
 */
export async function processPreCompact(input: PreCompactInput): Promise<PreCompactOutput> {
  try {
    const projectRoot = findProjectRoot(input.cwd);
    if (!projectRoot) {
      return { continue: true };
    }

    const memory = await loadProjectMemory(projectRoot);
    if (!memory) {
      return { continue: true };
    }

    // Check if there's critical info to preserve
    const hasCriticalInfo =
      memory.userDirectives.length > 0 ||
      memory.hotPaths.length > 0 ||
      memory.techStack.languages.length > 0;

    if (!hasCriticalInfo) {
      return { continue: true };
    }

    // Format memory for re-injection
    const contextSummary = formatContextSummary(memory);

    // Build system message for post-compaction
    const systemMessage = [
      '# Project Memory (Post-Compaction Recovery)',
      '',
      'The following project context and user directives must be preserved after compaction:',
      '',
      contextSummary,
      '',
      '**IMPORTANT:** These user directives must be followed throughout the session, even after compaction.',
    ].join('\n');

    return {
      continue: true,
      systemMessage,
    };
  } catch (error) {
    console.error('Error in project memory PreCompact handler:', error);
    return { continue: true };
  }
}
