import { z } from 'zod';

export type LazyCodexPortableHostEventId = 'session-started' | 'prompt-submitted' | 'tool-use-before' | 'tool-use-after' | 'compact-before' | 'session-stopping' | 'subagent-started' | 'subagent-stopped';
export type ClaudeHostEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop' | 'SubagentStart' | 'SubagentStop';
export type LazyCodexHostEventSupport = 'supported' | 'fallback' | 'claude-only' | 'unsupported';

export interface LazyCodexHostEventFallback {
  readonly claudeEvent: ClaudeHostEvent;
  readonly reason: string;
}

export type LazyCodexHostEventCompatibility = {
  readonly portableEventId: LazyCodexPortableHostEventId;
  readonly support: LazyCodexHostEventSupport;
  readonly claudeEvent?: ClaudeHostEvent;
  readonly fallback?: LazyCodexHostEventFallback;
  readonly unsupportedReason?: string;
  readonly payloadNormalizationNotes: readonly string[];
  readonly decisionSemanticsNotes: readonly string[];
};

export type LazyCodexHostEventCompatibilityError = {
  readonly code: 'MALFORMED_EVENT_ID' | 'UNKNOWN_EVENT_ID';
  readonly message: string;
};

export type LazyCodexHostEventCompatibilityResult =
  | {
      readonly ok: true;
      readonly entry: LazyCodexHostEventCompatibility;
    }
  | {
      readonly ok: false;
      readonly error: LazyCodexHostEventCompatibilityError;
    };

export type LazyCodexHostEventCompatibilityReport = {
  readonly matrix: readonly LazyCodexHostEventCompatibility[];
  readonly missingLazyCodexSources: readonly LazyCodexPortableHostEventId[];
  readonly missingClaudeEvents: readonly LazyCodexPortableHostEventId[];
  readonly sourceAbsentEvents: readonly LazyCodexPortableHostEventId[];
  readonly claudeOnlyEvents: readonly LazyCodexPortableHostEventId[];
  readonly entriesWithLazyCodexSourceEvidence: readonly LazyCodexPortableHostEventId[];
  readonly sourceEvidence: readonly LazyCodexHostEventSourceEvidence[];
};

export type LazyCodexHostEventSourceEvidence = {
  readonly portableEventId: LazyCodexPortableHostEventId;
  readonly matchedHookPaths: readonly string[];
};

const PortableEventIdSchema = z.string().trim().min(1);
const InventoryInputSchema = z.object({
  lazycodexHookPaths: z.array(z.string()),
  claudeHookEvents: z.array(z.string()),
});

const LAZYCODEX_HOST_EVENT_COMPATIBILITY_MATRIX = [
  {
    portableEventId: 'session-started',
    claudeEvent: 'SessionStart',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize host cwd, session id, transcript path, and startup source into one session-started payload.'],
    decisionSemanticsNotes: ['Claude SessionStart hooks are informational; policy decisions must be expressed through hook output metadata, not source-host lifecycle names.'],
  },
  {
    portableEventId: 'prompt-submitted',
    claudeEvent: 'UserPromptSubmit',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize submitted prompt text, cwd, session id, and project rule context before workflow detection.'],
    decisionSemanticsNotes: ['Prompt-time steering remains advisory unless a downstream Claude hook returns an explicit decision field.'],
  },
  {
    portableEventId: 'tool-use-before',
    claudeEvent: 'PreToolUse',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize tool name, tool input, cwd, session id, and permission context before policy checks.'],
    decisionSemanticsNotes: ['Pre-tool allow, deny, and continue decisions must use Claude hook decision fields with compatibility reasons attached as metadata.'],
  },
  {
    portableEventId: 'tool-use-after',
    claudeEvent: 'PostToolUse',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize tool name, exit status, stdout, stderr, file artifact hints, cwd, and session id after execution.'],
    decisionSemanticsNotes: ['Post-tool diagnostics and evidence gates may inject follow-up guidance but should not depend on source-host result envelopes.'],
  },
  {
    portableEventId: 'compact-before',
    claudeEvent: 'PreCompact',
    support: 'fallback',
    fallback: {
      claudeEvent: 'PreCompact',
      reason:
        'Claude exposes a pre-compaction hook; compatibility cache resets run before compaction with idempotent reset notes.',
    },
    payloadNormalizationNotes: ['Normalize compaction trigger, cwd, session id, and cache reset scope; do not assume a post-compaction transcript window exists.'],
    decisionSemanticsNotes: ['Fallback behavior must be idempotent because Claude PreCompact can run before the compacted transcript is materialized.'],
  },
  {
    portableEventId: 'session-stopping',
    claudeEvent: 'Stop',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize stop reason, cwd, session id, active workflow state, and evidence receipt paths.'],
    decisionSemanticsNotes: ['Stop continuation uses Claude soft-enforcement message injection and must avoid hard blocking during context-limit or user-abort stops.'],
  },
  {
    portableEventId: 'subagent-started',
    claudeEvent: 'SubagentStart',
    support: 'claude-only',
    payloadNormalizationNotes: ['Normalize child agent id, parent session id, cwd, role hint, and task summary when the Claude host provides them.'],
    decisionSemanticsNotes: ['Claude-only compatibility is explicit; source inventory reports this as absent instead of manufacturing source evidence.'],
  },
  {
    portableEventId: 'subagent-stopped',
    claudeEvent: 'SubagentStop',
    support: 'supported',
    payloadNormalizationNotes: ['Normalize child agent id, parent session id, cwd, completion status, and evidence receipt paths.'],
    decisionSemanticsNotes: ['Executor evidence verification may request continuation through Claude-native messaging but must not assume source-host subagent result shapes.'],
  },
] as const satisfies readonly LazyCodexHostEventCompatibility[];

const LAZYCODEX_SOURCE_EVIDENCE = [
  { portableEventId: 'session-started', status: 'present', markers: ['session-start'] },
  { portableEventId: 'prompt-submitted', status: 'present', markers: ['user-prompt-submit'] },
  { portableEventId: 'tool-use-before', status: 'present', markers: ['pre-tool-use'] },
  { portableEventId: 'tool-use-after', status: 'present', markers: ['post-tool-use'] },
  { portableEventId: 'compact-before', status: 'present', markers: ['post-compact'] },
  { portableEventId: 'session-stopping', status: 'present', markers: ['stop'] },
  {
    portableEventId: 'subagent-started',
    status: 'absent',
    reason: 'LazyCodex reference has no SubagentStart hook registration; Claude host supports the event for future adapters.',
  },
  { portableEventId: 'subagent-stopped', status: 'present', markers: ['subagent-stop'] },
] as const;

function normalizePortableEventId(input: string): string {
  return input.trim().toLowerCase();
}

function hasClaudeEventEvidence(
  claudeHookEvents: readonly string[],
  entry: LazyCodexHostEventCompatibility,
): boolean {
  switch (entry.support) {
    case 'supported':
    case 'fallback':
    case 'claude-only':
      if (!entry.claudeEvent) {
        return false;
      }

      return claudeHookEvents.includes(entry.claudeEvent);
    case 'unsupported':
      return true;
  }
}

function getSourceEvidence(
  portableEventId: LazyCodexPortableHostEventId,
  lazycodexHookPaths: readonly string[],
): LazyCodexHostEventSourceEvidence | null {
  const source = LAZYCODEX_SOURCE_EVIDENCE.find((entry) => entry.portableEventId === portableEventId);
  if (!source || source.status === 'absent') {
    return null;
  }

  return {
    portableEventId,
    matchedHookPaths: lazycodexHookPaths.filter((path) =>
      source.markers.some((marker) => hasHookFilenameMarker(path, marker)),
    ),
  };
}

function hasHookFilenameMarker(path: string, marker: string): boolean {
  const filename = path.split('/').at(-1) ?? path;
  return filename === `${marker}.json` || filename.startsWith(`${marker}-`);
}

export function getLazyCodexHostEventCompatibilityMatrix(): readonly LazyCodexHostEventCompatibility[] {
  return LAZYCODEX_HOST_EVENT_COMPATIBILITY_MATRIX;
}

export function resolveLazyCodexHostEventCompatibility(
  input: unknown,
): LazyCodexHostEventCompatibilityResult {
  const parsed = PortableEventIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'MALFORMED_EVENT_ID',
        message: 'LazyCodex portable host event id must be a non-empty string',
      },
    };
  }

  const portableEventId = normalizePortableEventId(parsed.data);
  const entry = LAZYCODEX_HOST_EVENT_COMPATIBILITY_MATRIX.find(
    (candidate) => candidate.portableEventId === portableEventId,
  );
  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_EVENT_ID',
        message: `No LazyCodex Claude host event compatibility is defined for: ${portableEventId}`,
      },
    };
  }

  return {
    ok: true,
    entry,
  };
}

export function createLazyCodexHostEventCompatibilityReport(
  input: unknown,
): LazyCodexHostEventCompatibilityReport {
  const parsed = InventoryInputSchema.parse(input);
  const missingLazyCodexSources: LazyCodexPortableHostEventId[] = [];
  const missingClaudeEvents: LazyCodexPortableHostEventId[] = [];
  const sourceAbsentEvents: LazyCodexPortableHostEventId[] = [];
  const claudeOnlyEvents: LazyCodexPortableHostEventId[] = [];
  const entriesWithLazyCodexSourceEvidence: LazyCodexPortableHostEventId[] = [];
  const sourceEvidence: LazyCodexHostEventSourceEvidence[] = [];

  for (const entry of LAZYCODEX_HOST_EVENT_COMPATIBILITY_MATRIX) {
    const evidence = getSourceEvidence(entry.portableEventId, parsed.lazycodexHookPaths);
    const hasClaudeEvidence = hasClaudeEventEvidence(parsed.claudeHookEvents, entry);
    if (evidence) {
      sourceEvidence.push(evidence);
    }

    if (entry.support === 'claude-only') {
      claudeOnlyEvents.push(entry.portableEventId);
    }
    if (!evidence) {
      sourceAbsentEvents.push(entry.portableEventId);
    }
    if (evidence && evidence.matchedHookPaths.length === 0) {
      missingLazyCodexSources.push(entry.portableEventId);
    }
    if (!hasClaudeEvidence) {
      missingClaudeEvents.push(entry.portableEventId);
    }
    if (evidence && evidence.matchedHookPaths.length > 0) {
      entriesWithLazyCodexSourceEvidence.push(entry.portableEventId);
    }
  }

  return {
    matrix: LAZYCODEX_HOST_EVENT_COMPATIBILITY_MATRIX,
    missingLazyCodexSources,
    missingClaudeEvents,
    sourceAbsentEvents,
    claudeOnlyEvents,
    entriesWithLazyCodexSourceEvidence,
    sourceEvidence,
  };
}
