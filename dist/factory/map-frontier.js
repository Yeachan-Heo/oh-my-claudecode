/**
 * Wayfinder map frontier enumeration (spec #51, ticket T-A).
 *
 * The single decision surface of map ingestion: given tracker issue records,
 * answer "which tickets are on this map's frontier, in what order, and which
 * may a headless ralph claim?". Pure — no IO, no tracker client. The ingestion
 * module (T-B) feeds it normalized records; every downstream action (claim,
 * routing, story materialization) reads its verdict.
 *
 * Semantics fixed by map #46's decisions (research #47, design #48):
 * - Children: native parent, else the body's Parent section naming the map.
 * - Filters: OPEN only; drop if any blocker (native or body-named) is OPEN,
 *   transitively through closed; drop if assigned.
 * - Order: ascending ticket number, overridable by an Order line in the body.
 * - Gate class: research is auto-executable; a task ticket is auto-executable
 *   only with the AFK opt-in label; grilling, prototype, bare task, and
 *   unknown types are human-gated (the safe direction is the default).
 * - A malformed blocking edge degrades safe: the ticket is never offered as
 *   auto-executable.
 */
export const WAYFINDER_TASK_AFK_LABEL = 'wayfinder:task:afk';
export const WAYFINDER_AWAITING_HUMAN_LABEL = 'wayfinder:awaiting-human';
// ---------------------------------------------------------------------------
// Tolerant body parsing (the three live blocking syntaxes + the two parent
// syntaxes; a line we cannot parse is surfaced, never silently dropped).
// ---------------------------------------------------------------------------
const PARENT_HEADING = /^\s*##\s*Parent\s*$/im;
const PARENT_BARE = /^\s*父图[:：]\s*(.+)$/m;
const BLOCKED_HEADING = /^\s*##\s*Blocked by\s*$/im;
// The legacy bare form rides the same line as the parent ref (`父图：#35。blocked-by: #36 #37`),
// so the anchor is a word boundary, not the line start.
const BLOCKED_BARE = /\bblocked-by[:：]\s*(.+)$/m;
const ORDER_LINE = /^\s*##\s*Order[:：]\s*(\d+)\s*$/im;
const CRITERIA_HEADING = /^\s*##\s*(?:Acceptance criteria|验收标准)\s*$/im;
/**
 * Issue references appear two ways in real bodies: the link TEXT carries the
 * `#46` fragment (`[owner/repo#46](…)`) and the link TARGET carries
 * `/issues/46` — a body whose visible text is just a map name must still parse.
 */
const ISSUE_REF = /#(\d+)|\/issues\/(\d+)/g;
function sectionBody(body, heading) {
    const match = heading.exec(body);
    if (!match)
        return null;
    const start = match.index + match[0].length;
    const rest = body.slice(start);
    const nextHeading = rest.search(/^\s*##\s+/m);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
function issueRefs(text) {
    return [...text.matchAll(ISSUE_REF)].map((match) => Number(match[1] ?? match[2]));
}
/** Parent map numbers named by the body: `## Parent` section or the legacy `父图：#n` line. */
function bodyParentRefs(body) {
    const section = sectionBody(body, PARENT_HEADING);
    if (section) {
        const refs = issueRefs(section);
        if (refs.length > 0)
            return refs;
    }
    const bare = PARENT_BARE.exec(body);
    return bare ? issueRefs(bare[1]) : [];
}
function parseBlocked(body) {
    const section = sectionBody(body, BLOCKED_HEADING);
    const bare = BLOCKED_BARE.exec(body);
    const raw = section ?? (bare ? bare[1] : null);
    if (raw === null)
        return { blockers: [], malformed: false };
    if (/^\s*none\b/i.test(raw.trim()))
        return { blockers: [], malformed: false };
    const blockers = issueRefs(raw);
    // A heading with content that yields no parseable reference is malformed —
    // e.g. a link without a number, or prose. Safe direction: report it.
    const hasContent = raw.trim().length > 0;
    return { blockers, malformed: hasContent && blockers.length === 0 };
}
function ticketType(labels) {
    for (const label of labels) {
        switch (label) {
            case 'wayfinder:research': return 'research';
            case 'wayfinder:prototype': return 'prototype';
            case 'wayfinder:grilling': return 'grilling';
            case 'wayfinder:task': return 'task';
            default: break;
        }
    }
    return 'other';
}
/** Gate class per map #46's decision: only research and explicitly-AFK tasks are auto; everything else human. */
export function gateClassFor(type, labels) {
    if (type === 'research')
        return 'auto';
    if (type === 'task')
        return labels.includes(WAYFINDER_TASK_AFK_LABEL) ? 'auto' : 'human';
    return 'human';
}
// ---------------------------------------------------------------------------
// The enumerator
// ---------------------------------------------------------------------------
/**
 * Enumerate a map's frontier from issue records. Records may include issues
 * beyond the children (referenced blockers) so blocker states resolve; a
 * blocker whose state is unknown counts as OPEN (safe: blocked pending
 * verification).
 */
export function enumerateFrontier(mapNumber, records) {
    const stateByNumber = new Map();
    for (const record of records)
        stateByNumber.set(record.number, record.state);
    const children = records.filter((record) => record.nativeParent === mapNumber || bodyParentRefs(record.body).includes(mapNumber));
    const malformedEdges = [];
    const auto = [];
    const human = [];
    for (const record of children) {
        if (record.state !== 'OPEN')
            continue;
        if (record.assignees > 0)
            continue; // claimed
        const parsed = parseBlocked(record.body);
        const blockers = [...(record.nativeBlockedBy ?? []), ...parsed.blockers];
        const blocked = blockers.some((blocker) => (stateByNumber.get(blocker) ?? 'OPEN') !== 'CLOSED');
        if (blocked)
            continue;
        const type = ticketType(record.labels);
        const ticket = {
            number: record.number,
            type,
            gateClass: gateClassFor(type, record.labels),
            awaitingHuman: record.labels.includes(WAYFINDER_AWAITING_HUMAN_LABEL),
            order: Number(ORDER_LINE.exec(record.body)?.[1] ?? record.number),
            hasCriteria: CRITERIA_HEADING.test(record.body),
            malformedEdge: parsed.malformed,
        };
        if (parsed.malformed) {
            // Safe direction: never auto-executable while an edge is unreadable.
            malformedEdges.push(record.number);
            ticket.gateClass = 'human';
        }
        (ticket.gateClass === 'auto' ? auto : human).push(ticket);
    }
    const byOrder = (a, b) => a.order - b.order || a.number - b.number;
    auto.sort(byOrder);
    human.sort(byOrder);
    return { mapNumber, auto, human, malformedEdges };
}
//# sourceMappingURL=map-frontier.js.map