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
import { decideNextStage, gradeGate, normalizeRouteTable } from './routing.js';
import { acquireChainSlot, releaseChainSlot, INTENT_ID_PATTERN } from './guardrails.js';
import { verifyCheckEvidence } from './check-evidence.js';
import { validateChainFields, LABEL_PATTERN } from './spawn-next.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';
/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' (no failure signal in the SessionEnd
 * payload), so it counts as a normal exit; 'clear' wipes the chain session's
 * context and halts the chain; unknown reasons stay failed.
 */
export function sessionEndOutcome(reason) {
    return reason === 'prompt_input_exit' || reason === 'logout' || reason === 'other'
        ? 'success'
        : 'failed';
}
export function factoryStateDir(directory) {
    return join(getOmcRoot(directory), 'state', 'factory');
}
export function readChainLedger(directory, sessionId) {
    try {
        validateSessionId(sessionId);
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(join(factoryStateDir(directory), `chain-${sessionId}.json`), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * `omc factory init --no-narrow` used to seed `success:launch` with a
 * `diagnose` skill that never shipped (#4676), and init never overwrites an
 * existing table. Remap exactly that legacy default to the shipped `debug`
 * skill at read time; any other value is a custom route and stays as written,
 * and a project that ships its own `diagnose` skill keeps it.
 */
function migrateLegacyRoutes(directory, table) {
    const launch = table['success:launch'];
    if (!launch || launch.stage !== 'diagnose' || launch.skill !== 'diagnose' || launch.verify)
        return table;
    if (fs.existsSync(join(directory, '.claude', 'skills', 'diagnose', 'SKILL.md')))
        return table;
    return { ...table, 'success:launch': { stage: 'diagnose', skill: 'debug' } };
}
/** Project-level route table: `.omc/factory-routes.json`. The single source of truth. */
export function readProjectRoutes(directory) {
    try {
        const parsed = JSON.parse(fs.readFileSync(join(getOmcRoot(directory), 'factory-routes.json'), 'utf8'));
        const table = normalizeRouteTable(parsed);
        return table ? migrateLegacyRoutes(directory, table) : null;
    }
    catch {
        return null;
    }
}
function recordDecision(directory, record) {
    recordChainDecision(directory, record);
}
/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export function recordChainDecision(directory, record) {
    try {
        fs.mkdirSync(factoryStateDir(directory), { recursive: true });
        fs.appendFileSync(join(factoryStateDir(directory), 'chain-decisions.jsonl'), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8');
    }
    catch {
        // best-effort audit trail
    }
}
function writeHaltMarker(directory, intentId, reason) {
    try {
        fs.mkdirSync(factoryStateDir(directory), { recursive: true });
        fs.writeFileSync(join(factoryStateDir(directory), `chain-${intentId}.stopped.json`), JSON.stringify({ intentId, reason, stoppedAt: new Date().toISOString() }, null, 2), 'utf8');
    }
    catch {
        // best-effort halt marker
    }
}
const DEFAULT_GATE_FACTS = {
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
export function planChainEnqueue(directory, sessionId, reason) {
    try {
        const ledger = readChainLedger(directory, sessionId);
        if (!ledger)
            return null;
        const outcome = sessionEndOutcome(reason);
        const intentId = typeof ledger.intentId === 'string' && ledger.intentId ? ledger.intentId : `chain-${sessionId}`;
        const record = (decision, extra = {}) => recordDecision(directory, { decision, sessionId, outcome, reason, intentId, ...extra });
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
            record('malformed-route-table', { source: 'ledger', keys: Object.keys(ledger.routeTable).slice(0, 10) });
        }
        const routeTable = readProjectRoutes(directory) ?? ledgerRoutes ?? {};
        const directive = decideNextStage(outcome, reason, routeTable);
        if (!directive) {
            record('no-route');
            if (outcome === 'failed')
                writeHaltMarker(directory, intentId, `session-end:${reason}`);
            return null;
        }
        if (!LABEL_PATTERN.test(directive.stage) || !LABEL_PATTERN.test(directive.skill)) {
            record('invalid-ledger', { error: `invalid stage/skill: ${directive.stage}/${directive.skill}` });
            if (outcome === 'failed')
                writeHaltMarker(directory, intentId, `invalid-ledger:${reason}`);
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
            const declared = ledger.gateFacts ?? DEFAULT_GATE_FACTS;
            // A declared mechanical pass must be backed by check evidence on disk;
            // missing or failing evidence overrides the flag to false (conservative:
            // an unverified gate grades human, same as an undeclared one).
            const facts = declared.mechanicalChecksPassed === true && !verifyCheckEvidence(getOmcRoot(directory), sessionId)
                ? { ...declared, mechanicalChecksPassed: false }
                : declared;
            const verdict = gradeGate(ledger.gate, facts);
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
            const chain = { outcome, reason, routeTable, sessionId, intentId, tracker: ledger.tracker, visits, includeUserSettings: ledger.includeUserSettings === true };
            validateChainFields(chain);
            // ponytail: the serial window closes here, before the worker actually
            // spawns the next link; v1 accepts the small race, same as the listener.
            record('enqueued', { stage: directive.stage, skill: directive.skill });
            return chain;
        }
        catch (error) {
            record('invalid-ledger', { error: error instanceof Error ? error.message : String(error) });
            return null;
        }
        finally {
            releaseChainSlot(slot);
        }
    }
    catch {
        // Session end must never fail because of chain bookkeeping.
        return null;
    }
}
//# sourceMappingURL=chain-enqueuer.js.map