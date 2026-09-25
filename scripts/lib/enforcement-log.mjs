/**
 * Shadow-enforcement log for OMC hooks (E0).
 *
 * Every enforcement-style hook judgment (pass / warn / block / degraded)
 * is appended here as one JSON line. This is the evidence base for the
 * shadow-then-promote protocol: a rule runs in shadow until this log
 * shows enough samples and zero false blocks. Never read for behavior —
 * only for promotion evidence and audits.
 *
 * Line shape (mirrors the jev shadow log conventions):
 *   { ts, rule, mode, outcome, detail, latencyMs }
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Append one enforcement judgment to the session-agnostic shadow log.
 * Append failures are swallowed by design: a broken evidence log must
 * never break the hook that is being observed.
 *
 * @param {object} options
 * @param {string} options.stateRoot - Absolute path to the .omc root
 * @param {string} options.rule - Rule identifier (e.g. 'budget-stop')
 * @param {string|null} options.mode - Active unattended mode, when one triggered the check
 * @param {'pass'|'warn'|'block'|'degraded'} options.outcome
 * @param {string} [options.detail] - One-line human-readable detail
 * @param {number} [options.latencyMs] - Hook evaluation latency
 */
export function logEnforcement({ stateRoot, rule, mode, outcome, detail = '', latencyMs }) {
  try {
    const dir = join(stateRoot, 'state', 'enforcement');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      rule,
      mode,
      outcome,
      detail,
      latencyMs,
    });
    appendFileSync(join(dir, 'shadow.jsonl'), `${line}\n`, 'utf8');
  } catch {
    // evidence logging is best-effort by contract
  }
}
