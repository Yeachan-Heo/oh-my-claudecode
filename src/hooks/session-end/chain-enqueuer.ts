/**
 * SessionEnd chain enqueuer (spec #9 tracker issue #17).
 *
 * The SessionEnd hook cannot see the session prompt, so chain membership
 * rides a ledger file (`.omc/state/factory/chain-<sessionId>.json`) written
 * by whoever spawned the session (listener / executeSpawnNext). At session
 * end we map the hook reason to a chain outcome, route through the T1 pure
 * seam, grade a declared gate if the ledger carries one, run the guardrails,
 * and enqueue the chain into the spawn-next action payload. Everything here
 * is cheap sync fs — the actual spawn stays in the detached worker.
 */

import * as fs from 'fs';
import { join } from 'path';
import { decideNextStage, gradeGate, normalizeRouteTable, type ChainOutcome, type GateFacts, type GateName, type RouteTable } from './routing.js';
import { acquireChainSlot, releaseChainSlot, INTENT_ID_PATTERN } from './guardrails.js';
import { validateChainFields, LABEL_PATTERN, type SpawnNextChain, type SpawnNextTracker } from './spawn-next.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';

export interface ChainLedger {
  intentId?: string;
  stage?: string;
  routeTable?: RouteTable;
  tracker?: SpawnNextTracker;
  gate?: GateName;
  gateFacts?: GateFacts;
  /** Per-stage link counts carried forward; guards against route-table self-loops. */
  visits?: Record<string, number>;
  /** Cap on visits to any one stage before the chain halts. Default 2. */
  maxStageVisits?: number;
}

/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' (no failure signal in the SessionEnd
 * payload), so it counts as a normal exit; 'clear' wipes the chain session's
 * context and halts the chain; unknown reasons stay failed.
 */
export function sessionEndOutcome(reason: string): ChainOutcome {
  return reason === 'prompt_input_exit' || reason === 'logout' || reason === 'other'
    ? 'success'
    : 'failed';
}

export function factoryStateDir(directory: string): string {
  return join(getOmcRoot(directory), 'state', 'factory');
}

export function readChainLedger(directory: string, sessionId: string): ChainLedger | null {
  try {
    validateSessionId(sessionId);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(factoryStateDir(directory), `chain-${sessionId}.json`), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ChainLedger;
  } catch {
    return null;
  }
}

/** Project-level route table: `.omc/factory-routes.json`. The single source of truth. */
export function readProjectRoutes(directory: string): RouteTable | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(getOmcRoot(directory), 'factory-routes.json'), 'utf8'));
    return normalizeRouteTable(parsed);
  } catch {
    return null;
  }
}

function recordDecision(directory: string, record: Record<string, unknown>): void {
  recordChainDecision(directory, record);
}

/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export function recordChainDecision(directory: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(factoryStateDir(directory), { recursive: true });
    fs.appendFileSync(
      join(factoryStateDir(directory), 'chain-decisions.jsonl'),
      `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`,
      'utf8',
    );
  } catch {
    // best-effort audit trail
  }
}

function writeHaltMarker(directory: string, intentId: string, reason: string): void {
  try {
    fs.mkdirSync(factoryStateDir(directory), { recursive: true });
    fs.writeFileSync(
      join(factoryStateDir(directory), `chain-${intentId}.stopped.json`),
      JSON.stringify({ intentId, reason, stoppedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    // best-effort halt marker
  }
}

const DEFAULT_GATE_FACTS: GateFacts = {
  irreversibleOrExternal: false,
  precedentSetting: false,
  valueJudgment: false,
  // Missing facts fail conservative: an undeclared gate grades human.
  mechanicalChecksPassed: false,
};

/**
 * Decide whether the ending session continues its chain. Returns the chain
 * payload to merge into the durable SessionEnd payload, or null (no ledger,
 * no route, human gate, guardrail, or invalid ledger — each recorded).
 */
export function planChainEnqueue(directory: string, sessionId: string, reason: string): SpawnNextChain | null {
  try {
    const ledger = readChainLedger(directory, sessionId);
    if (!ledger) return null;

    const outcome = sessionEndOutcome(reason);
    const intentId = typeof ledger.intentId === 'string' && ledger.intentId ? ledger.intentId : `chain-${sessionId}`;
    const record = (decision: string, extra: Record<string, unknown> = {}) =>
      recordDecision(directory, { decision, sessionId, outcome, reason, intentId, ...extra });

    // Ledger fields land in file names and spawned argv — validate before any
    // halt marker, lock, or handoff path is built from them.
    if (!INTENT_ID_PATTERN.test(intentId)) {
      record('invalid-ledger', { error: `invalid intentId: ${intentId}` });
      return null;
    }
    // Project file is authoritative. A ledger copy is a spawn-time snapshot kept
    // for the watchdog's stalled-link detection (watchdog.ts skips ledgers that
    // carry one), so it survives as a fallback — but never as an override, and
    // never unvalidated: a nested or stale copy used to halt the chain silently.
    const ledgerRoutes = ledger.routeTable === undefined ? null : normalizeRouteTable(ledger.routeTable);
    if (ledger.routeTable !== undefined && !ledgerRoutes) {
      record('malformed-route-table', { source: 'ledger', keys: Object.keys(ledger.routeTable as object).slice(0, 10) });
    }
    const routeTable = readProjectRoutes(directory) ?? ledgerRoutes ?? {};

    const directive = decideNextStage(outcome, reason, routeTable);
    if (!directive) {
      record('no-route');
      if (outcome === 'failed') writeHaltMarker(directory, intentId, `session-end:${reason}`);
      return null;
    }
    if (!LABEL_PATTERN.test(directive.stage) || !LABEL_PATTERN.test(directive.skill)) {
      record('invalid-ledger', { error: `invalid stage/skill: ${directive.stage}/${directive.skill}` });
      if (outcome === 'failed') writeHaltMarker(directory, intentId, `invalid-ledger:${reason}`);
      return null;
    }

    // Terminal route: the route table declares this stage as the end of the
    // chain (skill "stop" is reserved). Record and halt — no next link.
    if (directive.skill === 'stop') {
      record('chain-terminal', { stage: directive.stage });
      writeHaltMarker(directory, intentId, `terminal:${directive.stage}`);
      return null;
    }

    // Loop cap: this route already visited the next stage too many times
    // (e.g. failed:clear routing back to spec). Halt instead of burning slots.
    const visits = ledger.visits ?? {};
    const cap = typeof ledger.maxStageVisits === 'number' && Number.isInteger(ledger.maxStageVisits) && ledger.maxStageVisits >= 1
      ? ledger.maxStageVisits
      : 2;
    if ((visits[directive.stage] ?? 0) >= cap) {
      record('chain-loop-capped', { stage: directive.stage, visits: visits[directive.stage], cap });
      writeHaltMarker(directory, intentId, `loop-capped:${directive.stage}`);
      return null;
    }

    if (ledger.gate) {
      const verdict = gradeGate(ledger.gate, ledger.gateFacts ?? DEFAULT_GATE_FACTS);
      if (verdict.kind === 'human') {
        record('human-gate', { gate: ledger.gate, criterion: verdict.criterion });
        writeHaltMarker(directory, intentId, `human-gate:${ledger.gate}`);
        return null;
      }
      record('auto-pass', { gate: ledger.gate, signerFact: verdict.signerFact });
    }

    const slot = acquireChainSlot(intentId, factoryStateDir(directory));
    if (!slot.allowed) {
      // daily-cap already left its own stop marker inside acquireChainSlot.
      record('guardrail', { guardrail: slot.reason, detail: slot.detail });
      return null;
    }
    try {
      const chain: SpawnNextChain = { outcome, reason, routeTable, sessionId, intentId, tracker: ledger.tracker, visits };
      validateChainFields(chain);
      // ponytail: the serial window closes here, before the worker actually
      // spawns the next link; v1 accepts the small race, same as the listener.
      record('enqueued', { stage: directive.stage, skill: directive.skill });
      return chain;
    } catch (error) {
      record('invalid-ledger', { error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      releaseChainSlot(slot);
    }
  } catch {
    // Session end must never fail because of chain bookkeeping.
    return null;
  }
}
