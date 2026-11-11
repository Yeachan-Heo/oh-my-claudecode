import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { composeMapPrd, criteriaItems, finalizeMapRun, launchGate, mapRunTaskPrompt, questionOf, storiesFromPlan } from '../map-run.js';
import { readPrd } from '../../hooks/ralph/prd.js';
const MAP = { repo: 'o/r', number: 46 };
const childRecord = (n, body, extra = {}) => ({
    number: n,
    state: 'OPEN',
    labels: ['wayfinder:research'],
    assignees: 0,
    nativeParent: 46,
    body: `## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n${body}`,
    ...extra,
});
const plan = {
    map: MAP,
    planned: [
        { number: 70, gateClass: 'auto', disposition: 'ingest-with-criteria', awaitingHuman: false, malformedEdge: false },
        { number: 71, gateClass: 'auto', disposition: 'draft-criteria-then-stop', awaitingHuman: false, malformedEdge: false },
        { number: 72, gateClass: 'human', disposition: 'ingest-with-criteria', awaitingHuman: false, malformedEdge: false },
    ],
    frontier: { mapNumber: 46, auto: [], human: [], malformedEdges: [] },
};
describe('criteriaItems / questionOf', () => {
    it('extracts checklist items and the question line', () => {
        const body = '## Question\n\nShould the widget invert itself?\n\n## Acceptance criteria\n\n- [ ] the dry run lists me\n- [x] the map carries an edge\n\n## Blocked by\n\nNone (can start immediately)';
        expect(criteriaItems(body)).toEqual(['the dry run lists me', 'the map carries an edge']);
        expect(questionOf(body, 'fallback')).toBe('Should the widget invert itself?');
        expect(criteriaItems('no section here')).toEqual([]);
        expect(questionOf('bare body line', 'fallback')).toBe('bare body line');
    });
});
describe('storiesFromPlan', () => {
    const records = [
        childRecord(70, '## Question\n\nAdd the widget\n\n## Acceptance criteria\n\n- [ ] widget exists', { title: 'T70' }),
        childRecord(71, '## Question\n\nNo criteria here'),
        childRecord(72, '## Question\n\nGate'),
    ];
    it('ingests only criteria-carrying auto tickets, in order', () => {
        const stories = storiesFromPlan(plan, records);
        expect(stories).toHaveLength(1);
        expect(stories[0]).toMatchObject({ ticket: 70, id: 'US-001', title: 'T70', description: 'Add the widget', acceptanceCriteria: ['widget exists'] });
    });
    it('names the source ticket in the launch prompt', () => {
        const stories = storiesFromPlan(plan, records);
        const prompt = mapRunTaskPrompt(plan, stories);
        expect(prompt).toContain('o/r#46');
        expect(prompt).toContain('US-001 (from #70)');
    });
});
describe('launchGate', () => {
    it('blocks a drafted ticket until its body carries an accepted criteria section', () => {
        const outcomes = [{ ticket: 71, action: 'drafted-then-stopped', detail: '2 drafted criteria' }];
        const before = [childRecord(71, '## Question\n\nStill no criteria')];
        const blocked = launchGate(outcomes, before);
        expect(blocked.ok).toBe(false);
        expect(blocked.blocked[0]?.ticket).toBe(71);
        const accepted = [childRecord(71, '## Question\n\nStill no criteria\n\n## Acceptance criteria\n\n- [ ] accepted criterion')];
        expect(launchGate(outcomes, accepted).ok).toBe(true);
    });
    it('passes when nothing was drafted', () => {
        expect(launchGate([{ ticket: 70, action: 'claimed' }], []).ok).toBe(true);
    });
});
describe('composeMapPrd', () => {
    let dir;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'omc-map-run-'));
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
        execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
    });
    it('writes a session PRD whose stories carry the source ticket', () => {
        const records = [childRecord(70, '## Question\n\nAdd the widget\n\n## Acceptance criteria\n\n- [ ] widget exists', { title: 'T70' })];
        const result = composeMapPrd(dir, 'sess-map', plan, records, { feedbackCommands: ['npm test'] });
        expect(result.written).toBe(true);
        const prd = readPrd(dir, 'sess-map');
        expect(prd?.userStories).toHaveLength(1);
        expect(prd?.userStories[0]?.notes).toContain('source-ticket: o/r#70');
        expect(prd?.userStories[0]?.passes).toBe(false);
        expect(prd?.feedbackCommands).toEqual(['npm test']);
    });
    it('refuses when the frontier has no ingestible story', () => {
        const result = composeMapPrd(dir, 'sess-map', plan, [childRecord(71, '## Question\n\nNo criteria')], {});
        expect(result.written).toBe(false);
        expect(result.error).toContain('no ingestible stories');
    });
});
describe('finalizeMapRun', () => {
    const stories = [{ ticket: 70, id: 'US-001', title: 'T70', description: '', acceptanceCriteria: ['widget exists'] }];
    const mapBody = '## Destination\n\nd\n\n## Decisions so far\n\n- (none)\n\n## Out of scope\n';
    function harness(passes, verified) {
        const calls = [];
        const comments = [];
        const gh = (args) => {
            calls.push(args);
            if (args[1] === 'view')
                return { status: 0, stdout: JSON.stringify({ body: mapBody }), stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };
        const comment = (_ref, ticket, body) => {
            comments.push({ ticket, body });
            return 0;
        };
        const prd = {
            project: 'o/r',
            branchName: 'dev',
            description: 'x',
            userStories: [{ id: 'US-001', title: 'T70', description: '', acceptanceCriteria: ['widget exists'], priority: 1, passes, architectVerified: verified, notes: 'source-ticket: o/r#70' }],
        };
        return { calls, comments, gh, comment, prd };
    }
    it('closes a verified source ticket with evidence and appends the map pointer', () => {
        const h = harness(true, true);
        const outcomes = finalizeMapRun(MAP, stories, h.prd, { gh: h.gh, comment: h.comment });
        expect(h.calls.some((c) => c[1] === 'close' && c[2] === '70')).toBe(true);
        const evidence = h.comments.find((c) => c.ticket === 70);
        expect(evidence?.body).toContain('Closed by a map-driven ralph run');
        expect(evidence?.body).toContain('US-001');
        const edit = h.calls.find((c) => c[1] === 'edit' && c[2] === '46');
        expect(edit).toBeDefined();
        expect(outcomes.some((o) => o.ticket === 46 && o.detail?.includes('pointer appended'))).toBe(true);
    });
    it('never closes an unverified story — it reports instead', () => {
        const h = harness(true, false);
        const outcomes = finalizeMapRun(MAP, stories, h.prd, { gh: h.gh, comment: h.comment });
        expect(h.calls.some((c) => c[1] === 'close')).toBe(false);
        expect(outcomes[0]).toMatchObject({ ticket: 70, action: 'skipped' });
        expect(outcomes[0]?.detail).toContain('architectVerified=false');
    });
});
//# sourceMappingURL=map-run.test.js.map