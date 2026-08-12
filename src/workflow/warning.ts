/**
 * Concise alias warning — visible once per session, diagnostics retain full mapping.
 * Bounded automation opt-out via env.
 */

import { formatAliasWarning, type AliasTarget } from './alias-resolver.js';
import { RETIREMENT_POLICY, REMOVAL_MILESTONE } from './registry.js';

export interface WarningRecord {
  alias: string;
  target: AliasTarget;
  message: string;
  timestamp: string;
}

const warned = new Set<string>();

function isWarningSuppressed(): boolean {
  const v = process.env.OMC_ALIAS_WARNINGS ?? process.env.OMC_SUPPRESS_ALIAS_WARNINGS ?? '';
  return v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'off';
}

export function shouldEmitAliasWarning(alias: string): boolean {
  if (isWarningSuppressed()) return false;
  const key = alias.toLowerCase();
  if (warned.has(key)) return false;
  warned.add(key);
  return true;
}

export function emitAliasWarning(alias: string, target: AliasTarget): string | null {
  if (!shouldEmitAliasWarning(alias)) return null;
  return formatAliasWarning(alias, target);
}

export function resetAliasWarnings(): void {
  warned.clear();
}

export function getAliasWarningDiagnostics(alias: string, target: AliasTarget): WarningRecord {
  return {
    alias,
    target,
    message: formatAliasWarning(alias, target),
    timestamp: new Date().toISOString(),
  };
}

export function getRetirementGate() {
  return { policy: { ...RETIREMENT_POLICY }, milestone: REMOVAL_MILESTONE };
}
