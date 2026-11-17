/**
 * Factory chain watchdog (T4): detects and flags stalled chain links.
 *
 * A ledger without a routeTable is a pre-written first-ring ledger that no
 * enqueuer has taken over yet (the listener writes `{intentId, stage}`;
 * `executeSpawnNext` writes the routeTable-carrying ledger for later links).
 * If such a ledger ages past the threshold, its session never made it to a
 * SessionEnd handoff — stalled. The enqueuer never rewrites or deletes the
 * ledger on consumption, so ledgers whose session already has an 'enqueued'
 * decision in chain-decisions.jsonl are treated as advanced, not stalled.
 *
 * Pure detection + one-shot flagging; scheduling the sweep is the caller's
 * job (event-driven integration, no timers in this module).
 */
import * as fs from 'fs';
import { join } from 'path';
import { defaultSpawnFn } from '../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
export const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;
export const HARBOR_NEED_INFO_LABEL = 'harbor:need-info';
/** Ledgers are only ever named after a spawned uuid session id. */
const LEDGER_FILE_PATTERN = /^chain-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
/** Session ids the enqueuer already advanced ('enqueued' decision records). */
function enqueuedSessions(factoryDir) {
    const advanced = new Set();
    try {
        for (const line of fs.readFileSync(join(factoryDir, 'chain-decisions.jsonl'), 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const record = JSON.parse(line);
                if (record.decision === 'enqueued' && typeof record.sessionId === 'string')
                    advanced.add(record.sessionId);
            }
            catch {
                // skip malformed decision lines
            }
        }
    }
    catch {
        // no decisions file yet — nothing has advanced
    }
    return advanced;
}
/**
 * Scan `factoryDir` (`.omc/state/factory`) for stalled chain ledgers:
 * no routeTable, no 'enqueued' decision for the session, mtime older
 * than the threshold.
 */
export function detectStalledLinks(factoryDir, opts = {}) {
    const threshold = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    const now = opts.now?.getTime() ?? Date.now();
    let entries;
    try {
        entries = fs.readdirSync(factoryDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const advanced = enqueuedSessions(factoryDir);
    const stalled = [];
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const match = LEDGER_FILE_PATTERN.exec(entry.name);
        if (!match)
            continue;
        const session = match[1];
        let ledger;
        try {
            const parsed = JSON.parse(fs.readFileSync(join(factoryDir, entry.name), 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                continue;
            ledger = parsed;
        }
        catch {
            continue;
        }
        if (ledger.routeTable)
            continue;
        if (advanced.has(session))
            continue;
        let stalledForMs;
        try {
            stalledForMs = now - fs.statSync(join(factoryDir, entry.name)).mtimeMs;
        }
        catch {
            continue;
        }
        if (stalledForMs < threshold)
            continue;
        stalled.push({
            intentId: typeof ledger.intentId === 'string' && ledger.intentId ? ledger.intentId : `chain-${session}`,
            session,
            stage: typeof ledger.stage === 'string' ? ledger.stage : 'unknown',
            stalledForMs,
            ...(ledger.tracker && typeof ledger.tracker === 'object' ? { tracker: ledger.tracker } : {}),
        });
    }
    return stalled;
}
function defaultAudit(cwd) {
    const dir = join(getOmcRoot(cwd), 'state');
    return (record) => {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(join(dir, 'factory-listener-audit.jsonl'), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8');
        }
        catch {
            // best-effort audit trail
        }
    };
}
export function stallAlertComment(stall) {
    const minutes = Math.max(1, Math.round(stall.stalledForMs / 60_000));
    return `链已停住：${stall.stage} 环会话 ${stall.session} 已 ${minutes} 分钟未推进（预写 ledger 未被接管），需人工检查。`;
}
/** One-shot alert for a stalled link: tracker issue gets the harbor:need-info label + comment, otherwise audit trail. */
export function flagStall(stall, deps) {
    const tracker = stall.tracker;
    if (tracker) {
        const spawner = deps.spawner ?? defaultSpawnFn;
        spawner('gh', ['issue', 'edit', String(tracker.issue), '--repo', tracker.repo, '--add-label', HARBOR_NEED_INFO_LABEL]);
        spawner('gh', ['issue', 'comment', String(tracker.issue), '--repo', tracker.repo, '--body', stallAlertComment(stall)]);
        return;
    }
    const audit = deps.audit ?? defaultAudit(deps.cwd);
    audit({ kind: 'stalled', intentId: stall.intentId, session: stall.session, stage: stall.stage, stalledForMs: stall.stalledForMs });
}
//# sourceMappingURL=watchdog.js.map