/**
 * Map-driven run orchestration (spec #51, ticket #55): the claimed frontier
 * tickets become PRD stories, a launch gate refuses to start while drafted
 * criteria await human acceptance, and finalize closes each verified source
 * ticket with evidence plus a one-line pointer on the map.
 *
 * Tracker IO stays in map-ingest; this module composes it with the ralph PRD
 * and the loop launcher's argv.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { defaultCommentRunner, defaultGhRunner, } from './map-ingest.js';
import { ensurePrdForStartup, writePrd } from '../hooks/ralph/prd.js';
const CRITERIA_ITEM = /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/;
const CRITERIA_HEADING = /^\s*##\s*(?:Acceptance criteria|验收标准)\s*$/im;
const QUESTION_HEADING = /^\s*##\s*Question\s*$/im;
/** The checklist items of a ticket's Acceptance criteria section. */
export function criteriaItems(body) {
    const section = CRITERIA_HEADING.exec(body);
    if (!section)
        return [];
    const rest = body.slice(section.index + section[0].length);
    const next = rest.search(/^\s*##\s+/m);
    const scope = next === -1 ? rest : rest.slice(0, next);
    return scope
        .split('\n')
        .map((line) => CRITERIA_ITEM.exec(line)?.[1]?.trim())
        .filter((item) => Boolean(item));
}
/** The first meaningful line of a ticket's Question section (falls back to the body). */
export function questionOf(body, fallback) {
    const section = QUESTION_HEADING.exec(body);
    const rest = section ? body.slice(section.index + section[0].length) : body;
    const line = rest
        .split(/^\s*##\s+/m)[0]
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('<!--'));
    return line ?? fallback;
}
/** Pure: the plan's ingest-with-criteria auto tickets, in order, as story drafts. */
export function storiesFromPlan(plan, records) {
    const stories = [];
    for (const planned of plan.planned) {
        if (planned.gateClass !== 'auto' || planned.disposition !== 'ingest-with-criteria')
            continue;
        const record = records.find((r) => r.number === planned.number);
        const criteria = criteriaItems(record?.body ?? '');
        if (!record || criteria.length === 0)
            continue;
        stories.push({
            ticket: planned.number,
            id: `US-${String(stories.length + 1).padStart(3, '0')}`,
            title: record.title ?? questionOf(record.body, `#${planned.number}`),
            description: questionOf(record.body, ''),
            acceptanceCriteria: criteria,
        });
    }
    return stories;
}
/**
 * The launch gate: every drafted-criteria ticket must show an acceptance
 * criteria section in its body (the human edited and accepted) before any
 * loop may start.
 */
export function launchGate(outcomes, records) {
    const blocked = [];
    for (const outcome of outcomes) {
        if (outcome.action !== 'drafted-then-stopped')
            continue;
        const record = records.find((r) => r.number === outcome.ticket);
        if (criteriaItems(record?.body ?? '').length === 0) {
            blocked.push({ ticket: outcome.ticket, reason: 'drafted criteria not yet accepted (no criteria section on the ticket)' });
        }
    }
    return { ok: blocked.length === 0, blocked };
}
function currentBranch(directory) {
    try {
        return (execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim() ||
            'ralph/map-run');
    }
    catch {
        return 'ralph/map-run';
    }
}
/** Write the session-scoped PRD whose stories come from the claimed map tickets. */
export function composeMapPrd(directory, sessionId, plan, records, options = {}) {
    const stories = storiesFromPlan(plan, records);
    if (stories.length === 0) {
        return { written: false, stories, prdPath: null, error: 'no ingestible stories on the frontier' };
    }
    const userStories = stories.map((story, index) => ({
        id: story.id,
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
        priority: index + 1,
        passes: false,
        architectVerified: false,
        notes: `source-ticket: ${plan.map.repo}#${story.ticket}`,
    }));
    const prd = {
        project: plan.map.repo,
        branchName: currentBranch(directory),
        description: `Map-driven ralph run from ${plan.map.repo}#${plan.map.number} — ${userStories.length} story(ies) ingested from claimed frontier tickets`,
        userStories,
        ...(options.feedbackCommands && options.feedbackCommands.length > 0 ? { feedbackCommands: options.feedbackCommands } : {}),
    };
    const startup = ensurePrdForStartup(directory, prd.project, prd.branchName, prd.description, userStories, sessionId);
    const prdPath = startup.ok ? startup.path : null;
    if (!startup.ok) {
        return { written: false, stories, prdPath: null, error: startup.error ?? 'PRD startup failed' };
    }
    // ensure may have created a scaffold or found an older PRD; the map run owns
    // this session's document, so write the composed shape either way.
    const written = writePrd(directory, prd, sessionId);
    writeMapRunSidecar(directory, sessionId, plan.map, stories);
    return { written, stories, prdPath };
}
function sessionDir(directory, sessionId) {
    return join(getOmcRoot(directory), 'state', 'sessions', sessionId);
}
function writeMapRunSidecar(directory, sessionId, map, stories) {
    try {
        const dir = sessionDir(directory, sessionId);
        mkdirSync(dir, { recursive: true });
        const sidecar = { map, stories: stories.map((s) => ({ ticket: s.ticket, id: s.id })) };
        writeFileSync(join(dir, 'map-run.json'), `${JSON.stringify(sidecar, null, 2)}
`, 'utf8');
    }
    catch {
        // best-effort: finalize falls back to PRD notes
    }
}
/** Read the compose-time ticket↔story mapping; null when absent. */
export function readMapRunSidecar(directory, sessionId) {
    try {
        const parsed = JSON.parse(readFileSync(join(sessionDir(directory, sessionId), 'map-run.json'), 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        const doc = parsed;
        if (!doc.map || !Array.isArray(doc.stories))
            return null;
        return doc;
    }
    catch {
        return null;
    }
}
/** The task prompt a launched map run receives. */
export function mapRunTaskPrompt(plan, stories) {
    return [
        `Work the stories ingested from wayfinder map ${plan.map.repo}#${plan.map.number}. The PRD at the active path is authoritative; the tickets behind each story are recorded in its story notes.`,
        '',
        ...stories.map((story) => `- ${story.id} (from #${story.ticket}): ${story.title}`),
        '',
        'Finish every story with its acceptance criteria verified, then run the terminal closeout.',
    ].join('\n');
}
/**
 * Write-back: every ingested story that passed AND carries reviewer sign-off
 * closes its source ticket with an evidence comment; the map's
 * Decisions-so-far gains one pointer line. Unverified stories are reported,
 * never closed.
 */
export function finalizeMapRun(ref, stories, prd, options = {}) {
    const gh = options.gh ?? defaultGhRunner;
    const comment = options.comment ?? defaultCommentRunner;
    const outcomes = [];
    const closed = [];
    for (const story of stories) {
        const prdStory = prd.userStories.find((s) => s.id === story.id);
        if (!prdStory?.passes || !prdStory.architectVerified) {
            outcomes.push({
                ticket: story.ticket,
                action: 'skipped',
                detail: `story ${story.id} not verified (passes=${prdStory?.passes ?? false}, architectVerified=${prdStory?.architectVerified ?? false})`,
            });
            continue;
        }
        const evidence = [
            `Closed by a map-driven ralph run (${ref.repo}#${ref.number}).`,
            '',
            `- story: ${story.id} — ${story.title}`,
            `- acceptance criteria verified: ${prdStory.acceptanceCriteria.length}`,
            `- reviewer sign-off: architectVerified at revision ${prdStory.architectVerificationCriteriaRevision ?? 'current'}`,
            '',
            'The decision record lives on this ticket; the map keeps the pointer.',
        ].join('\n');
        comment(ref, story.ticket, evidence);
        const closedResult = gh(['issue', 'close', String(story.ticket), '--repo', ref.repo]);
        if (closedResult.status === 0) {
            closed.push(story.ticket);
            outcomes.push({ ticket: story.ticket, action: 'claimed', detail: 'evidence comment + closed' });
        }
        else {
            outcomes.push({ ticket: story.ticket, action: 'skipped', detail: `close failed (gh exit ${closedResult.status})` });
        }
    }
    if (closed.length > 0) {
        appendMapDecisionPointer(ref, closed, gh);
        outcomes.push({ ticket: ref.number, action: 'routed-to-human', detail: `map pointer appended for #${closed.join(', #')}` });
    }
    return outcomes;
}
function appendMapDecisionPointer(ref, closed, gh) {
    const view = gh(['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'body']);
    if (view.status !== 0)
        return;
    let body;
    try {
        body = JSON.parse(view.stdout).body ?? '';
    }
    catch {
        return;
    }
    const pointer = `\n- [Map run ${new Date().toISOString().slice(0, 10)}](${ref.repo}/issues/${closed[0]}): ralph completed and verified ${closed.length} ticket(s) (#${closed.join(', #')}); each ticket holds the decision record.`;
    const next = body.replace(/\n## Decisions so far/, (m) => `${m}${pointer}`);
    const dir = join(tmpdir(), `omc-map-body-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'body.md');
    writeFileSync(file, next, 'utf8');
    gh(['issue', 'edit', String(ref.number), '--repo', ref.repo, '--body-file', file]);
}
//# sourceMappingURL=map-run.js.map