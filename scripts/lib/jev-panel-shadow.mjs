// Adapter between the panel and the Jev script helpers of this tree (scripts/lib/jev-shadow.mjs). The panel was written against a
// patched plugin whose helpers had slightly different signatures; this module gives it the same names on top of the upstream ones.
import { jevModeFor, jevNoulOf, recordJevApplied as recordApplied, recordJevShadow, setJevHookContext } from './jev-shadow.mjs';

export { jevModeFor, jevNoulOf, recordJevShadow, setJevHookContext };

// Active answer to one named question (by name when the answers map exists, never by position).
export function jevAnswerOf(result, questionName) {
  if (!result || result.mode !== 'active') return undefined;
  if (result.answers && typeof result.answers === 'object') return result.answers[questionName] ?? undefined;
  return result.answer ?? undefined;
}

// The panel passes the result it acted on first; applied.jsonl is written only with OMC_JEV_APPLIED_LOG=1 (as for every Jev hook), with the
// request_id of this process's last request for the point (OMC_JEV_LOG_CONTEXT=1).
export function recordJevApplied(_result, point, applied) {
  recordApplied(point, applied);
}

// The upstream resolver applies the shared breaker itself (OMC_JEV_BREAKER); the panel had a breaker of its own in the patched plugin, not ported.
export async function panelBreakerOpen() { return false; }
