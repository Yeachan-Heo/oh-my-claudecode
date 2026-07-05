import type { HookOutput } from '../bridge.js';

export const LazyCodexCompatEventNames = [
  'UserPromptSubmit',
  'PostToolUse',
  'PreCompact',
  'Stop',
  'SubagentStop',
] as const;

export type LazyCodexCompatEventName = (typeof LazyCodexCompatEventNames)[number];

export type LazyCodexCompatPortableEventId =
  | 'prompt-submitted'
  | 'tool-use-after'
  | 'compact-before'
  | 'session-stopping'
  | 'subagent-stopped';

export interface LazyCodexCompatNormalizedEvent {
  readonly eventName: LazyCodexCompatEventName;
  readonly portableEventId: LazyCodexCompatPortableEventId;
  readonly cwd: string;
  readonly sessionId: string;
  readonly prompt?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly trigger?: 'manual' | 'auto';
  readonly stopReason?: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly success?: boolean;
  readonly output?: string;
}

export interface LazyCodexCompatDecision {
  readonly behavior:
    | 'project-rules'
    | 'ultrawork-trigger'
    | 'ulw-steering'
    | 'host-policy'
    | 'comment-checking'
    | 'lsp-codegraph-guidance'
    | 'cache-reset'
    | 'start-work-continuation'
    | 'executor-evidence'
    | 'malformed-input';
  readonly decision: string;
  readonly reason?: string;
  readonly artifactCount?: number;
  readonly remainingCount?: number;
}

export interface LazyCodexCompatSideEffect {
  readonly name: string;
  readonly path?: string;
}

export interface LazyCodexCompatMetadata {
  readonly normalized: LazyCodexCompatNormalizedEvent;
  readonly decisions: readonly LazyCodexCompatDecision[];
  readonly sideEffects: readonly LazyCodexCompatSideEffect[];
}

export type LazyCodexCompatHookResult = HookOutput & {
  readonly lazycodexCompat: LazyCodexCompatMetadata;
};

export function isLazyCodexCompatEventName(value: string): value is LazyCodexCompatEventName {
  switch (value) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PreCompact':
    case 'Stop':
    case 'SubagentStop':
      return true;
    default:
      return false;
  }
}
