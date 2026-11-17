import { describe, it, expect } from 'vitest';
import { enumerateFrontier, gateClassFor, WAYFINDER_AWAITING_HUMAN_LABEL, WAYFINDER_TASK_AFK_LABEL, } from '../map-frontier.js';
function ticket(overrides) {
    return {
        state: 'OPEN',
        labels: [],
        assignees: 0,
        body: '',
        nativeParent: null,
        nativeBlockedBy: [],
        ...overrides,
    };
}
const MAP = 46;
const child = (n, body, extra = {}) => ticket({ number: n, body: `## Parent\n\n[owner/repo#${MAP}](https://github.com/o/r/issues/${MAP})\n\n${body}`, ...extra });
describe('enumerateFrontier — children and filters', () => {
    it('takes children from the body Parent section when no native relation exists', () => {
        const frontier = enumerateFrontier(MAP, [
            child(50, '## Question\n\nWhat is X?', { labels: ['wayfinder:research'] }),
            ticket({ number: 51, body: 'no parent here' }),
        ]);
        expect(frontier.auto.map((t) => t.number)).toEqual([50]);
        expect(frontier.human).toEqual([]);
    });
    it('takes children from the native parent relation when set', () => {
        const frontier = enumerateFrontier(MAP, [ticket({ number: 52, nativeParent: MAP, labels: ['wayfinder:research'] })]);
        expect(frontier.auto.map((t) => t.number)).toEqual([52]);
    });
    it('keeps only OPEN, unassigned children', () => {
        const frontier = enumerateFrontier(MAP, [
            child(50, '', { state: 'CLOSED', labels: ['wayfinder:research'] }),
            child(51, '', { assignees: 1, labels: ['wayfinder:research'] }),
            child(52, '', { labels: ['wayfinder:research'] }),
        ]);
        expect(frontier.auto.map((t) => t.number)).toEqual([52]);
    });
    it('drops a body-blocked ticket while its blocker is open, and admits it once the blocker closes', () => {
        const open = child(60, '## Question\n\nBlocked below\n\n## Blocked by\n\n- [#61](https://github.com/o/r/issues/61)', { labels: ['wayfinder:research'] });
        const blocker = child(61, '', { labels: ['wayfinder:research'] });
        const first = enumerateFrontier(MAP, [open, blocker]);
        expect(first.auto.map((t) => t.number)).toEqual([61]);
        // The blocker itself is CLOSED — off the frontier; the dependent is admitted.
        const second = enumerateFrontier(MAP, [open, ticket({ ...blocker, state: 'CLOSED' })]);
        expect(second.auto.map((t) => t.number)).toEqual([60]);
    });
    it('honors native blocked-by edges and treats an unknown blocker as open (safe)', () => {
        const records = [
            ticket({ number: 70, labels: ['wayfinder:research'], nativeParent: MAP, nativeBlockedBy: [71] }),
            ticket({ number: 71, state: 'CLOSED', nativeParent: MAP }),
            ticket({ number: 72, labels: ['wayfinder:research'], nativeParent: MAP, nativeBlockedBy: [999] }),
        ];
        const frontier = enumerateFrontier(MAP, records);
        // 70 unblocks once 71 is closed (71 itself is closed → off the frontier);
        // 72 names an unknown blocker → treated as open → blocked (safe direction).
        expect(frontier.auto.map((t) => t.number)).toEqual([70]);
    });
});
describe('enumerateFrontier — the three live blocking syntaxes', () => {
    it('parses heading-bullet, bare blocked-by line, and None', () => {
        const research = { labels: ['wayfinder:research'] };
        const heading = child(80, '## Blocked by\n\n- [#81](https://github.com/o/r/issues/81)', research);
        const bare = child(82, '父图：#46。blocked-by: #83 #84', research);
        const none = child(85, '## Blocked by\n\nNone (can start immediately)', research);
        const blockers = child(83, '', research);
        const blocker84 = child(84, '', research);
        const frontier = enumerateFrontier(MAP, [heading, bare, none, blockers, blocker84]);
        expect(frontier.auto.map((t) => t.number).sort((a, b) => a - b)).toEqual([83, 84, 85]);
    });
    it('degrades a malformed edge to the safe direction: human-gated, surfaced in malformedEdges', () => {
        const broken = child(90, '## Blocked by\n\n[the design ticket](https://github.com/o/r/issues/not-a-number)');
        const frontier = enumerateFrontier(MAP, [broken]);
        expect(frontier.auto).toEqual([]);
        expect(frontier.human.map((t) => t.number)).toEqual([90]);
        expect(frontier.malformedEdges).toEqual([90]);
        expect(frontier.human[0]?.malformedEdge).toBe(true);
    });
});
describe('enumerateFrontier — gate class', () => {
    it('classifies per map #46: research auto; task only with the AFK bit; grilling/prototype/bare task/unknown human', () => {
        expect(gateClassFor('research', [])).toBe('auto');
        expect(gateClassFor('task', [WAYFINDER_TASK_AFK_LABEL])).toBe('auto');
        expect(gateClassFor('task', [])).toBe('human');
        expect(gateClassFor('grilling', [])).toBe('human');
        expect(gateClassFor('prototype', [])).toBe('human');
        expect(gateClassFor('other', [])).toBe('human');
    });
    it('splits a mixed frontier correctly and marks already-surfaced gated tickets', () => {
        const frontier = enumerateFrontier(MAP, [
            child(100, '## Acceptance criteria\n\n- [ ] x', { labels: ['wayfinder:research'] }),
            child(101, 'q', { labels: ['wayfinder:task', WAYFINDER_TASK_AFK_LABEL] }),
            child(102, 'q', { labels: ['wayfinder:grilling', WAYFINDER_AWAITING_HUMAN_LABEL] }),
            child(103, 'q', { labels: ['wayfinder:task'] }),
        ]);
        expect(frontier.auto.map((t) => t.number)).toEqual([100, 101]);
        expect(frontier.human.map((t) => t.number)).toEqual([102, 103]);
        expect(frontier.human.find((t) => t.number === 102)?.awaitingHuman).toBe(true);
        expect(frontier.auto.find((t) => t.number === 100)?.hasCriteria).toBe(true);
    });
});
describe('enumerateFrontier — order', () => {
    it('orders by ticket number, with an Order override taking precedence', () => {
        const frontier = enumerateFrontier(MAP, [
            child(110, 'q', { labels: ['wayfinder:research'] }),
            child(105, 'q', { labels: ['wayfinder:research'] }),
            child(120, '## Order: 1\n\nq', { labels: ['wayfinder:research'] }),
        ]);
        expect(frontier.auto.map((t) => t.number)).toEqual([120, 105, 110]);
    });
});
describe('enumerateFrontier — the live map fixture', () => {
    it('reproduces map #46’s recorded frontier from its real issue shape', () => {
        // Pinned from map #46 at close time: frontier {#47, #49, #50}; #48 was
        // blocked by the still-open #47 solely via its body line. If the convention
        // drifts, this fixture fails — that is its job.
        const records = [
            ticket({ number: 46, state: 'OPEN', labels: ['wayfinder:map'] }),
            ticket({ number: 47, labels: ['wayfinder:research', 'agents'], body: '## Parent\n\n[#46](https://github.com/o/r/issues/46)\n\n## Blocked by\n\nNone (can start immediately)' }),
            ticket({ number: 48, labels: ['wayfinder:grilling', 'agents'], body: '## Parent\n\n[#46](https://github.com/o/r/issues/46)\n\n## Blocked by\n\n- [#47](https://github.com/o/r/issues/47) (T1 research)' }),
            ticket({ number: 49, labels: ['wayfinder:grilling', 'agents'], body: '## Parent\n\n[#46](https://github.com/o/r/issues/46)\n\n## Blocked by\n\nNone (can start immediately)' }),
            ticket({ number: 50, labels: ['wayfinder:grilling', 'agents'], body: '## Parent\n\n[#46](https://github.com/o/r/issues/46)\n\n## Blocked by\n\nNone (can start immediately)' }),
        ];
        const frontier = enumerateFrontier(MAP, records);
        expect(frontier.auto.map((t) => t.number)).toEqual([47]);
        expect(frontier.human.map((t) => t.number)).toEqual([49, 50]);
        expect(frontier.malformedEdges).toEqual([]);
    });
});
//# sourceMappingURL=map-frontier.test.js.map