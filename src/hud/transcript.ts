/**
 * OMC HUD - Transcript Parser
 *
 * Parse JSONL transcript from Claude Code to extract agents and todos.
 * Based on claude-hud reference implementation.
 *
 * Performance optimizations:
 * - Tail-based parsing: reads only the last ~500KB of large transcripts
 * - Bounded agent map: caps at 50 agents during parsing
 * - Early termination: stops when enough running agents found
 */

import {
  createReadStream,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { createInterface } from "readline";
import { basename } from "path";
import type {
  TranscriptData,
  ActiveAgent,
  TodoItem,
  SkillInvocation,
  PendingPermission,
  ThinkingState,
} from "./types.js";

// Performance constants
const MAX_TAIL_BYTES = 512 * 1024; // 500KB - enough for recent activity
const MAX_AGENT_MAP_SIZE = 100; // Cap agent tracking
const MIN_RUNNING_AGENTS_THRESHOLD = 10; // Early termination threshold

/**
 * Tools known to require permission approval in Claude Code.
 * Only these tools will trigger the "APPROVE?" indicator.
 */
const PERMISSION_TOOLS = [
  "Edit",
  "Write",
  "Bash",
  "proxy_Edit",
  "proxy_Write",
  "proxy_Bash",
] as const;

/**
 * Time threshold for considering a tool "pending approval".
 * If tool_use exists without tool_result within this window, show indicator.
 */
const PERMISSION_THRESHOLD_MS = 3000; // 3 seconds

/**
 * Module-level map tracking pending permission-requiring tools.
 * Key: tool_use block id, Value: PendingPermission info
 * Cleared when tool_result is received for the corresponding tool_use.
 */
const pendingPermissionMap = new Map<string, PendingPermission>();

/**
 * Content block types that indicate extended thinking mode.
 */
const THINKING_PART_TYPES = ["thinking", "reasoning"] as const;

/**
 * Time threshold for considering thinking "active".
 */
const THINKING_RECENCY_MS = 30_000; // 30 seconds

/**
 * Parse a Claude Code transcript JSONL file.
 * Extracts running agents and latest todo list.
 *
 * For large files (>500KB), only parses the tail portion for performance.
 */
export interface ParseTranscriptOptions {
  staleTaskThresholdMinutes?: number;
}

export async function parseTranscript(
  transcriptPath: string | undefined,
  options?: ParseTranscriptOptions,
): Promise<TranscriptData> {
  // IMPORTANT: Clear module-level state at the start of each parse
  // to prevent stale data from previous HUD invocations
  pendingPermissionMap.clear();

  const result: TranscriptData = {
    agents: [],
    todos: [],
    lastActivatedSkill: undefined,
  };

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return result;
  }

  const agentMap = new Map<string, ActiveAgent>();
  const backgroundAgentMap: BackgroundAgentMap = new Map();
  let latestTodos: TodoItem[] = [];

  try {
    // Check file size to determine parsing strategy
    const stat = statSync(transcriptPath);
    const fileSize = stat.size;

    if (fileSize > MAX_TAIL_BYTES) {
      // Large file: use tail-based parsing
      const lines = readTailLines(transcriptPath, fileSize, MAX_TAIL_BYTES);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          processEntry(
            entry,
            agentMap,
            latestTodos,
            result,
            MAX_AGENT_MAP_SIZE,
            backgroundAgentMap,
          );
        } catch {
          // Skip malformed lines
        }
      }
    } else {
      // Small file: stream entire file
      const fileStream = createReadStream(transcriptPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);
          processEntry(
            entry,
            agentMap,
            latestTodos,
            result,
            MAX_AGENT_MAP_SIZE,
            backgroundAgentMap,
          );
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // Return partial results on error
  }

  // Filter out stale agents (running for more than threshold minutes are likely abandoned)
  const staleMinutes = options?.staleTaskThresholdMinutes ?? 30;
  const STALE_AGENT_THRESHOLD_MS = staleMinutes * 60 * 1000;
  const now = Date.now();

  for (const agent of agentMap.values()) {
    if (agent.status === "running") {
      const runningTime = now - agent.startTime.getTime();
      if (runningTime > STALE_AGENT_THRESHOLD_MS) {
        // Mark as completed (stale)
        agent.status = "completed";
        agent.endTime = new Date(
          agent.startTime.getTime() + STALE_AGENT_THRESHOLD_MS,
        );
      }
    }
  }

  // Check for pending permissions within threshold
  for (const [id, permission] of pendingPermissionMap) {
    const age = now - permission.timestamp.getTime();
    if (age <= PERMISSION_THRESHOLD_MS) {
      result.pendingPermission = permission;
      break; // Only show most recent
    }
  }

  // Determine if thinking is currently active based on recency
  if (result.thinkingState?.lastSeen) {
    const age = now - result.thinkingState.lastSeen.getTime();
    result.thinkingState.active = age <= THINKING_RECENCY_MS;
  }

  // Get running agents first, then recent completed (up to 10 total)
  const running = Array.from(agentMap.values()).filter(
    (a) => a.status === "running",
  );
  const completed = Array.from(agentMap.values()).filter(
    (a) => a.status === "completed",
  );
  result.agents = [
    ...running,
    ...completed.slice(-(10 - running.length)),
  ].slice(0, 10);
  result.todos = latestTodos;

  return result;
}

/**
 * Read the tail portion of a file and split into lines.
 * Handles partial first line (from mid-file start).
 */
function readTailLines(
  filePath: string,
  fileSize: number,
  maxBytes: number,
): string[] {
  const startOffset = Math.max(0, fileSize - maxBytes);
  const bytesToRead = fileSize - startOffset;

  const fd = openSync(filePath, "r");
  const buffer = Buffer.alloc(bytesToRead);

  try {
    readSync(fd, buffer, 0, bytesToRead, startOffset);
  } finally {
    closeSync(fd);
  }

  const content = buffer.toString("utf8");
  const lines = content.split("\n");

  // If we started mid-file, discard the potentially incomplete first line
  if (startOffset > 0 && lines.length > 0) {
    lines.shift();
  }

  return lines;
}

// Map from background agent IDs (e.g., "a8de3dd") to tool_use_id
type BackgroundAgentMap = Map<string, string>;

/**
 * Extract background agent ID from "Async agent launched" message
 */
function extractBackgroundAgentId(
  content: string | Array<{ type?: string; text?: string }>,
): string | null {
  const text =
    typeof content === "string"
      ? content
      : content.find((c) => c.type === "text")?.text || "";

  // Pattern: "agentId: a8de3dd"
  const match = text.match(/agentId:\s*([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Parse TaskOutput result for completion status
 */
function parseTaskOutputResult(
  content: string | Array<{ type?: string; text?: string }>,
): { taskId: string; status: string } | null {
  const text =
    typeof content === "string"
      ? content
      : content.find((c) => c.type === "text")?.text || "";

  // Extract task_id and status from XML-like format
  const taskIdMatch = text.match(/<task_id>([^<]+)<\/task_id>/);
  const statusMatch = text.match(/<status>([^<]+)<\/status>/);

  if (taskIdMatch && statusMatch) {
    return { taskId: taskIdMatch[1], status: statusMatch[1] };
  }
  return null;
}

/**
 * Extract a human-readable target summary from tool input.
 */
function extractTargetSummary(input: unknown, toolName: string): string {
  if (!input || typeof input !== "object") return "...";
  const inp = input as Record<string, unknown>;

  // Edit/Write: show file path
  if (toolName.includes("Edit") || toolName.includes("Write")) {
    const filePath = inp.file_path as string | undefined;
    if (filePath) {
      // Return just the filename or last path segment
      return basename(filePath) || filePath;
    }
  }

  // Bash: show first 20 chars of command
  if (toolName.includes("Bash")) {
    const cmd = inp.command as string | undefined;
    if (cmd) {
      const trimmed = cmd.trim().substring(0, 20);
      return trimmed.length < cmd.trim().length ? `${trimmed}...` : trimmed;
    }
  }

  return "...";
}

/**
 * Process a single transcript entry
 */
function processEntry(
  entry: TranscriptEntry,
  agentMap: Map<string, ActiveAgent>,
  latestTodos: TodoItem[],
  result: TranscriptData,
  maxAgentMapSize: number = 50,
  backgroundAgentMap?: BackgroundAgentMap,
): void {
  const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();

  // Set session start time from first entry
  if (!result.sessionStart && entry.timestamp) {
    result.sessionStart = timestamp;
  }

  const content = entry.message?.content;
  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    // Check if this is a thinking block
    if (
      THINKING_PART_TYPES.includes(
        block.type as (typeof THINKING_PART_TYPES)[number],
      )
    ) {
      result.thinkingState = {
        active: true,
        lastSeen: timestamp,
      };
    }

    // Track tool_use for Task (agents) and TodoWrite
    if (block.type === "tool_use" && block.id && block.name) {
      if (block.name === "Task" || block.name === "proxy_Task") {
        const input = block.input as TaskInput | undefined;
        const agentEntry: ActiveAgent = {
          id: block.id,
          type: input?.subagent_type ?? "unknown",
          model: input?.model,
          description: input?.description,
          status: "running",
          startTime: timestamp,
        };

        // Bounded agent map: evict oldest completed agents if at capacity
        if (agentMap.size >= maxAgentMapSize) {
          // Find and remove oldest completed agent
          let oldestCompleted: string | null = null;
          let oldestTime = Infinity;
          for (const [id, agent] of agentMap) {
            if (agent.status === "completed" && agent.startTime) {
              const time = agent.startTime.getTime();
              if (time < oldestTime) {
                oldestTime = time;
                oldestCompleted = id;
              }
            }
          }
          if (oldestCompleted) {
            agentMap.delete(oldestCompleted);
          }
        }

        agentMap.set(block.id, agentEntry);
      } else if (block.name === "TodoWrite") {
        const input = block.input as TodoWriteInput | undefined;
        if (input?.todos && Array.isArray(input.todos)) {
          // Replace latest todos with new ones
          latestTodos.length = 0;
          latestTodos.push(
            ...input.todos.map((t) => ({
              content: t.content,
              status: t.status as TodoItem["status"],
              activeForm: t.activeForm,
            })),
          );
        }
      } else if (block.name === "Skill" || block.name === "proxy_Skill") {
        // Track last activated skill
        const input = block.input as SkillInput | undefined;
        if (input?.skill) {
          result.lastActivatedSkill = {
            name: input.skill,
            args: input.args,
            timestamp: timestamp,
          };
        }
      }

      // Track tool_use for permission-requiring tools
      if (
        PERMISSION_TOOLS.includes(
          block.name as (typeof PERMISSION_TOOLS)[number],
        )
      ) {
        pendingPermissionMap.set(block.id, {
          toolName: block.name.replace("proxy_", ""),
          targetSummary: extractTargetSummary(block.input, block.name),
          timestamp: timestamp,
        });
      }
    }

    // Track tool_result to mark agents as completed
    if (block.type === "tool_result" && block.tool_use_id) {
      // Clear from pending permissions when tool_result arrives
      pendingPermissionMap.delete(block.tool_use_id);

      const agent = agentMap.get(block.tool_use_id);
      if (agent) {
        const blockContent = block.content;

        // Check if this is a background agent launch result
        const isBackgroundLaunch =
          typeof blockContent === "string"
            ? blockContent.includes("Async agent launched")
            : Array.isArray(blockContent) &&
              blockContent.some(
                (c: { type?: string; text?: string }) =>
                  c.type === "text" && c.text?.includes("Async agent launched"),
              );

        if (isBackgroundLaunch) {
          // Extract and store the background agent ID mapping
          if (backgroundAgentMap && blockContent) {
            const bgAgentId = extractBackgroundAgentId(blockContent);
            if (bgAgentId) {
              backgroundAgentMap.set(bgAgentId, block.tool_use_id);
            }
          }
          // Keep status as 'running'
        } else {
          // Foreground agent completed
          agent.status = "completed";
          agent.endTime = timestamp;
        }
      }

      // Check if this is a TaskOutput result showing completion
      if (backgroundAgentMap && block.content) {
        const taskOutput = parseTaskOutputResult(block.content);
        if (taskOutput && taskOutput.status === "completed") {
          // Find the original agent by background agent ID
          const toolUseId = backgroundAgentMap.get(taskOutput.taskId);
          if (toolUseId) {
            const bgAgent = agentMap.get(toolUseId);
            if (bgAgent && bgAgent.status === "running") {
              bgAgent.status = "completed";
              bgAgent.endTime = timestamp;
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// Type Definitions for Transcript Parsing
// ============================================================================

interface TranscriptEntry {
  timestamp?: string;
  message?: {
    content?: ContentBlock[];
  };
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface TaskInput {
  subagent_type?: string;
  model?: string;
  description?: string;
}

interface TodoWriteInput {
  todos?: Array<{
    content: string;
    status: string;
    activeForm?: string;
  }>;
}

interface SkillInput {
  skill: string;
  args?: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get count of running agents
 */
export function getRunningAgentCount(agents: ActiveAgent[]): number {
  return agents.filter((a) => a.status === "running").length;
}

/**
 * Get todo completion stats
 */
export function getTodoStats(todos: TodoItem[]): {
  completed: number;
  total: number;
  inProgress: number;
} {
  return {
    completed: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
    inProgress: todos.filter((t) => t.status === "in_progress").length,
  };
}
