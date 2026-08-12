export { RETIREMENT_POLICY, parseVersion, countMinorReleasesSince, isMinorThresholdMet, daysBetween, isDaysThresholdMet, isTemporalThresholdMet, canonicalShare, isCanonicalShareMet, isConsecutiveCanonicalShareMet } from './policy.js';
export { ALIAS_RETIREMENT_SCHEMA_VERSION, ALIAS_REGISTRY, getAliasRecord, assertAliasRegistryIntegrity, type AliasRecord, type AliasKind } from './registry.js';
export { evaluateAlias, verifyAllAliases, summarizeReceipts, type RetirementVerdict, type UsageSample, type AliasEvaluationInput, type BulkEvaluationInput, type AliasRetirementReceipt } from './verifier.js';
export { buildClosureReport, summarizeClosureForEvidence, type GeneratedClosureEntry, type ClosureReport } from './closure.js';
