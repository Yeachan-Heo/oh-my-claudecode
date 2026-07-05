import { normalizeLazyCodexCompatHookInput } from './normalize.js';
import type {
  LazyCodexCompatEventName,
  LazyCodexCompatHookResult,
} from './types.js';

export function createMalformedInputResult(
  fallbackEventName: LazyCodexCompatEventName | undefined,
  reason: string,
): LazyCodexCompatHookResult {
  const normalized = normalizeLazyCodexCompatHookInput({}, fallbackEventName);
  return {
    continue: true,
    message: `LazyCodex compatibility adapter received malformed input: ${reason}`,
    lazycodexCompat: {
      normalized,
      decisions: [
        {
          behavior: 'malformed-input',
          decision: 'needs-evidence',
          reason,
        },
      ],
      sideEffects: [],
    },
  };
}
