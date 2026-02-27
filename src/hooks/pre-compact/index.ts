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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { promises as fsPromises } from "fs";
import { join } from "path";
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { initJobDb, getActiveJobs, getRecentJobs, getJobStats } from '../../lib/job-state-db.js';

// ============================================================================
// Types
// ============================================================================

export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions?: string;
}

export interface CompactCheckpoint {
  created_at: string;
  trigger: "manual" | "auto";
  active_modes: {
    autopilot?: { phase: string; originalIdea: string };
    ralph?: { iteration: number; prompt: string };
    ultrawork?: { original_prompt: string };
    swarm?: { session_id: string; task_count: number };
    ultrapilot?: { session_id: string; worker_count: number };
    pipeline?: { preset: string; current_stage: number };
    ultraqa?: { cycle: number; prompt: string };
  };
  todo_summary: {
    pending: number;
    in_progress: number;
    completed: number;
  };
  wisdom_exported: boolean;
  background_jobs?: {
    active: Array<{ jobId: string; provider: string; model: string; agentRole: string; spawnedAt: string }>;
    recent: Array<{ jobId: string; provider: string; status: string; agentRole: string; completedAt?: string }>;
    stats: { total: number; active: number; completed: number; failed: number } | null;
  };
}

export interface HookOutput {
  continue: boolean;
  /** System message for context injection (Claude Code compatible) */
  systemMessage?: string;
}

// ============================================================================
// Constants
// ============================================================================

const CHECKPOINT_DIR = "checkpoints";

// ============================================================================
// Compaction Mutex - prevents concurrent compaction for the same directory
// ============================================================================

/**
 * Per-directory in-flight compaction promises.
 * When a compaction is already running for a directory, new callers
 * await the existing promise instead of running concurrently.
 * This prevents race conditions when multiple subagent results
 * arrive simultaneously (swarm/ultrawork).
 */
const inflightCompactions = new Map<string, Promise<HookOutput>>();

/**
 * Queue depth counter per directory for diagnostics.
 * Tracks how many callers are waiting on an in-flight compaction.
 */
const compactionQueueDepth = new Map<string, number>();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the checkpoint directory path
 */
export function getCheckpointPath(directory: string): string {
  const checkpointDir = join(getOmcRoot(directory), "state", CHECKPOINT_DIR);
  if (!existsSync(checkpointDir)) {
    mkdirSync(checkpointDir, { recursive: true });
  }
  return checkpointDir;
}

/**
 * Export wisdom from notepads to checkpoint
 */
export async function exportWisdomToNotepad(
  directory: string,
): Promise<{ wisdom: string; exported: boolean }> {
  const notepadsDir = join(getOmcRoot(directory), "notepads");

  if (!existsSync(notepadsDir)) {
    return { wisdom: "", exported: false };
  }

  const wisdomParts: string[] = [];
  let hasWisdom = false;

  try {
    // Read all plan directories
    const planDirs = readdirSync(notepadsDir).filter((name) => {
      const path = join(notepadsDir, name);
      return statSync(path).isDirectory();
    });

    for (const planDir of planDirs) {
      const planPath = join(notepadsDir, planDir);
      const wisdomFiles = [
        "learnings.md",
        "decisions.md",
        "issues.md",
        "problems.md",
      ];

      for (const wisdomFile of wisdomFiles) {
        const wisdomPath = join(planPath, wisdomFile);
        if (existsSync(wisdomPath)) {
          const content = readFileSync(wisdomPath, "utf-8").trim();
          if (content) {
            wisdomParts.push(`### ${planDir}/${wisdomFile}\n${content}`);
            hasWisdom = true;
          }
        }
      }
    }
  } catch (error) {
    console.error("[PreCompact] Error reading wisdom files:", error);
  }

  const wisdom =
    wisdomParts.length > 0
      ? `## Plan Wisdom\n\n${wisdomParts.join("\n\n")}`
      : "";

  return { wisdom, exported: hasWisdom };
}

/**
 * Save summary of active modes
 */
export async function saveModeSummary(
  directory: string,
): Promise<Record<string, unknown>> {
  const stateDir = join(getOmcRoot(directory), "state");
  const modes: Record<string, unknown> = {};

  const stateFiles = [
    {
      file: "autopilot-state.json",
      key: "autopilot",
      extract: (s: any) =>
        s.active
          ? { phase: s.phase || "unknown", originalIdea: s.originalIdea || "" }
          : null,
    },
    {
      file: "ralph-state.json",
      key: "ralph",
      extract: (s: any) =>
        s.active
          ? {
              iteration: s.iteration || 0,
              prompt: s.originalPrompt || s.prompt || "",
            }
          : null,
    },
    {
      file: "ultrawork-state.json",
      key: "ultrawork",
      extract: (s: any) =>
        s.active
          ? { original_prompt: s.original_prompt || s.prompt || "" }
          : null,
    },
    {
      file: "swarm-summary.json",
      key: "swarm",
      extract: (s: any) =>
        s.active
          ? {
              session_id: s.session_id || "active",
              task_count: s.task_count || 0,
            }
          : null,
    },
    {
      file: "ultrapilot-state.json",
      key: "ultrapilot",
      extract: (s: any) =>
        s.active
          ? {
              session_id: s.session_id || "",
              worker_count: s.worker_count || 0,
            }
          : null,
    },
    {
      file: "pipeline-state.json",
      key: "pipeline",
      extract: (s: any) =>
        s.active
          ? {
              preset: s.preset || "custom",
              current_stage: s.current_stage || 0,
            }
          : null,
    },
    {
      file: "ultraqa-state.json",
      key: "ultraqa",
      extract: (s: any) =>
        s.active
          ? { cycle: s.cycle || 0, prompt: s.original_prompt || s.prompt || "" }
          : null,
    },
  ];

  const reads = stateFiles.map(async (config) => {
    const path = join(stateDir, config.file);
    try {
      const content = await fsPromises.readFile(path, "utf-8");
      const state = JSON.parse(content);
      const extracted = config.extract(state);
      return extracted ? { key: config.key, value: extracted } : null;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      console.error(`[PreCompact] Error reading ${config.file}:`, error);
      return null;
    }
  });

  const results = await Promise.all(reads);

  for (const result of results) {
    if (result) {
      modes[result.key] = result.value;
    }
  }

  return modes;
}

/**
 * Read TODO counts from todos.json
 */
function readTodoSummary(directory: string): {
  pending: number;
  in_progress: number;
  completed: number;
} {
  const todoPaths = [
    join(directory, ".claude", "todos.json"),
    join(getOmcRoot(directory), "state", "todos.json"),
  ];

  for (const todoPath of todoPaths) {
    if (existsSync(todoPath)) {
      try {
        const content = readFileSync(todoPath, "utf-8");
        const todos = JSON.parse(content);

        if (Array.isArray(todos)) {
          return {
            pending: todos.filter((t: any) => t.status === "pending").length,
            in_progress: todos.filter((t: any) => t.status === "in_progress")
              .length,
            completed: todos.filter((t: any) => t.status === "completed")
              .length,
          };
        }
      } catch {
        // Continue to next path
      }
    }
  }

  return { pending: 0, in_progress: 0, completed: 0 };
}

/**
 * Get summary of active and recent background jobs from SQLite DB
 * Queries .omc/state/jobs.db for Codex/Gemini job statuses
 */
async function getActiveJobsSummary(directory: string): Promise<{
  activeJobs: Array<{ jobId: string; provider: string; model: string; agentRole: string; spawnedAt: string }>;
  recentJobs: Array<{ jobId: string; provider: string; status: string; agentRole: string; completedAt?: string }>;
  stats: { total: number; active: number; completed: number; failed: number } | null;
}> {
  try {
    const dbReady = await initJobDb(directory);
    if (!dbReady) {
      return { activeJobs: [], recentJobs: [], stats: null };
    }

    const active = getActiveJobs(undefined, directory);
    const recent = getRecentJobs(undefined, 5 * 60 * 1000, directory); // Last 5 minutes

    // Filter recent to only completed/failed (not active ones which are already listed)
    const recentCompleted = recent.filter(j => j.status === 'completed' || j.status === 'failed');

    const stats = getJobStats(directory);

    return {
      activeJobs: active.map(j => ({
        jobId: j.jobId,
        provider: j.provider,
        model: j.model,
        agentRole: j.agentRole,
        spawnedAt: j.spawnedAt,
      })),
      recentJobs: recentCompleted.slice(0, 10).map(j => ({
        jobId: j.jobId,
        provider: j.provider,
        status: j.status,
        agentRole: j.agentRole,
        completedAt: j.completedAt,
      })),
      stats,
    };
  } catch (error) {
    console.error('[PreCompact] Error reading job state DB:', error);
    return { activeJobs: [], recentJobs: [], stats: null };
  }
}

/**
 * Create a compact checkpoint
 */
export async function createCompactCheckpoint(
  directory: string,
  trigger: "manual" | "auto",
): Promise<CompactCheckpoint> {
  const activeModes = await saveModeSummary(directory);
  const todoSummary = readTodoSummary(directory);
  const jobsSummary = await getActiveJobsSummary(directory);

  return {
    created_at: new Date().toISOString(),
    trigger,
    active_modes: activeModes as CompactCheckpoint["active_modes"],
    todo_summary: todoSummary,
    wisdom_exported: false,
    background_jobs: {
      active: jobsSummary.activeJobs,
      recent: jobsSummary.recentJobs,
      stats: jobsSummary.stats,
    },
  };
}

/**
 * Format checkpoint summary for context injection
 */
export function formatCompactSummary(checkpoint: CompactCheckpoint): string {
  const lines: string[] = [
    "# PreCompact Checkpoint",
    "",
    `Created: ${checkpoint.created_at}`,
    `Trigger: ${checkpoint.trigger}`,
    "",
  ];

  // Active modes
  const modeCount = Object.keys(checkpoint.active_modes).length;
  if (modeCount > 0) {
    lines.push("## Active Modes");
    lines.push("");

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
      lines.push(
        `- **Swarm** (Session: ${swarm.session_id}, Tasks: ${swarm.task_count})`,
      );
    }

    if (checkpoint.active_modes.ultrapilot) {
      const up = checkpoint.active_modes.ultrapilot;
      lines.push(`- **Ultrapilot** (Workers: ${up.worker_count})`);
    }

    if (checkpoint.active_modes.pipeline) {
      const pipe = checkpoint.active_modes.pipeline;
      lines.push(
        `- **Pipeline** (Preset: ${pipe.preset}, Stage: ${pipe.current_stage})`,
      );
    }

    if (checkpoint.active_modes.ultraqa) {
      const qa = checkpoint.active_modes.ultraqa;
      lines.push(`- **UltraQA** (Cycle: ${qa.cycle})`);
      lines.push(`  Prompt: ${qa.prompt}`);
    }

    lines.push("");
  }

  // TODO summary
  const total =
    checkpoint.todo_summary.pending +
    checkpoint.todo_summary.in_progress +
    checkpoint.todo_summary.completed;

  if (total > 0) {
    lines.push("## TODO Summary");
    lines.push("");
    lines.push(`- Pending: ${checkpoint.todo_summary.pending}`);
    lines.push(`- In Progress: ${checkpoint.todo_summary.in_progress}`);
    lines.push(`- Completed: ${checkpoint.todo_summary.completed}`);
    lines.push("");
  }

  // Background jobs
  const jobs = checkpoint.background_jobs;
  if (jobs && (jobs.active.length > 0 || jobs.recent.length > 0)) {
    lines.push("## Background Jobs (Codex/Gemini)");
    lines.push("");

    if (jobs.active.length > 0) {
      lines.push("### Currently Running");
      for (const job of jobs.active) {
        const age = Math.round((Date.now() - new Date(job.spawnedAt).getTime()) / 1000);
        lines.push(`- **${job.jobId}** ${job.provider}/${job.model} (${job.agentRole}) - ${age}s ago`);
      }
      lines.push("");
    }

    if (jobs.recent.length > 0) {
      lines.push("### Recently Completed");
      for (const job of jobs.recent) {
        const icon = job.status === 'completed' ? 'OK' : 'FAIL';
        lines.push(`- **${job.jobId}** [${icon}] ${job.provider} (${job.agentRole})`);
      }
      lines.push("");
    }

    if (jobs.stats) {
      lines.push(`**Job Stats:** ${jobs.stats.active} active, ${jobs.stats.completed} completed, ${jobs.stats.failed} failed (${jobs.stats.total} total)`);
      lines.push("");
    }
  }

  // Wisdom status
  if (checkpoint.wisdom_exported) {
    lines.push("## Wisdom");
    lines.push("");
    lines.push("Plan wisdom has been preserved in checkpoint.");
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "**Note:** This checkpoint preserves critical state before compaction.",
  );
  lines.push("Review active modes to ensure continuity after compaction.");

  return lines.join("\n");
}

/**
 * Internal compaction logic (unserialized).
 * Callers must go through processPreCompact which enforces the mutex.
 */
async function doProcessPreCompact(
  input: PreCompactInput,
): Promise<HookOutput> {
  const directory = input.cwd;

  // Create checkpoint
  const checkpoint = await createCompactCheckpoint(directory, input.trigger);

  // Export wisdom
  const { wisdom, exported } = await exportWisdomToNotepad(directory);
  checkpoint.wisdom_exported = exported;

  // Save checkpoint
  const checkpointPath = getCheckpointPath(directory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const checkpointFile = join(checkpointPath, `checkpoint-${timestamp}.json`);

  try {
    writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2), "utf-8");
  } catch (error) {
    console.error("[PreCompact] Error saving checkpoint:", error);
  }

  // Save wisdom separately if exported
  if (exported && wisdom) {
    const wisdomFile = join(checkpointPath, `wisdom-${timestamp}.md`);
    try {
      writeFileSync(wisdomFile, wisdom, "utf-8");
    } catch (error) {
      console.error("[PreCompact] Error saving wisdom:", error);
    }
  }

  // Format summary for context injection
  const summary = formatCompactSummary(checkpoint);

  // Note: hookSpecificOutput only supports PreToolUse, UserPromptSubmit, PostToolUse
  // Use systemMessage for custom hook events like PreCompact
  return {
    continue: true,
    systemMessage: summary,
  };
}

/**
 * Main handler for PreCompact hook.
 *
 * Uses a per-directory mutex to prevent concurrent compaction.
 * When multiple subagent results arrive simultaneously (swarm/ultrawork),
 * only the first call runs the compaction; subsequent calls await
 * the in-flight result. This fixes issue #453.
 */
export async function processPreCompact(
  input: PreCompactInput,
): Promise<HookOutput> {
  const directory = input.cwd;

  // If compaction is already in progress for this directory, coalesce
  const inflight = inflightCompactions.get(directory);
  if (inflight) {
    const depth = (compactionQueueDepth.get(directory) ?? 0) + 1;
    compactionQueueDepth.set(directory, depth);
    try {
      // Await the existing compaction result
      return await inflight;
    } finally {
      const current = compactionQueueDepth.get(directory) ?? 1;
      if (current <= 1) {
        compactionQueueDepth.delete(directory);
      } else {
        compactionQueueDepth.set(directory, current - 1);
      }
    }
  }

  // No in-flight compaction — run it and register the promise
  const compactionPromise = doProcessPreCompact(input);
  inflightCompactions.set(directory, compactionPromise);

  try {
    return await compactionPromise;
  } finally {
    inflightCompactions.delete(directory);
  }
}

/**
 * Check if compaction is currently in progress for a directory.
 * Useful for diagnostics and testing.
 */
export function isCompactionInProgress(directory: string): boolean {
  return inflightCompactions.has(directory);
}

/**
 * Get the number of callers queued behind an in-flight compaction.
 * Returns 0 if no compaction is in progress.
 */
export function getCompactionQueueDepth(directory: string): number {
  return compactionQueueDepth.get(directory) ?? 0;
}

// ============================================================================
// Exports
// ============================================================================

export default processPreCompact;
