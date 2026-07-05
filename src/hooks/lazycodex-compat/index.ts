import { createLazyCodexPolicy } from '../../interop/lazycodex-policy.js';
import { detectKeywordsWithType } from '../keyword-detector/index.js';
import { createCommentCheckerHook } from '../comment-checker/index.js';
import { z } from 'zod';
import type {
  LazyCodexCompatDecision,
  LazyCodexCompatEventName,
  LazyCodexCompatHookResult,
  LazyCodexCompatSideEffect,
} from './types.js';
import { normalizeLazyCodexCompatHookInput } from './normalize.js';
import {
  loadProjectRules,
  recordCompactReset,
  recordUlwSteering,
} from './state.js';
import { checkStartWorkContinuation } from './continuation.js';
import { verifyExecutorEvidence } from './evidence.js';
import { LazyCodexSinkSafetyError } from './safe-file.js';
import { LAZYCODEX_ULTRAWORK_COMPAT_DIRECTIVE } from './ultrawork-directive.js';

const ToolInputRecordSchema = z.record(z.unknown());

function joinMessages(messages: readonly string[]): string | undefined {
  const joined = messages.filter((message) => message.trim().length > 0).join('\n\n');
  return joined.length > 0 ? joined : undefined;
}

function hostPolicyDecision(): LazyCodexCompatDecision {
  const policy = createLazyCodexPolicy();
  return {
    behavior: 'host-policy',
    decision: policy.autoUpdate || policy.globalClaudeMutation || policy.telemetry
      ? 'explicit-opt-in'
      : 'disabled-by-default',
    reason: policy.optInTrail.length > 0
      ? policy.optInTrail.map((entry) => entry.key).join(', ')
      : 'T4 policy disables auto-update, global Claude mutation, and telemetry by default',
  };
}

function isEditLikeTool(toolName: string | undefined): boolean {
  const normalized = toolName?.toLowerCase();
  return normalized === 'write'
    || normalized === 'edit'
    || normalized === 'multiedit'
    || normalized === 'apply_patch';
}

function isCodegraphTool(toolName: string | undefined): boolean {
  const normalized = toolName?.toLowerCase() ?? '';
  return normalized.startsWith('codegraph')
    || normalized.startsWith('mcp__codegraph__')
    || normalized.includes('codegraph');
}

function recordLspCodegraphGuidance(toolName: string | undefined): LazyCodexCompatDecision | null {
  if (!isEditLikeTool(toolName) && !isCodegraphTool(toolName)) {
    return null;
  }

  return {
    behavior: 'lsp-codegraph-guidance',
    decision: 'advise',
    reason: isCodegraphTool(toolName)
      ? 'Codegraph guidance is staged behind available Claude/OMC MCP surfaces'
      : 'Run LSP diagnostics after edit-like tools when a language server is available',
  };
}

function processUserPrompt(input: ReturnType<typeof normalizeLazyCodexCompatHookInput>): {
  readonly decisions: readonly LazyCodexCompatDecision[];
  readonly sideEffects: readonly LazyCodexCompatSideEffect[];
  readonly messages: readonly string[];
} {
  const decisions: LazyCodexCompatDecision[] = [];
  const sideEffects: LazyCodexCompatSideEffect[] = [];
  const messages: string[] = [];
  const projectRules = loadProjectRules(input.cwd);
  decisions.push(projectRules.decision, hostPolicyDecision());
  if (projectRules.message) {
    messages.push(projectRules.message);
  }

  const prompt = input.prompt ?? '';
  const detected = detectKeywordsWithType(prompt);
  const hasUltrawork = detected.some((keyword) => keyword.type === 'ultrawork');
  if (hasUltrawork) {
    try {
      sideEffects.push(recordUlwSteering(input.cwd, input.sessionId, prompt));
      decisions.push({
        behavior: 'ulw-steering',
        decision: 'recorded',
        artifactCount: 1,
      });
    } catch (error) {
      if (!(error instanceof LazyCodexSinkSafetyError)) {
        throw error;
      }
      decisions.push({
        behavior: 'ulw-steering',
        decision: 'refused',
        reason: error.message,
      });
    }
    decisions.push({
      behavior: 'ultrawork-trigger',
      decision: 'activate',
      reason: 'Claude prompt contained LazyCodex ultrawork keyword',
    });
    messages.unshift(LAZYCODEX_ULTRAWORK_COMPAT_DIRECTIVE);
  } else {
    decisions.push({
      behavior: 'ultrawork-trigger',
      decision: 'idle',
    });
  }

  return { decisions, sideEffects, messages };
}

function processPostTool(input: ReturnType<typeof normalizeLazyCodexCompatHookInput>): {
  readonly decisions: readonly LazyCodexCompatDecision[];
  readonly messages: readonly string[];
} {
  const decisions: LazyCodexCompatDecision[] = [];
  const messages: string[] = [];
  const toolInput = ToolInputRecordSchema.safeParse(input.toolInput).data ?? {};

  const commentMessage = createCommentCheckerHook().postToolUse({
    tool_name: input.toolName ?? '',
    session_id: input.sessionId,
    tool_input: toolInput,
    tool_response: typeof input.toolOutput === 'string' ? input.toolOutput : undefined,
  });
  if (commentMessage) {
    decisions.push({
      behavior: 'comment-checking',
      decision: 'needs-action',
    });
    messages.push(commentMessage);
  } else {
    decisions.push({
      behavior: 'comment-checking',
      decision: 'clear',
    });
  }

  const guidance = recordLspCodegraphGuidance(input.toolName);
  if (guidance) {
    decisions.push(guidance);
    messages.push(`LazyCodex compatibility guidance: ${guidance.reason}.`);
  }

  return { decisions, messages };
}

function processSubagentStop(input: ReturnType<typeof normalizeLazyCodexCompatHookInput>): {
  readonly decisions: readonly LazyCodexCompatDecision[];
  readonly sideEffects: readonly LazyCodexCompatSideEffect[];
  readonly messages: readonly string[];
} {
  const continuation = checkStartWorkContinuation(input.cwd, input.sessionId);
  const shouldVerifyEvidence = input.agentType === 'lazycodex-executor'
    || input.output?.includes('"DoneClaim"') === true;
  const evidence = shouldVerifyEvidence
    ? verifyExecutorEvidence(input.cwd, input.output, { sessionId: input.sessionId })
    : {
        decision: {
          behavior: 'executor-evidence',
          decision: 'idle',
        } satisfies LazyCodexCompatDecision,
        sideEffects: [],
      };
  return {
    decisions: [continuation.decision, evidence.decision],
    sideEffects: evidence.sideEffects,
    messages: [continuation.message, evidence.message].filter((message): message is string => Boolean(message)),
  };
}

export async function processLazyCodexCompatHook(
  rawInput: unknown,
  fallbackEventName?: LazyCodexCompatEventName,
): Promise<LazyCodexCompatHookResult> {
  const normalized = normalizeLazyCodexCompatHookInput(rawInput, fallbackEventName);
  const decisions: LazyCodexCompatDecision[] = [];
  const sideEffects: LazyCodexCompatSideEffect[] = [];
  const messages: string[] = [];

  switch (normalized.eventName) {
    case 'UserPromptSubmit': {
      const result = processUserPrompt(normalized);
      decisions.push(...result.decisions);
      sideEffects.push(...result.sideEffects);
      messages.push(...result.messages);
      break;
    }
    case 'PostToolUse': {
      const result = processPostTool(normalized);
      decisions.push(...result.decisions);
      messages.push(...result.messages);
      break;
    }
    case 'PreCompact':
      try {
        sideEffects.push(...recordCompactReset(normalized.cwd, normalized.sessionId));
      } catch (error) {
        if (!(error instanceof LazyCodexSinkSafetyError)) {
          throw error;
        }
        decisions.push({
          behavior: 'cache-reset',
          decision: 'refused',
          reason: error.message,
        });
      }
      break;
    case 'Stop': {
      const continuation = checkStartWorkContinuation(normalized.cwd, normalized.sessionId);
      decisions.push(continuation.decision);
      if (continuation.message) {
        messages.push(continuation.message);
      }
      break;
    }
    case 'SubagentStop': {
      const result = processSubagentStop(normalized);
      decisions.push(...result.decisions);
      sideEffects.push(...result.sideEffects);
      messages.push(...result.messages);
      break;
    }
  }

  return {
    continue: true,
    message: joinMessages(messages),
    lazycodexCompat: {
      normalized,
      decisions,
      sideEffects,
    },
  };
}

export type {
  LazyCodexCompatDecision,
  LazyCodexCompatEventName,
  LazyCodexCompatHookResult,
  LazyCodexCompatMetadata,
  LazyCodexCompatNormalizedEvent,
  LazyCodexCompatPortableEventId,
  LazyCodexCompatSideEffect,
} from './types.js';
