/**
 * Hook registry and dispatcher shadow mode — #3698 / #3707 + #3708 cutover.
 * Design doc: docs/design/ISSUE-3707-HOOK-REGISTRY-SHADOW.md
 */
export { HOOK_EVENTS, type HookEvent, type HookRegistryEntry, type HooksJson, type HooksJsonGroup, type HooksJsonCommand, type ShadowDecisionInput, type HookHandler, type DispatchStatus, type DispatchRecord, type DispatchResult, type ShadowVerdict, type ShadowComparisonRecord, } from './types.js';
export { buildHookRegistry, validateRegistryAgainstHooksJson, selectApplicableEntries, parseEntrypointCommand, type RegistryDriftIssue, } from './registry.js';
export { createHookDispatcher, type HookDispatcher, type DispatcherOptions, } from './dispatcher.js';
export { isHookShadowEnabled, getShadowRegistry, resetShadowRegistryCache, decisionDigest, compareShadowExecution, runShadowObservation, appendShadowRecord, readShadowLog, summarizeShadowLog, clearShadowLog, SHADOW_LOG_MAX_RECORDS, } from './shadow.js';
export { isDispatcherEnabled, isFamilyCutoverEnabled, shouldLoosenOrdinaryEnforcement, hookEventForType, recordDispatchTelemetry, readDispatchTelemetryTail, clearDispatchTelemetryForTests, telemetryPath, DISPATCH_TELEMETRY_MAX_RECORDS, DISPATCH_TELEMETRY_MAX_BYTES, type DispatchTelemetryRecord, } from './cutover.js';
//# sourceMappingURL=index.d.ts.map