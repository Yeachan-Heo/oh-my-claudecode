// Shared loader of the text cleaning module (scripts/lib/context-text-sanitize.mjs) for the hook scripts.
//
// The module is imported only when OMC_CONTEXT_TEXT_SANITIZE is 1 or true, so with the variable unset no hook loads it.
// A failed import yields null (fail-open): the hook then writes its text unchanged, as it did before the switch existed.
export async function loadContextText() {
  if (!['1', 'true'].includes(String(process.env.OMC_CONTEXT_TEXT_SANITIZE ?? '').trim().toLowerCase())) return null;
  try {
    return await import('./context-text-sanitize.mjs');
  } catch {
    return null;
  }
}
