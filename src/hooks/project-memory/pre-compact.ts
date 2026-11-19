/**
 * PreCompact Handler for Project Memory
 * Ensures project memory (especially user directives) survives compaction
 */

import { findProjectRoot } from '../rules-injector/finder.js';
import { loadProjectMemory } from './storage.js';
import {
  formatContextSummary,
  formatContextSummaryWithFrame,
  projectMemoryFrameEnabled,
} from './formatter.js';

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
      memory.techStack.languages.length > 0 ||
      memory.customNotes.length > 0;

    if (!hasCriticalInfo) {
      return { continue: true };
    }

    // Format memory for re-injection
    // Opt-in (OMC_PROJECT_MEMORY_FRAME=1 or true): framed summary and the matching wording.
    // With the switch off the message is the same as before.
    const frameOn = projectMemoryFrameEnabled();
    const contextSummary = frameOn
      ? await formatContextSummaryWithFrame(memory)
      : formatContextSummary(memory);

    // Build system message for post-compaction
    const systemMessage = [
      '# Project Memory (Post-Compaction Recovery)',
      '',
      frameOn
        ? 'The following project context and recorded user directives are preserved after compaction for reference:'
        : 'The following project context and user directives must be preserved after compaction:',
      '',
      contextSummary,
      '',
      frameOn
        ? "**IMPORTANT:** Recorded directives are reference material (see the frame above); the current task and the user's latest instruction take precedence."
        : '**IMPORTANT:** These user directives must be followed throughout the session, even after compaction.',
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
