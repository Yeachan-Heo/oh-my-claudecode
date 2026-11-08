import { describe, it, expect } from 'vitest';
import { executePlanActions, loadMapRecords, parseMapRef, planFromMap, renderMapPlan, type GhRunner } from '../map-ingest.js';
import { WAYFINDER_TASK_AFK_LABEL, WAYFINDER_AWAITING_HUMAN_LABEL, type TicketRecord } from '../map-frontier.js';

const MAP = { repo: 'o/r', number: 46 };

function ghView(overrides: Record<string, unknown>): string {
  return JSON.stringify({ number: 1, state: 'OPEN', labels: [], assignees: [], body: '', parent: null, blockedBy: { nodes: [] }, ...overrides });
}

/** A fake gh that answers `issue list` and `issue view <n>` from fixtures. */
function fakeGh(views: Record<number, string>, listJson: string): GhRunner {
  return (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: listJson, stderr: '' };
    if (args[0] === 'issue' && args[1] === 'view') {
      const n = Number(args[2]);
      const body = views[n];
      return body ? { status: 0, stdout: body, stderr: '' } : { status: 1, stdout: '', stderr: 'not found' };
    }
    return { status: 1, stdout: '', stderr: 'unsupported' };
  };
}

describe('parseMapRef', () => {
  it('parses owner/repo#46, bare #46 with fallback, and rejects junk', () => {
    expect(parseMapRef('owner/repo#46')).toEqual({ repo: 'owner/repo', number: 46 });
    expect(parseMapRef('#46', 'o/r')).toEqual({ repo: 'o/r', number: 46 });
    expect(parseMapRef('46', 'o/r')).toEqual({ repo: 'o/r', number: 46 });
    expect(parseMapRef('nonsense')).toBeNull();
    expect(parseMapRef('46')).toBeNull();
  });
});

describe('loadMapRecords', () => {
  it('normalizes labels (strings and objects), native parent, and native blocked-by from gh views', () => {
    const gh = fakeGh(
      {
        46: ghView({ labels: [{ name: 'wayfinder:map' }] }),
        50: ghView({ number: 50, labels: ['wayfinder:research', { name: 'agents' }], parent: { number: 46 }, body: '## Acceptance criteria\n\n- [ ] x' }),
        51: ghView({ number: 51, labels: [{ name: 'wayfinder:grilling' }], parent: { number: 46 }, blockedBy: { nodes: [{ number: 50, state: 'OPEN' }] }, body: 'q' }),
      },
      JSON.stringify([
        { number: 50, state: 'OPEN', labels: [{ name: 'wayfinder:research' }], assignees: [], body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)' },
        { number: 51, state: 'OPEN', labels: [{ name: 'wayfinder:grilling' }], assignees: [], body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)' },
      ]),
    );
    const records = loadMapRecords(MAP, gh);
    const byNumber = new Map(records.map((r) => [r.number, r]));
    expect(byNumber.get(50)?.labels).toEqual(['wayfinder:research', 'agents']);
    expect(byNumber.get(50)?.nativeParent).toBe(46);
    expect(byNumber.get(51)?.nativeBlockedBy).toEqual([50]);
  });

  it('chases body-named blockers so their states resolve', () => {
    const gh = fakeGh(
      {
        46: ghView({}),
        60: ghView({ number: 60, labels: ['wayfinder:research'], parent: { number: 46 }, body: '## Blocked by\n\n- [#61](https://github.com/o/r/issues/61)' }),
        61: ghView({ number: 61, state: 'CLOSED', labels: ['wayfinder:research'] }),
      },
      JSON.stringify([{ number: 60, state: 'OPEN', labels: [{ name: 'wayfinder:research' }], assignees: [], body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)' }]),
    );
    const plan = planFromMap(MAP, loadMapRecords(MAP, gh));
    // #61 CLOSED resolves the block → #60 auto-admitted.
    expect(plan.planned.filter((t) => t.gateClass === 'auto').map((t) => t.number)).toEqual([60]);
  });

  it('survives unreadable tracker output without throwing (safe direction downstream)', () => {
    const gh: GhRunner = () => ({ status: 1, stdout: '', stderr: 'boom' });
    expect(() => loadMapRecords(MAP, gh)).not.toThrow();
    const plan = planFromMap(MAP, loadMapRecords(MAP, gh));
    expect(plan.planned).toEqual([]);
  });
});

describe('planFromMap + renderMapPlan', () => {
  const records: TicketRecord[] = [
    { number: 46, state: 'OPEN', labels: ['wayfinder:map'], assignees: 0, body: '' },
    { number: 70, state: 'OPEN', labels: ['wayfinder:research'], assignees: 0, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Acceptance criteria\n\n- [ ] done', nativeParent: 46 },
    { number: 71, state: 'OPEN', labels: ['wayfinder:task', WAYFINDER_TASK_AFK_LABEL], assignees: 0, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\nquestion, no criteria', nativeParent: 46 },
    { number: 72, state: 'OPEN', labels: ['wayfinder:grilling', WAYFINDER_AWAITING_HUMAN_LABEL], assignees: 0, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\nquestion', nativeParent: 46 },
    { number: 73, state: 'OPEN', labels: ['wayfinder:research'], assignees: 0, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Blocked by\n\n[the design ticket](https://github.com/o/r/issues/not-a-number)', nativeParent: 46 },
  ];

  it('classifies ingest-with-criteria, draft-then-stop, human-routed, and malformed-edge tickets', () => {
    const plan = planFromMap(MAP, records);
    const byNumber = new Map(plan.planned.map((t) => [t.number, t]));
    expect(byNumber.get(70)).toMatchObject({ gateClass: 'auto', disposition: 'ingest-with-criteria' });
    expect(byNumber.get(71)).toMatchObject({ gateClass: 'auto', disposition: 'draft-criteria-then-stop' });
    expect(byNumber.get(72)).toMatchObject({ gateClass: 'human', awaitingHuman: true });
    expect(byNumber.get(73)).toMatchObject({ gateClass: 'human', malformedEdge: true });
    expect(plan.frontier.malformedEdges).toEqual([73]);
  });

  it('renders the split with the no-write statement and the malformed edge section', () => {
    const text = renderMapPlan(planFromMap(MAP, records));
    expect(text).toContain('dry run, nothing written');
    expect(text).toContain('auto-executable (2)');
    expect(text).toContain('#70 — ingest-with-criteria');
    expect(text).toContain('#71 — draft-criteria-then-stop');
    expect(text).toContain('#72 — already awaiting human');
    expect(text).toContain('#73');
    expect(text).toContain('malformed edges (safe direction');
  });
});
describe('executePlanActions (ticket #54)', () => {
  const records: TicketRecord[] = [
    { number: 46, state: 'OPEN', labels: ['wayfinder:map'], assignees: 0, body: '' },
    { number: 80, state: 'OPEN', labels: ['wayfinder:research'], assignees: 0, nativeParent: 46, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Acceptance criteria\n\n- [ ] done' },
    { number: 81, state: 'OPEN', labels: ['wayfinder:task', WAYFINDER_TASK_AFK_LABEL], assignees: 0, nativeParent: 46, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Question\n\nShould the widget invert itself?' },
    { number: 82, state: 'OPEN', labels: ['wayfinder:grilling'], assignees: 0, nativeParent: 46, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Question\n\nWhich way?' },
  ];
  const provenance = { sessionId: 'sess-1', mode: 'afk' as const, at: '2026-10-01T00:00:00.000Z' };

  function harness() {
    const calls: string[][] = [];
    const comments: Array<{ ticket: number; body: string }> = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(records.map((r) => ({ number: r.number, state: r.state, labels: r.labels.map((name) => ({ name })), assignees: [], body: r.body }))), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view') {
        const n = Number(args[2]);
        const rec = records.find((r) => r.number === n);
        return rec ? { status: 0, stdout: JSON.stringify({ ...rec, labels: rec.labels.map((name) => ({ name })), parent: null, blockedBy: { nodes: [] } }), stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const comment = (_ref: { repo: string; number: number }, ticket: number, body: string) => {
      comments.push({ ticket, body });
      return 0;
    };
    return { calls, comments, gh, comment };
  }

  it('claims a criteria-carrying auto ticket with provenance and routes the human gate without claiming it', () => {
    const h = harness();
    const outcomes = executePlanActions(planFromMap(MAP, records), { provenance, gh: h.gh, comment: h.comment });
    const byTicket = new Map(outcomes.map((o) => [o.ticket, o.action]));
    expect(byTicket.get(80)).toBe('claimed');
    expect(byTicket.get(82)).toBe('routed-to-human');
    const claimCalls = h.calls.filter((c) => c[1] === 'edit' && c.includes('--add-assignee'));
    // 80 (criteria) and 81 (drafted, held during the human's edit) are claimed;
    // the human gate 82 is never claimed.
    expect(claimCalls.map((c) => c[2])).toEqual(['80', '81']);
    const provenanceComment = h.comments.find((c) => c.ticket === 80);
    expect(provenanceComment?.body).toContain('sess-1');
    expect(provenanceComment?.body).toContain('mode: afk');
    // The grilling gate is labelled + routed, never claimed.
    const gateLabel = h.calls.find((c) => c[1] === 'edit' && c.includes('--add-label') && c[2] === '82');
    expect(gateLabel).toBeDefined();
    expect(h.comments.some((c) => c.ticket === 82 && c.body.includes('human gate'))).toBe(true);
  });

  it('drafts criteria for a criteria-less ticket and stops before further tickets', () => {
    const h = harness();
    const outcomes = executePlanActions(planFromMap(MAP, records), { provenance, gh: h.gh, comment: h.comment });
    const draft = outcomes.find((o) => o.ticket === 81);
    expect(draft?.action).toBe('drafted-then-stopped');
    expect(draft?.detail).toContain('human acceptance required');
    const draftComment = h.comments.find((c) => c.ticket === 81 && c.body.includes('EDIT AND ACCEPT'));
    expect(draftComment?.body).toContain('Should the widget invert itself?');
    expect(draftComment?.body).toContain('evidence a reviewer can check');
    // The stop happened: nothing after the draft ticket was claimed.
    const claimCalls = h.calls.filter((c) => c[1] === 'edit' && c.includes('--add-assignee'));
    expect(claimCalls.map((c) => c[2])).not.toContain('82');
  });

  it('skips an already-surfaced gate and reports a failed claim instead of pretending', () => {
    const alreadySurfaced = records.map((r) => (r.number === 82 ? { ...r, labels: [...r.labels, WAYFINDER_AWAITING_HUMAN_LABEL] } : r));
    const h1 = harness();
    const outcomes = executePlanActions(planFromMap(MAP, alreadySurfaced), { provenance, gh: h1.gh, comment: h1.comment });
    expect(outcomes.find((o) => o.ticket === 82)?.action).toBe('skipped');

    const h2 = harness();
    const failing: GhRunner = (args) => {
      if (args[1] === 'edit' && args.includes('--add-assignee')) return { status: 1, stdout: '', stderr: 'denied' };
      return h2.gh(args);
    };
    const outcomes2 = executePlanActions(planFromMap(MAP, records), { provenance, gh: failing, comment: h2.comment });
    expect(outcomes2.find((o) => o.ticket === 80)).toMatchObject({ action: 'skipped' });
    expect(outcomes2.find((o) => o.ticket === 80)?.detail).toContain('claim failed');
  });
});
