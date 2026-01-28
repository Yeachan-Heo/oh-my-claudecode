/**
 * PreCompact Hook - State Preservation Before Context Compaction
 *
 * Creates checkpoints before compaction to preserve critical state including:
 * - Active mode states (autopilot, ralph, ultrawork, swarm)
 * - TODO summary
 * - Wisdom from notepads
 *
 * This ensures no critical information is lost during context window compaction.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}

export interface CompactCheckpoint {
  created_at: string;
  trigger: 'manual' | 'auto';
  active_modes: {
    autopilot?: { phase: string; originalIdea: string };
    ralph?: { iteration: number; prompt: string };
    ultrawork?: { original_prompt: string };
    swarm?: { session_id: string; task_count: number };
  };
  todo_summary: {
    pending: number;
    in_progress: number;
    completed: number;
  };
  wisdom_exported: boolean;
}

export interface HookOutput {
  continue: boolean;
  /** System message for context injection (Claude Code compatible) */
  systemMessage?: string;
}

// ============================================================================
// Constants
// ============================================================================

const CHECKPOINT_DIR = 'checkpoints';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the checkpoint directory path
 */
export function getCheckpointPath(directory: string): string {
  const checkpointDir = join(directory, '.omc', 'state', CHECKPOINT_DIR);
  if (!existsSync(checkpointDir)) {
    mkdirSync(checkpointDir, { recursive: true });
  }
  return checkpointDir;
}

/**
 * Export wisdom from notepads to checkpoint
 */
export async function exportWisdomToNotepad(directory: string): Promise<{ wisdom: string; exported: boolean }> {
  const notepadsDir = join(directory, '.omc', 'notepads');

  if (!existsSync(notepadsDir)) {
    return { wisdom: '', exported: false };
  }

  const wisdomParts: string[] = [];
  let hasWisdom = false;

  try {
    // Read all plan directories
    const planDirs = readdirSync(notepadsDir).filter(name => {
      const path = join(notepadsDir, name);
      return statSync(path).isDirectory();
    });

    for (const planDir of planDirs) {
      const planPath = join(notepadsDir, planDir);
      const wisdomFiles = ['learnings.md', 'decisions.md', 'issues.md', 'problems.md'];

      for (const wisdomFile of wisdomFiles) {
        const wisdomPath = join(planPath, wisdomFile);
        if (existsSync(wisdomPath)) {
          const content = readFileSync(wisdomPath, 'utf-8').trim();
          if (content) {
            wisdomParts.push(`### ${planDir}/${wisdomFile}\n${content}`);
            hasWisdom = true;
          }
        }
      }
    }
  } catch (error) {
    console.error('[PreCompact] Error reading wisdom files:', error);
  }

  const wisdom = wisdomParts.length > 0
    ? `## Plan Wisdom\n\n${wisdomParts.join('\n\n')}`
    : '';

  return { wisdom, exported: hasWisdom };
}

/**
 * Save summary of active modes
 */
export function saveModeSummary(directory: string): Record<string, unknown> {
  const stateDir = join(directory, '.omc', 'state');
  const modes: Record<string, unknown> = {};

  // Check autopilot
  const autopilotPath = join(stateDir, 'autopilot-state.json');
  if (existsSync(autopilotPath)) {
    try {
      const autopilotState = JSON.parse(readFileSync(autopilotPath, 'utf-8'));
      if (autopilotState.active) {
        modes.autopilot = {
          phase: autopilotState.phase || 'unknown',
          originalIdea: autopilotState.originalIdea || ''
        };
      }
    } catch (error) {
      console.error('[PreCompact] Error reading autopilot state:', error);
    }
  }

  // Check ralph
  const ralphPath = join(stateDir, 'ralph-state.json');
  if (existsSync(ralphPath)) {
    try {
      const ralphState = JSON.parse(readFileSync(ralphPath, 'utf-8'));
      if (ralphState.active) {
        modes.ralph = {
          iteration: ralphState.iteration || 0,
          prompt: ralphState.originalPrompt || ralphState.prompt || ''
        };
      }
    } catch (error) {
      console.error('[PreCompact] Error reading ralph state:', error);
    }
  }

  // Check ultrawork
  const ultraworkPath = join(stateDir, 'ultrawork-state.json');
  if (existsSync(ultraworkPath)) {
    try {
      const ultraworkState = JSON.parse(readFileSync(ultraworkPath, 'utf-8'));
      if (ultraworkState.active) {
        modes.ultrawork = {
          original_prompt: ultraworkState.original_prompt || ultraworkState.prompt || ''
        };
      }
    } catch (error) {
      console.error('[PreCompact] Error reading ultrawork state:', error);
    }
  }

  // Check swarm (SQLite database)
  const swarmPath = join(stateDir, 'swarm.db');
  if (existsSync(swarmPath)) {
    try {
      const stats = statSync(swarmPath);
      if (stats.size > 0) {
        modes.swarm = {
          session_id: 'active',
          task_count: 0 // Can't read SQLite without a library
        };
      }
    } catch (error) {
      console.error('[PreCompact] Error checking swarm state:', error);
    }
  }

  return modes;
}

/**
 * Create a compact checkpoint
 */
export function createCompactCheckpoint(directory: string, trigger: 'manual' | 'auto'): CompactCheckpoint {
  const activeModes = saveModeSummary(directory);

  // TODO summary - basic implementation
  // In a real implementation, this would read from TodoWrite state
  const todoSummary = {
    pending: 0,
    in_progress: 0,
    completed: 0
  };

  return {
    created_at: new Date().toISOString(),
    trigger,
    active_modes: activeModes as CompactCheckpoint['active_modes'],
    todo_summary: todoSummary,
    wisdom_exported: false
  };
}

/**
 * Format checkpoint summary for context injection
 */
export function formatCompactSummary(checkpoint: CompactCheckpoint): string {
  const lines: string[] = [
    '# PreCompact Checkpoint',
    '',
    `Created: ${checkpoint.created_at}`,
    `Trigger: ${checkpoint.trigger}`,
    ''
  ];

  // Active modes
  const modeCount = Object.keys(checkpoint.active_modes).length;
  if (modeCount > 0) {
    lines.push('## Active Modes');
    lines.push('');

    if (checkpoint.active_modes.autopilot) {
      const ap = checkpoint.active_modes.autopilot;
      lines.push(`- **Autopilot** (Phase: ${ap.phase})`);
      lines.push(`  Original Idea: ${ap.originalIdea}`);
    }

    if (checkpoint.active_modes.ralph) {
      const ralph = checkpoint.active_modes.ralph;
      lines.push(`- **Ralph** (Iteration: ${ralph.iteration})`);
      lines.push(`  Prompt: ${ralph.prompt}`);
    }

    if (checkpoint.active_modes.ultrawork) {
      const uw = checkpoint.active_modes.ultrawork;
      lines.push(`- **Ultrawork**`);
      lines.push(`  Prompt: ${uw.original_prompt}`);
    }

    if (checkpoint.active_modes.swarm) {
      const swarm = checkpoint.active_modes.swarm;
      lines.push(`- **Swarm** (Session: ${swarm.session_id}, Tasks: ${swarm.task_count})`);
    }

    lines.push('');
  }

  // TODO summary
  const total = checkpoint.todo_summary.pending +
                checkpoint.todo_summary.in_progress +
                checkpoint.todo_summary.completed;

  if (total > 0) {
    lines.push('## TODO Summary');
    lines.push('');
    lines.push(`- Pending: ${checkpoint.todo_summary.pending}`);
    lines.push(`- In Progress: ${checkpoint.todo_summary.in_progress}`);
    lines.push(`- Completed: ${checkpoint.todo_summary.completed}`);
    lines.push('');
  }

  // Wisdom status
  if (checkpoint.wisdom_exported) {
    lines.push('## Wisdom');
    lines.push('');
    lines.push('Plan wisdom has been preserved in checkpoint.');
    lines.push('');
  }

  lines.push('---');
  lines.push('**Note:** This checkpoint preserves critical state before compaction.');
  lines.push('Review active modes to ensure continuity after compaction.');

  return lines.join('\n');
}

/**
 * Main handler for PreCompact hook
 */
export async function processPreCompact(input: PreCompactInput): Promise<HookOutput> {
  const directory = input.cwd;

  // Create checkpoint
  const checkpoint = createCompactCheckpoint(directory, input.trigger);

  // Export wisdom
  const { wisdom, exported } = await exportWisdomToNotepad(directory);
  checkpoint.wisdom_exported = exported;

  // Save checkpoint
  const checkpointPath = getCheckpointPath(directory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const checkpointFile = join(checkpointPath, `checkpoint-${timestamp}.json`);

  try {
    writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2), 'utf-8');
  } catch (error) {
    console.error('[PreCompact] Error saving checkpoint:', error);
  }

  // Save wisdom separately if exported
  if (exported && wisdom) {
    const wisdomFile = join(checkpointPath, `wisdom-${timestamp}.md`);
    try {
      writeFileSync(wisdomFile, wisdom, 'utf-8');
    } catch (error) {
      console.error('[PreCompact] Error saving wisdom:', error);
    }
  }

  // Format summary for context injection
  const summary = formatCompactSummary(checkpoint);

  // Note: hookSpecificOutput only supports PreToolUse, UserPromptSubmit, PostToolUse
  // Use systemMessage for custom hook events like PreCompact
  return {
    continue: true,
    systemMessage: summary
  };
}

// ============================================================================
// Exports
// ============================================================================

export default processPreCompact;
