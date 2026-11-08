/**
 * Hook registry and dispatcher shadow mode — #3698 / #3707 + #3708 cutover.
 * Design doc: docs/design/ISSUE-3707-HOOK-REGISTRY-SHADOW.md
 */
export { HOOK_EVENTS, } from './types.js';
export { buildHookRegistry, validateRegistryAgainstHooksJson, selectApplicableEntries, parseEntrypointCommand, } from './registry.js';
export { createHookDispatcher, } from './dispatcher.js';
export { isHookShadowEnabled, getShadowRegistry, resetShadowRegistryCache, decisionDigest, compareShadowExecution, runShadowObservation, appendShadowRecord, readShadowLog, summarizeShadowLog, clearShadowLog, SHADOW_LOG_MAX_RECORDS, } from './shadow.js';
export { isDispatcherEnabled, isFamilyCutoverEnabled, shouldLoosenOrdinaryEnforcement, hookEventForType, recordDispatchTelemetry, readDispatchTelemetryTail, clearDispatchTelemetryForTests, telemetryPath, DISPATCH_TELEMETRY_MAX_RECORDS, DISPATCH_TELEMETRY_MAX_BYTES, } from './cutover.js';
//# sourceMappingURL=index.js.map