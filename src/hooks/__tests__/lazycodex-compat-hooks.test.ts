import { afterEach, describe, it } from 'vitest';
import {
  malformedCliInputIsStructured,
  malformedHookFieldsNeedEvidence,
  packagedWrapperUsesCompiledAdapter,
  postToolCommentsAreData,
  preCompactRejectsSymlinkedCacheResetSink,
  preCompactRecordsReset,
  registryCommandsAreRunnable,
  subagentRejectsSymlinkedExecutorLedgerSink,
  subagentVerifiesExecutorEvidence,
  userPromptActivatesUltrawork,
  userPromptRejectsSymlinkedSteeringSink,
} from './lazycodex-compat-core-scenarios.js';
import {
  stopContinuesCurrentSession,
  stopContinuesCurrentSessionWithRelativePlan,
  stopHandlesCorruptBoulder,
  stopHandlesMissingActivePlan,
  stopSkipsBareLegacyOwnership,
  stopSkipsForeignSession,
  stopSkipsMissingSessionIds,
  stopSkipsNonCodexPrefixedOwnership,
} from './lazycodex-compat-stop-scenarios.js';
import { cleanupTempProjects } from './lazycodex-compat-test-helpers.js';

afterEach(() => {
  cleanupTempProjects();
});

describe('LazyCodex compatibility hook adapter', () => {
  it('normalizes UserPromptSubmit and activates LazyCodex-compatible ultrawork steering when the prompt requests ulw', userPromptActivatesUltrawork);
  it('refuses symlinked ultrawork steering sinks without touching the target', userPromptRejectsSymlinkedSteeringSink);
  it('normalizes PostToolUse, treats comments as data, and emits LSP guidance for edit-like tools', postToolCommentsAreData);
  it('maps Claude PreCompact to LazyCodex compact-before and records cache reset side effects', preCompactRecordsReset);
  it('refuses symlinked cache reset sinks without touching the target', preCompactRejectsSymlinkedCacheResetSink);
  it('normalizes Stop and emits start-work continuation from LazyCodex Boulder state', stopContinuesCurrentSession);
  it('continues Stop only for the current Boulder session and resolves relative active plan paths', stopContinuesCurrentSessionWithRelativePlan);
  it('does not continue Stop when Boulder work has no session_ids', stopSkipsMissingSessionIds);
  it('does not continue Stop for a foreign Boulder session', stopSkipsForeignSession);
  it('does not continue Stop for non-Codex prefixed Boulder ownership', stopSkipsNonCodexPrefixedOwnership);
  it('does not continue Stop for bare legacy Boulder ownership', stopSkipsBareLegacyOwnership);
  it('returns a safe start-work evidence decision when Boulder JSON is corrupt', stopHandlesCorruptBoulder);
  it('returns a safe start-work evidence decision when active plan path is missing', stopHandlesMissingActivePlan);
  it('normalizes SubagentStop and verifies lazycodex executor evidence without Codex payload assumptions', subagentVerifiesExecutorEvidence);
  it('refuses symlinked executor verification ledger sinks without touching the target', subagentRejectsSymlinkedExecutorLedgerSink);
  it('treats malformed or missing Claude hook fields as data and asks for continuation instead of throwing', malformedHookFieldsNeedEvidence);
  it('returns structured lazycodexCompat decisions for malformed CLI-boundary JSON', malformedCliInputIsStructured);
  it('wires the adapter through source-owned runnable OMC hook registry commands', registryCommandsAreRunnable);
  it('runs the compiled LazyCodex adapter from a packaged root without source files', packagedWrapperUsesCompiledAdapter);
});
