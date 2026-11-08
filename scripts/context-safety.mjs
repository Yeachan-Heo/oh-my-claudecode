#!/usr/bin/env node

/**
 * OMC Context Safety Hook (PreToolUse) - compatibility no-op
 *
 * TeamCreate was removed from this guard in #1006 because blocking lightweight
 * orchestration setup caused silent fallback behavior. ExitPlanMode was removed
 * in #1597 because blocking a lightweight plan-mode exit traps long-running
 * planning skills such as /deep-interview in irreversible approval loops once
 * context crosses the warning threshold.
 *
 * The script remains as a permissive compatibility shim so older patched hook
 * installations that still point at scripts/context-safety.mjs do not fail.
 */

import { readStdin } from './lib/stdin.mjs';

async function main() {
  try {
    await readStdin();
  } catch {
    // Ignore malformed input - this hook is intentionally permissive.
  }

}

main();
