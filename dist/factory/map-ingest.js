/**
 * Wayfinder map ingestion (spec #51, ticket T-B).
 *
 * The single module that talks to the tracker for map-driven ralph runs. Every
 * read funnels through here; the decision logic lives in the pure enumerator
 * (map-frontier). A future non-GitHub tracker would replace this module and
 * nothing else.
 *
 * Reads use the `gh` CLI — the same mechanism the factory chain's tracker
 * writeback already uses — and are injectable so the module is testable without
 * a network.
 */
import { spawnSync } from 'child_process';
import { enumerateFrontier, WAYFINDER_AWAITING_HUMAN_LABEL, } from './map-frontier.js';
export const defaultGhRunner = (args) => {
    const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
/** Parse `owner/repo#46` (repo optional — defaults to the current repository's origin). */
export function parseMapRef(raw, fallbackRepo) {
    const match = /^(?:([^/\s#]+)\/([^/\s#]+))?#?(\d+)$/.exec(raw.trim());
    if (!match)
        return null;
    const repo = match[1] && match[2] ? `${match[1]}/${match[2]}` : fallbackRepo;
    if (!repo)
        return null;
    return { repo, number: Number(match[3]) };
}
function normalizeView(view) {
    const labels = (view.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
    return {
        number: view.number,
        state: view.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
        labels,
        assignees: view.assignees?.length ?? 0,
        body: view.body ?? '',
        nativeParent: view.parent?.number ?? null,
        nativeBlockedBy: (view.blockedBy?.nodes ?? []).map((node) => node.number).filter((n) => typeof n === 'number'),
    };
}
const VIEW_FIELDS = 'number,state,labels,assignees,body,parent,blockedBy';
/**
 * Load every record the frontier computation needs: the map's children
 * candidates (found by body search — the relation that works on live maps),
 * plus any issue referenced as a blocker so its state resolves. An unreadable
 * issue is skipped; the enumerator treats an unknown blocker as open (safe).
 */
export function loadMapRecords(ref, gh = defaultGhRunner) {
    const seen = new Map();
    const list = gh(['issue', 'list', '--repo', ref.repo, '--state', 'all', '--limit', '200', '--search', `${ref.number} in:body`, '--json', 'number,state,labels,assignees,body']);
    const candidates = list.status === 0 ? safeJson(list.stdout, []) : [];
    // The map itself is not a child but references may resolve to it.
    const mapView = gh(['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', VIEW_FIELDS]);
    const views = [...candidates];
    if (mapView.status === 0) {
        const parsed = safeJson(mapView.stdout, null);
        if (parsed)
            views.push(parsed);
    }
    // Pull native relations for candidates (list --json does not carry them),
    // then chase every body-named reference for blocker states.
    const refsToView = new Set(views.map((view) => view.number));
    for (const view of views) {
        const detail = gh(['issue', 'view', String(view.number), '--repo', ref.repo, '--json', VIEW_FIELDS]);
        if (detail.status !== 0)
            continue;
        const parsed = safeJson(detail.stdout, null);
        if (parsed)
            seen.set(parsed.number, normalizeView(parsed));
    }
    for (const record of [...seen.values()]) {
        for (const referenced of bodyIssueRefs(record.body)) {
            if (!refsToView.has(referenced))
                refsToView.add(referenced);
        }
    }
    for (const number of refsToView) {
        if (seen.has(number))
            continue;
        const detail = gh(['issue', 'view', String(number), '--repo', ref.repo, '--json', VIEW_FIELDS]);
        if (detail.status !== 0)
            continue;
        const parsed = safeJson(detail.stdout, null);
        if (parsed)
            seen.set(parsed.number, normalizeView(parsed));
    }
    return [...seen.values()];
}
function bodyIssueRefs(body) {
    return [...body.matchAll(/#(\d+)|\/issues\/(\d+)/g)].map((match) => Number(match[1] ?? match[2]));
}
function safeJson(text, fallback) {
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
/** The plan a dry run prints and a real run acts on: the enumerator's verdict, classified. */
export function planFromMap(ref, records) {
    const frontier = enumerateFrontier(ref.number, records);
    const classify = (ticket) => ({
        number: ticket.number,
        gateClass: ticket.gateClass,
        disposition: ticket.gateClass === 'auto'
            ? (ticket.hasCriteria ? 'ingest-with-criteria' : 'draft-criteria-then-stop')
            : 'ingest-with-criteria',
        awaitingHuman: ticket.awaitingHuman,
        malformedEdge: ticket.malformedEdge,
    });
    return {
        map: ref,
        frontier,
        planned: [...frontier.auto.map(classify), ...frontier.human.map(classify)],
    };
}
export function renderMapPlan(plan) {
    const lines = [];
    lines.push(`map ${plan.map.repo}#${plan.map.number} — frontier plan (dry run, nothing written)`);
    const auto = plan.planned.filter((t) => t.gateClass === 'auto');
    const human = plan.planned.filter((t) => t.gateClass === 'human');
    lines.push(`auto-executable (${auto.length}):`);
    if (auto.length === 0)
        lines.push('  (none)');
    for (const ticket of auto) {
        lines.push(`  #${ticket.number} — ${ticket.disposition}${ticket.malformedEdge ? ' [malformed edge — human-gated for safety]' : ''}`);
    }
    lines.push(`human-gated (${human.length}):`);
    if (human.length === 0)
        lines.push('  (none)');
    for (const ticket of human) {
        lines.push(`  #${ticket.number}${ticket.awaitingHuman ? ' — already awaiting human' : ' — routes to human, never auto-claimed'}${ticket.malformedEdge ? ' [malformed edge]' : ''}`);
    }
    if (plan.frontier.malformedEdges.length > 0) {
        lines.push(`malformed edges (safe direction, not auto-runnable): ${plan.frontier.malformedEdges.map((n) => `#${n}`).join(', ')}`);
    }
    return lines.join('\n');
}
/** Pure: the criteria draft a human edits to unblock a criteria-less ticket. */
export function draftCriteriaFromQuestion(body) {
    const section = /^\s*##\s*Question\s*$/im.exec(body);
    const rest = section ? body.slice(section.index + section[0].length) : body;
    const question = rest
        .split(/^\s*##\s+/m)[0]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('<!--'))[0] ?? 'the ticket question';
    return [
        `- [ ] ${question}`,
        '- [ ] The resolution is recorded on this ticket with evidence a reviewer can check',
    ];
}
export function renderProvenance(ref, ticket, provenance) {
    return [
        `Claimed by an automated ralph planning run (mode: ${provenance.mode}).`,
        '',
        `- session: \`${provenance.sessionId}\``,
        `- claimed at: ${provenance.at}`,
        `- map: ${ref.repo}#${ref.number}`,
        '',
        'Claimed via assignee; this comment is the provenance record. If the run dies, this comment is what a human clears.',
    ].join('\n');
}
export function renderRoutingComment(ref, ticket, awaitingHuman) {
    return awaitingHuman
        ? `Surfaced to a human by an automated ralph planning run: this ticket is a human gate (wayfinder:grilling / wayfinder:prototype / bare wayfinder:task). No auto-run. Already marked awaiting-human.`
        : `Surfaced to a human by an automated ralph planning run: this ticket is a human gate (wayfinder:grilling / wayfinder:prototype / bare wayfinder:task). It was NOT claimed and will not be executed headlessly. Marked \`${WAYFINDER_AWAITING_HUMAN_LABEL}\`.`;
}
export const defaultCommentRunner = (ref, ticket, body) => {
    // Body via stdin (--body-file -): cmd.exe codepages mangle non-ASCII argv.
    const result = spawnSync('gh', ['issue', 'comment', String(ticket), '--repo', ref.repo, '--body-file', '-'], {
        input: body,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
    });
    return result.status;
};
export function executePlanActions(plan, options) {
    const gh = options.gh ?? defaultGhRunner;
    const comment = options.comment ?? defaultCommentRunner;
    const outcomes = [];
    for (const ticket of plan.planned) {
        if (ticket.gateClass === 'human') {
            if (ticket.awaitingHuman) {
                outcomes.push({ ticket: ticket.number, action: 'skipped', detail: 'already awaiting human' });
                continue;
            }
            const labeled = gh(['issue', 'edit', String(ticket.number), '--repo', plan.map.repo, '--add-label', WAYFINDER_AWAITING_HUMAN_LABEL]);
            const commented = comment(plan.map, ticket.number, renderRoutingComment(plan.map, ticket.number, false));
            outcomes.push({
                ticket: ticket.number,
                action: labeled.status === 0 && commented === 0 ? 'routed-to-human' : 'skipped',
                detail: labeled.status === 0 ? undefined : `label failed (gh exit ${labeled.status})`,
            });
            continue;
        }
        // auto-executable: claim atomically, then record provenance.
        const assigned = gh(['issue', 'edit', String(ticket.number), '--repo', plan.map.repo, '--add-assignee', '@me']);
        if (assigned.status !== 0) {
            outcomes.push({ ticket: ticket.number, action: 'skipped', detail: `claim failed (gh exit ${assigned.status})` });
            continue;
        }
        comment(plan.map, ticket.number, renderProvenance(plan.map, ticket.number, options.provenance));
        if (ticket.disposition === 'draft-criteria-then-stop') {
            const records = loadMapRecords(plan.map, gh);
            const record = records.find((r) => r.number === ticket.number);
            const draft = draftCriteriaFromQuestion(record?.body ?? '');
            gh(['issue', 'edit', String(ticket.number), '--repo', plan.map.repo, '--add-label', WAYFINDER_AWAITING_HUMAN_LABEL]);
            comment(plan.map, ticket.number, `Drafted acceptance criteria (ralph planning run — EDIT AND ACCEPT before any execution):\n\n${draft.join('\n')}`);
            // The pass keeps going: routing and claiming are bookkeeping a human
            // benefits from immediately. The STOP is the launch decision — the
            // caller sees a drafted-then-stopped outcome and must not start the loop
            // until the criteria are edited and accepted.
            outcomes.push({ ticket: ticket.number, action: 'drafted-then-stopped', detail: `${draft.length} drafted criteria — human acceptance required` });
            continue;
        }
        outcomes.push({ ticket: ticket.number, action: 'claimed', detail: 'criteria present — ready for ingestion' });
    }
    return outcomes;
}
export function renderActionOutcomes(outcomes) {
    const lines = ['map run actions:'];
    if (outcomes.length === 0)
        lines.push('  (nothing to do)');
    for (const outcome of outcomes) {
        lines.push(`  #${outcome.ticket} — ${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=map-ingest.js.map