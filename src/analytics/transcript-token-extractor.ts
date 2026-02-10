import { createHash } from 'crypto';
import type { TokenUsage, TranscriptEntry } from './types.js';

/**
 * Extracted usage with metadata
 */
export interface ExtractedUsage {
  usage: TokenUsage;
  entryId: string;
  sourceFile: string;
}

/**
 * Task spawn info extracted from assistant entries
 */
export interface TaskSpawnInfo {
  toolUseId: string;
  agentType: string;
}

/**
 * Normalize model name to pricing tier
 */
function normalizeModelName(model: string): string {
  const lower = model.toLowerCase();

  if (lower.includes('opus')) {
    return 'claude-opus-4.6';
  } else if (lower.includes('sonnet')) {
    return 'claude-sonnet-4.5';
  } else if (lower.includes('haiku')) {
    return 'claude-haiku-4';
  }

  // Fallback to original if no match
  return model;
}

/**
 * Extract Task tool spawn info from an assistant entry.
 * Returns all Task tool calls with their toolUseId and agentType.
 *
 * This is used to build a lookup table for attributing progress entries
 * to the correct agent.
 */
export function extractTaskSpawns(entry: TranscriptEntry): TaskSpawnInfo[] {
  const spawns: TaskSpawnInfo[] = [];

  if (entry.type !== 'assistant' || !entry.message?.content) {
    return spawns;
  }

  for (const block of entry.message.content) {
    if (block.type === 'tool_use' && block.name === 'Task') {
      const toolUseId = (block as any).id;
      const input = block.input as { subagent_type?: string } | undefined;
      if (toolUseId && input?.subagent_type) {
        spawns.push({
          toolUseId,
          agentType: input.subagent_type
        });
      }
    }
  }

  return spawns;
}

/**
 * Detect agent name from transcript entry context
 *
 * For PROGRESS entries: Use the agentLookup to find the agent from parentToolUseID
 * For ASSISTANT entries: These are main session responses, return undefined
 *
 * NOTE: entry.slug is the SESSION slug (random words like "validated-cooking-twilight")
 * and should NOT be used as agent name.
 */
function detectAgentName(
  entry: TranscriptEntry,
  agentLookup?: Map<string, string>
): string | undefined {
  // For progress entries, look up agent from parentToolUseID
  if (entry.type === 'progress') {
    const parentToolUseID = (entry as any).parentToolUseID;
    if (parentToolUseID && agentLookup) {
      return agentLookup.get(parentToolUseID);
    }
    // Fallback to agentId if it looks like an agent type
    if (entry.agentId && entry.agentId.includes(':')) {
      return entry.agentId;
    }
    return undefined;
  }

  // For assistant entries: these are main session responses
  // Even if they contain Task tool calls, the usage is for the main session
  // (the cost of generating the Task call), not the spawned agent's cost
  return undefined;
}

/**
 * Generate unique entry ID for deduplication
 */
function generateEntryId(sessionId: string, timestamp: string, model: string): string {
  const hash = createHash('sha256');
  hash.update(`${sessionId}:${timestamp}:${model}`);
  return hash.digest('hex');
}

/**
 * Extract token usage from transcript entry
 *
 * @param entry - Transcript entry from JSONL file
 * @param sessionId - Session ID (override if not in entry)
 * @param sourceFile - Source file path for tracking
 * @param agentLookup - Map of toolUseId → agentType for attributing progress entries
 * @returns ExtractedUsage or null if entry has no usage data
 */
export function extractTokenUsage(
  entry: TranscriptEntry,
  sessionId: string,
  sourceFile: string,
  agentLookup?: Map<string, string>
): ExtractedUsage | null {
  let usage: any;
  let model: string | undefined;

  // Handle assistant entries
  if (entry.type === 'assistant' && entry.message?.usage) {
    usage = entry.message.usage;
    model = entry.message.model;
  }
  // Handle progress entries from agent responses
  else if (entry.type === 'progress' && entry.data?.message?.message?.usage) {
    usage = entry.data.message.message.usage;
    model = entry.data.message.message.model;
  }
  // No usage data found
  else {
    return null;
  }

  if (!model) {
    return null;
  }

  // Skip synthetic model entries
  if (model === '<synthetic>') {
    return null;
  }

  // Use ACTUAL output_tokens from transcript (not estimates!)
  const outputTokens = usage.output_tokens;
  const inputTokens = usage.input_tokens || 0;

  // Handle cache tokens
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  const tokenUsage: TokenUsage = {
    timestamp: entry.timestamp,
    sessionId: sessionId || entry.sessionId,
    agentName: detectAgentName(entry, agentLookup),
    modelName: normalizeModelName(model),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens
  };

  const entryId = generateEntryId(
    tokenUsage.sessionId,
    tokenUsage.timestamp,
    tokenUsage.modelName
  );

  return {
    usage: tokenUsage,
    entryId,
    sourceFile
  };
}
