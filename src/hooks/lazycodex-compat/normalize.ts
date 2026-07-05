import { z } from 'zod';
import {
  isLazyCodexCompatEventName,
  type LazyCodexCompatEventName,
  type LazyCodexCompatNormalizedEvent,
  type LazyCodexCompatPortableEventId,
} from './types.js';

const RawHookSchema = z.object({
  hook_event_name: z.string().optional(),
  hookEventName: z.string().optional(),
  cwd: z.string().optional(),
  directory: z.string().optional(),
  session_id: z.string().optional(),
  sessionId: z.string().optional(),
  prompt: z.string().optional(),
  message: z.object({ content: z.string().optional() }).optional(),
  tool_name: z.string().optional(),
  toolName: z.string().optional(),
  tool_input: z.unknown().optional(),
  toolInput: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
  toolResponse: z.unknown().optional(),
  trigger: z.enum(['manual', 'auto']).optional(),
  stop_reason: z.string().optional(),
  stopReason: z.string().optional(),
  agent_id: z.string().optional(),
  agentId: z.string().optional(),
  agent_type: z.string().optional(),
  agentType: z.string().optional(),
  agent_name: z.string().optional(),
  agentName: z.string().optional(),
  success: z.boolean().optional(),
  output: z.string().optional(),
  parts: z.unknown().optional(),
}).passthrough();

function toEventName(value: string | undefined, fallback?: LazyCodexCompatEventName): LazyCodexCompatEventName {
  if (value && isLazyCodexCompatEventName(value)) {
    return value;
  }

  if (value === 'PostCompact') {
    return 'PreCompact';
  }

  return fallback ?? 'UserPromptSubmit';
}

function toPortableEventId(eventName: LazyCodexCompatEventName): LazyCodexCompatPortableEventId {
  switch (eventName) {
    case 'UserPromptSubmit':
      return 'prompt-submitted';
    case 'PostToolUse':
      return 'tool-use-after';
    case 'PreCompact':
      return 'compact-before';
    case 'Stop':
      return 'session-stopping';
    case 'SubagentStop':
      return 'subagent-stopped';
  }
}

function promptFromParts(input: unknown): string | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const texts = input.flatMap((part) => {
    const parsed = z.object({ type: z.string(), text: z.string().optional() }).safeParse(part);
    return parsed.success && parsed.data.type === 'text' && parsed.data.text
      ? [parsed.data.text]
      : [];
  });

  return texts.length > 0 ? texts.join(' ') : undefined;
}

export function normalizeLazyCodexCompatHookInput(
  raw: unknown,
  fallbackEventName?: LazyCodexCompatEventName,
): LazyCodexCompatNormalizedEvent {
  const parsed = RawHookSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : {};
  const eventName = toEventName(data.hook_event_name ?? data.hookEventName, fallbackEventName);
  const prompt = data.prompt ?? data.message?.content ?? promptFromParts(data.parts);

  return {
    eventName,
    portableEventId: toPortableEventId(eventName),
    cwd: data.cwd ?? data.directory ?? process.cwd(),
    sessionId: data.session_id ?? data.sessionId ?? 'unknown-session',
    prompt,
    toolName: data.tool_name ?? data.toolName,
    toolInput: data.tool_input ?? data.toolInput,
    toolOutput: data.tool_response ?? data.toolOutput ?? data.toolResponse,
    trigger: data.trigger,
    stopReason: data.stop_reason ?? data.stopReason,
    agentId: data.agent_id ?? data.agentId,
    agentType: data.agent_type ?? data.agentType ?? data.agent_name ?? data.agentName,
    success: data.success,
    output: data.output,
  };
}
