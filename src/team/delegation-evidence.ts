import type { TeamTaskDelegationPlan } from './types.js';

const BROAD_TASK_VERBS_RE = /\b(?:investigate|analy[sz]e|debug|review|audit|refactor|cleanup|research|design|build|implement|improve)\b/i;
const BROAD_FIX_RE = /\bfix\b/i;
const BROAD_OBJECTS_RE = /\b(?:runtime|system|codebase|architecture|workflow|pipeline|tests?|failures?|flaky|behavior|semantics|flow|feature|bug)\b/i;
const FILE_REF_RE = /\b(?:[\w./-]+\/)?[\w.-]+\.[a-z0-9]{1,8}\b/i;
const SYMBOL_REF_RE = /`[^`]+`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/;

export const BROAD_TASK_DELEGATION_PLAN: TeamTaskDelegationPlan = {
  mode: 'auto',
  required_parallel_probe: true,
  skip_allowed_reason_required: true,
  child_report_format: 'bullets',
};

export function isBroadTeamTaskText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const wordCount = (normalized.match(/\b[\w-]+\b/g) ?? []).length;
  if (wordCount < 4) return false;

  const hasNarrowCodeTarget = FILE_REF_RE.test(normalized) || SYMBOL_REF_RE.test(normalized);
  if (hasNarrowCodeTarget && wordCount < 12) return false;

  if (BROAD_TASK_VERBS_RE.test(normalized)) return true;
  return BROAD_FIX_RE.test(normalized) && BROAD_OBJECTS_RE.test(normalized);
}

export function inferDelegationPlanForTeamTask(text: string): TeamTaskDelegationPlan | undefined {
  return isBroadTeamTaskText(text) ? { ...BROAD_TASK_DELEGATION_PLAN } : undefined;
}
