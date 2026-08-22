/**
 * Alias Resolver — issue #3706
 *
 * Maps legacy workflow / skill / command aliases to the four Tier-0
 * canonical workflows (`plan`, `execute`, `review`, `verify`) or the
 * maintainer-only `omc release` authority. Provides:
 *  - one concise actionable warning per alias per session (default)
 *  - diagnostics mapping/telemetry retention
 *  - temporary automation opt-out
 *  - usage receipts (machine-readable)
 *  - resolver flag rollback (`OMC_ALIAS_RESOLVER_ENABLED`)
 *
 * Design contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md
 * Plan head: 0a91273e61dbbd47eb0af4c02844409251e08398
 * Epic: #3698, child: #3706
 *
 * This module is intentionally additive and dependency-light. When the
 * prerequisite registry (#3703) lands, this resolver adapts to that
 * registry via a narrow adapter seam (see `resolveWorkflowAliasViaRegistry`
 * hook). The resolver flag gates all behavior so a rollout issue can fall
 * back to legacy mapping without a code revert.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getOmcRoot, resolveToWorktreeRoot } from '../lib/worktree-paths.js';


// ---------------------------------------------------------------------------
// Tier-0 contract
// ---------------------------------------------------------------------------

export const TIER0_WORKFLOWS = ['plan', 'deep-interview', 'ralplan', 'execute', 'review', 'verify'] as const;
export type Tier0Workflow = (typeof TIER0_WORKFLOWS)[number];

/**
 * Non-Tier-0 alias targets. `research` is an internal lane (registry.ts marks
 * it internalOnly); `omc-release` is the maintainer-only release authority;
 * `project-session-manager` is a kept utility that the short `psm` name points
 * at. None of these join TIER0_WORKFLOWS.
 */
export type AliasTarget =
  | Tier0Workflow
  | 'omc-release'
  | 'research'
  | 'project-session-manager';

export interface AliasEntry {
  alias: string;
  canonical: AliasTarget;
  tier0?: Tier0Workflow; // undefined when canonical is omc-release or research
  owner: string;
  description: string;
  removalMilestone: string; // e.g. "≥2 minor releases + 90 days, ≥95% canonical share"
  isWorkflowAlias: boolean;
}

export interface AliasMappingDiagnostics {
  alias: string;
  canonical: AliasTarget;
  tier0: Tier0Workflow | null;
  warning: string;
  owner: string;
  removalMilestone: string;
}

// Tier-0 workflows are themselves canonical; they appear as keys with isAlias=false
const CANONICAL_SET = new Set<string>(TIER0_WORKFLOWS);

/**
 * 5.0.0 retired the legacy workflow aliases outright under the major-version
 * carve-out (see alias-retirement/policy.ts). Removed entirely rather than
 * aliased: ultrawork, ultraqa, ultrapilot, swarm, pipeline,
 * merge-readiness, deep-dive, sciomc, ccg, omc-teams, mcp-setup, learner,
 * writer-memory, local-build-reminder, setup, omc-reference.
 *
 * Entries that remain are genuine aliases only. Skills the registry marks
 * `decision: 'keep'` (team, autopilot, autoresearch, ai-slop-cleaner,
 * visual-verdict, self-improve) are deliberately absent — listing a kept skill
 * here would rewrite a direct invocation into something else.
 */
export const ALIAS_REGISTRY: readonly AliasEntry[] = [
  // ---- Canonical self-entries (isAlias=false at resolve time) ----
  { alias: 'verify', canonical: 'verify', tier0: 'verify', owner: 'workflow-registry', description: 'verify (Tier-0 canonical)', removalMilestone: 'canonical', isWorkflowAlias: true },

  // ---- Utility compatibility alias ----
  { alias: 'psm', canonical: 'project-session-manager', owner: 'workflow-registry', description: 'psm → project-session-manager', removalMilestone: 'short-name convenience alias; retained by owner direction', isWorkflowAlias: false },

  // ---- Maintainer-only release ----
  { alias: 'release', canonical: 'omc-release', owner: 'maintainers', description: 'release → maintainer-only omc release', removalMilestone: 'compatibility alias during migration; never auto-removed without owner approval', isWorkflowAlias: true },
] as const;

const aliasLookup = new Map<string, AliasEntry>();
for (const e of ALIAS_REGISTRY) {
  aliasLookup.set(e.alias.toLowerCase(), e);
}

// ---------------------------------------------------------------------------
// Resolver flag (rollback)
// ---------------------------------------------------------------------------

export function isResolverEnabled(): boolean {
  const env = process.env.OMC_ALIAS_RESOLVER_ENABLED;
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false;
    if (v === '1' || v === 'true' || v === 'on' || v === 'enabled') return true;
  }
  // Also respect generic disable env
  if (process.env.OMC_DISABLE_ALIAS_RESOLVER === '1') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Warning opt-out (temporary automation opt-out)
// ---------------------------------------------------------------------------

export function isWarningOptedOut(): boolean {
  const env = process.env.OMC_ALIAS_WARNINGS ?? process.env.OMC_ALIAS_WARNING_OPT_OUT ?? process.env.OMC_ALIAS_NO_WARNING;
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    const hasWarningsKey = process.env.OMC_ALIAS_WARNINGS !== undefined;
    if (['0', 'false', 'off', '1', 'true', 'disabled', 'enabled', 'on', 'no', 'yes'].includes(v)) {
      if (hasWarningsKey) {
        if (['0', 'false', 'off', 'disabled', 'no'].includes(v)) return true;
        return false;
      }
      return ['1', 'true', 'on', 'enabled', 'yes'].includes(v);
    }
  }
  if (process.env.OMC_ALIAS_WARNINGS_DISABLED === '1') return true;
  // Automation noise: when OMC_QUIET is set, suppress alias warnings as well (bounded)
  const quiet = process.env.OMC_QUIET;
  if (quiet !== undefined) {
    const q = Number.parseInt(quiet, 10);
    if (!Number.isNaN(q) && q >= 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeWorkflowInput(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  // strip leading slash/command prefixes
  s = s.replace(/^\/(?:oh-my-claudecode:|omc:)?/i, '');
  s = s.replace(/^omc:/i, '');
  s = s.replace(/^oh-my-claudecode:/i, '');
  // strip trailing punctuation that sometimes follows a bare alias token
  s = s.replace(/[?!.,;:]+$/g, '');
  s = s.trim();
  return s;
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

export interface AliasResolution {
  input: string;
  normalized: string;
  canonical: AliasTarget;
  tier0: Tier0Workflow | null;
  isAlias: boolean;
  isCanonical: boolean;
  isRelease: boolean;
  warning: string | null;
  mapping: { alias: string; canonical: AliasTarget } | null;
  enabled: boolean;
}

export function formatAliasWarning(alias: string, canonical: AliasTarget): string {
  if (canonical === 'omc-release') {
    return `Alias "${alias}" is deprecated → use "omc release" (maintainer-only). Run "omc release --help" for the canonical path.`;
  }
  return `Alias "${alias}" is deprecated → use "${canonical}" (Tier-0). Run "/${canonical} ..." next time.`;
}

export function resolveWorkflowAlias(rawInput: string): AliasResolution {
  const normalized = normalizeWorkflowInput(rawInput);
  const enabled = isResolverEnabled();

  // Fast path: resolver disabled → legacy behavior (no alias routing)
  if (!enabled) {
    const canon = (CANONICAL_SET.has(normalized) ? normalized : normalized) as AliasTarget;
    const tier0 = (TIER0_WORKFLOWS as readonly string[]).includes(normalized) ? (normalized as Tier0Workflow) : null;
    return {
      input: rawInput,
      normalized,
      canonical: canon,
      tier0,
      isAlias: false,
      isCanonical: CANONICAL_SET.has(normalized),
      isRelease: false,
      warning: null,
      mapping: null,
      enabled: false,
    };
  }

  if (!normalized) {
    return {
      input: rawInput,
      normalized,
      canonical: '' as AliasTarget,
      tier0: null,
      isAlias: false,
      isCanonical: false,
      isRelease: false,
      warning: null,
      mapping: null,
      enabled: true,
    };
  }

  const entry = aliasLookup.get(normalized);
  if (entry) {
    const _isAlias = entry.canonical !== entry.alias.toLowerCase() || !CANONICAL_SET.has(normalized);
    // canonical entries that are themselves Tier-0 (e.g. verify) are not aliases even if present in registry
    const trulyAlias = entry.alias.toLowerCase() !== entry.canonical.toLowerCase() || !CANONICAL_SET.has(normalized);
    // For 'verify' canonical entry we still treat as non-alias (isAlias false) to avoid warning on canonical use
    if (entry.alias.toLowerCase() === entry.canonical.toLowerCase() && CANONICAL_SET.has(normalized)) {
      return {
        input: rawInput,
        normalized,
        canonical: entry.canonical,
        tier0: (entry.tier0 ?? null) as Tier0Workflow | null,
        isAlias: false,
        isCanonical: true,
        isRelease: entry.canonical === 'omc-release',
        warning: null,
        mapping: null,
        enabled: true,
      };
    }
    const warn = trulyAlias ? formatAliasWarning(entry.alias, entry.canonical) : null;
    return {
      input: rawInput,
      normalized,
      canonical: entry.canonical,
      tier0: (entry.tier0 ?? null) as Tier0Workflow | null,
      isAlias: trulyAlias,
      isCanonical: !trulyAlias,
      isRelease: entry.canonical === 'omc-release',
      warning: warn,
      mapping: { alias: entry.alias, canonical: entry.canonical },
      enabled: true,
    };
  }

  // Not in alias registry: if it's a Tier-0 canonical, no alias
  if (CANONICAL_SET.has(normalized)) {
    return {
      input: rawInput,
      normalized,
      canonical: normalized as Tier0Workflow,
      tier0: normalized as Tier0Workflow,
      isAlias: false,
      isCanonical: true,
      isRelease: false,
      warning: null,
      mapping: null,
      enabled: true,
    };
  }

  // Unknown token: pass-through (no warning)
  return {
    input: rawInput,
    normalized,
    canonical: normalized as AliasTarget,
    tier0: null,
    isAlias: false,
    isCanonical: false,
    isRelease: false,
    warning: null,
    mapping: null,
    enabled: true,
  };
}

// Adapter seam for future registry (#3703): callers can inject a lookup function
export type AliasRegistryLookup = (normalized: string) => AliasEntry | undefined;
export function resolveWorkflowAliasViaRegistry(rawInput: string, lookup: AliasRegistryLookup): AliasResolution {
  const normalized = normalizeWorkflowInput(rawInput);
  const enabled = isResolverEnabled();
  if (!enabled) {
    const tier0 = (TIER0_WORKFLOWS as readonly string[]).includes(normalized) ? (normalized as Tier0Workflow) : null;
    return {
      input: rawInput,
      normalized,
      canonical: normalized as AliasTarget,
      tier0,
      isAlias: false,
      isCanonical: CANONICAL_SET.has(normalized),
      isRelease: false,
      warning: null,
      mapping: null,
      enabled: false,
    };
  }
  const entry = lookup(normalized);
  if (entry) {
    const isAlias = entry.alias.toLowerCase() !== entry.canonical.toLowerCase() || !CANONICAL_SET.has(normalized);
    if (entry.alias.toLowerCase() === entry.canonical.toLowerCase() && CANONICAL_SET.has(normalized)) {
      return {
        input: rawInput,
        normalized,
        canonical: entry.canonical,
        tier0: (entry.tier0 ?? null) as Tier0Workflow | null,
        isAlias: false,
        isCanonical: true,
        isRelease: entry.canonical === 'omc-release',
        warning: null,
        mapping: null,
        enabled: true,
      };
    }
    return {
      input: rawInput,
      normalized,
      canonical: entry.canonical,
      tier0: (entry.tier0 ?? null) as Tier0Workflow | null,
      isAlias: isAlias,
      isCanonical: !isAlias,
      isRelease: entry.canonical === 'omc-release',
      warning: isAlias ? formatAliasWarning(entry.alias, entry.canonical) : null,
      mapping: { alias: entry.alias, canonical: entry.canonical },
      enabled: true,
    };
  }
  if (CANONICAL_SET.has(normalized)) {
    return {
      input: rawInput,
      normalized,
      canonical: normalized as Tier0Workflow,
      tier0: normalized as Tier0Workflow,
      isAlias: false,
      isCanonical: true,
      isRelease: false,
      warning: null,
      mapping: null,
      enabled: true,
    };
  }
  return {
    input: rawInput,
    normalized,
    canonical: normalized as AliasTarget,
    tier0: null,
    isAlias: false,
    isCanonical: false,
    isRelease: false,
    warning: null,
    mapping: null,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function getAliasMapping(): AliasMappingDiagnostics[] {
  return ALIAS_REGISTRY
    .filter((e) => e.alias.toLowerCase() !== e.canonical.toLowerCase() || !CANONICAL_SET.has(e.alias.toLowerCase()))
    .map((e) => ({
      alias: e.alias,
      canonical: e.canonical,
      tier0: e.tier0 ?? null,
      warning: formatAliasWarning(e.alias, e.canonical),
      owner: e.owner,
      removalMilestone: e.removalMilestone,
    }));
}

export function getDiagnostics(): {
  tier0: readonly Tier0Workflow[];
  aliases: AliasMappingDiagnostics[];
  resolverEnabled: boolean;
  warningOptOut: boolean;
  planHead: string;
} {
  return {
    tier0: TIER0_WORKFLOWS,
    aliases: getAliasMapping(),
    resolverEnabled: isResolverEnabled(),
    warningOptOut: isWarningOptedOut(),
    planHead: '0a91273e61dbbd47eb0af4c02844409251e08398',
  };
}

// ---------------------------------------------------------------------------
// Warning dedupe — one concise warning per alias per session
// ---------------------------------------------------------------------------

function aliasWarningsPath(sessionId?: string, worktreeRoot?: string): string {
  const root = getOmcRoot(worktreeRoot ?? resolveToWorktreeRoot());
  if (sessionId) {
    // Validate sessionId loosely — reuse existing validation if available
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(root, 'state', 'sessions', safe, 'alias-warnings.json');
  }
  return join(root, 'state', 'alias-warnings.json');
}

type WarningsState = Record<string, string>; // alias(normalized) -> iso timestamp warned

function readWarnings(sessionId?: string, worktreeRoot?: string): WarningsState {
  const p = aliasWarningsPath(sessionId, worktreeRoot);
  try {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as WarningsState;
    return {};
  } catch {
    return {};
  }
}

function writeWarnings(state: WarningsState, sessionId?: string, worktreeRoot?: string): void {
  const p = aliasWarningsPath(sessionId, worktreeRoot);
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function shouldEmitWarning(alias: string, sessionId?: string, worktreeRoot?: string): boolean {
  if (isWarningOptedOut()) return false;
  const normalized = normalizeWorkflowInput(alias);
  if (!normalized) return false;
  const state = readWarnings(sessionId, worktreeRoot);
  return !(normalized in state);
}

export function markWarningEmitted(alias: string, sessionId?: string, worktreeRoot?: string): void {
  const normalized = normalizeWorkflowInput(alias);
  if (!normalized) return;
  const state = readWarnings(sessionId, worktreeRoot);
  if (normalized in state) return;
  state[normalized] = new Date().toISOString();
  writeWarnings(state, sessionId, worktreeRoot);
}

// Returns warning string if it should be emitted (and marks it), else null
export function maybeGetAliasWarning(resolution: AliasResolution, sessionId?: string, worktreeRoot?: string): string | null {
  if (!resolution.isAlias || !resolution.warning) return null;
  if (isWarningOptedOut()) return null;
  if (!isResolverEnabled()) return null;
  if (!shouldEmitWarning(resolution.normalized, sessionId, worktreeRoot)) return null;
  markWarningEmitted(resolution.normalized, sessionId, worktreeRoot);
  // Also record telemetry/receipt even when warning is suppressed later — this call records the warning event
  return resolution.warning;
}

// ---------------------------------------------------------------------------
// Telemetry & receipts
// ---------------------------------------------------------------------------

export interface AliasTelemetryEvent {
  alias: string;
  normalized: string;
  canonical: AliasTarget;
  tier0: Tier0Workflow | null;
  timestamp: string;
  sessionId?: string;
  warned: boolean;
  release: boolean;
}

function telemetryPath(worktreeRoot?: string): string {
  const root = getOmcRoot(worktreeRoot ?? resolveToWorktreeRoot());
  return join(root, 'state', 'alias-telemetry.jsonl');
}

function receiptsPath(worktreeRoot?: string): string {
  const root = getOmcRoot(worktreeRoot ?? resolveToWorktreeRoot());
  return join(root, 'state', 'alias-receipts.json');
}

export interface AliasReceipts {
  version: 1;
  planHead: string;
  generatedAt: string;
  totals: { aliasUses: number; canonicalUses: number };
  byAlias: Record<string, { count: number; canonical: AliasTarget; lastSeen: string }>;
  byCanonical: Record<string, number>;
  releaseUses: number;
}

function readReceipts(worktreeRoot?: string): AliasReceipts {
  const p = receiptsPath(worktreeRoot);
  try {
    if (!existsSync(p)) {
      return { version: 1, planHead: '0a91273e61dbbd47eb0af4c02844409251e08398', generatedAt: new Date().toISOString(), totals: { aliasUses: 0, canonicalUses: 0 }, byAlias: {}, byCanonical: {}, releaseUses: 0 };
    }
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as AliasReceipts;
    return { version: 1, planHead: '0a91273e61dbbd47eb0af4c02844409251e08398', generatedAt: new Date().toISOString(), totals: { aliasUses: 0, canonicalUses: 0 }, byAlias: {}, byCanonical: {}, releaseUses: 0 };
  } catch {
    return { version: 1, planHead: '0a91273e61dbbd47eb0af4c02844409251e08398', generatedAt: new Date().toISOString(), totals: { aliasUses: 0, canonicalUses: 0 }, byAlias: {}, byCanonical: {}, releaseUses: 0 };
  }
}

function writeReceipts(receipts: AliasReceipts, worktreeRoot?: string): void {
  const p = receiptsPath(worktreeRoot);
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    receipts.generatedAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify(receipts, null, 2));
  } catch {
    // best-effort
  }
}

export function recordAliasTelemetry(event: Omit<AliasTelemetryEvent, 'timestamp'> & { timestamp?: string }, worktreeRoot?: string): void {
  const ts = event.timestamp ?? new Date().toISOString();
  const full: AliasTelemetryEvent = { ...event, timestamp: ts };
  // Append telemetry jsonl (diagnostics retain full mapping)
  try {
    const p = telemetryPath(worktreeRoot);
    mkdirSync(join(p, '..'), { recursive: true });
    appendFileSync(p, JSON.stringify(full) + '\n');
  } catch {
    // best-effort
  }
  // Update receipts
  try {
    const receipts = readReceipts(worktreeRoot);
    if (full.canonical !== full.normalized || aliasLookup.has(full.normalized)) {
      // Determine if this use was via alias (resolution.isAlias) — here we infer from aliasLookup
      const entry = aliasLookup.get(full.normalized);
      const isAliasUse = !!entry && entry.alias.toLowerCase() !== entry.canonical.toLowerCase();
      if (isAliasUse) {
        receipts.totals.aliasUses += 1;
        const key = full.normalized;
        const prev = receipts.byAlias[key];
        receipts.byAlias[key] = { count: (prev?.count ?? 0) + 1, canonical: full.canonical, lastSeen: ts };
        receipts.byCanonical[full.canonical] = (receipts.byCanonical[full.canonical] ?? 0) + 1;
        if (full.release) receipts.releaseUses += 1;
      } else {
        // Canonical use
        receipts.totals.canonicalUses += 1;
        receipts.byCanonical[full.canonical] = (receipts.byCanonical[full.canonical] ?? 0) + 1;
      }
    } else {
      // Unknown token — still count as canonical-ish
      receipts.totals.canonicalUses += 1;
    }
    writeReceipts(receipts, worktreeRoot);
  } catch {
    // best-effort
  }
}

export function readTelemetryTail(limit = 100, worktreeRoot?: string): AliasTelemetryEvent[] {
  const p = telemetryPath(worktreeRoot);
  try {
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    return tail.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as AliasTelemetryEvent[];
  } catch {
    return [];
  }
}

export function readUsageReceipts(worktreeRoot?: string): AliasReceipts {
  return readReceipts(worktreeRoot);
}

export function clearAliasTelemetryForTests(worktreeRoot?: string): void {
  try {
    const tp = telemetryPath(worktreeRoot);
    if (existsSync(tp)) writeFileSync(tp, '');
  } catch {
    // ignore
  }
  try {
    const rp = receiptsPath(worktreeRoot);
    if (existsSync(rp)) writeFileSync(rp, JSON.stringify({ version: 1, planHead: '0a91273e61dbbd47eb0af4c02844409251e08398', generatedAt: new Date().toISOString(), totals: { aliasUses: 0, canonicalUses: 0 }, byAlias: {}, byCanonical: {}, releaseUses: 0 }, null, 2));
  } catch {
    // ignore
  }
}

export function clearAliasWarningsForTests(sessionId?: string, worktreeRoot?: string): void {
  const p = aliasWarningsPath(sessionId, worktreeRoot);
  try {
    if (existsSync(p)) writeFileSync(p, JSON.stringify({}, null, 2));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Hook integration helper (narrow seam for bridge/keyword-detector)
// ---------------------------------------------------------------------------

export function resolveWorkflowInputWithWarning(rawInput: string, sessionId?: string, worktreeRoot?: string): AliasResolution & { warningToEmit: string | null } {
  const res = resolveWorkflowAlias(rawInput);
  let warningToEmit: string | null = null;
  if (res.isAlias && res.warning) {
    warningToEmit = maybeGetAliasWarning(res, sessionId, worktreeRoot);
    // Record telemetry regardless of whether warning was emitted (suppressed warnings still counted)
    recordAliasTelemetry({
      alias: res.input,
      normalized: res.normalized,
      canonical: res.canonical,
      tier0: res.tier0,
      sessionId,
      warned: warningToEmit !== null,
      release: res.isRelease,
    }, worktreeRoot);
  } else {
    // Record canonical usage for receipts (helps retirement 95% calc)
    if (res.isCanonical && res.canonical) {
      recordAliasTelemetry({
        alias: res.input,
        normalized: res.normalized,
        canonical: res.canonical,
        tier0: res.tier0,
        sessionId,
        warned: false,
        release: false,
      }, worktreeRoot);
    }
  }
  return { ...res, warningToEmit };
}
