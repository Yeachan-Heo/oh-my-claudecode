/**
 * Agent Addressability & Discoverability Contract Tests
 *
 * Covers the #3665 contract surface: stable `description + id` discoverability
 * and safe exact addressing for unnamed background agents. The matrix:
 * duplicates, unicode/long descriptions, lifecycle, session isolation,
 * completed/failed agents, legacy records — plus the anti-pattern guards:
 * spoofing, truncation ambiguity, privacy leaks, and preserving explicitly
 * named agents.
 */
import { describe, it, expect } from 'vitest';
import { addressFor, formatAgentList, hasDescription, hasExplicitName, listingLabel, notificationReference, resolveAgent, shortId, SHORT_ID_LENGTH, } from '../index.js';
function agent(overrides) {
    return {
        type: 'general-purpose',
        status: 'running',
        ...overrides,
    };
}
// ============================================================================
// shortId
// ============================================================================
describe('shortId', () => {
    it('returns the first 7 characters of a long id', () => {
        expect(shortId('ae1e2be26cb41fc74')).toBe('ae1e2be');
        expect(shortId('ae1e2be26cb41fc74')).toHaveLength(SHORT_ID_LENGTH);
    });
    it('returns ids shorter than the default length unchanged', () => {
        expect(shortId('abc')).toBe('abc');
    });
    it('returns an empty string for empty input', () => {
        expect(shortId('')).toBe('');
    });
});
// ============================================================================
// hasExplicitName / hasDescription
// ============================================================================
describe('hasExplicitName / hasDescription', () => {
    it('treats empty or whitespace-only names as absent (legacy records)', () => {
        expect(hasExplicitName(agent({ id: 'a', name: '' }))).toBe(false);
        expect(hasExplicitName(agent({ id: 'a', name: '   ' }))).toBe(false);
        expect(hasExplicitName(agent({ id: 'a', name: 'worker-1' }))).toBe(true);
    });
    it('treats empty or whitespace-only descriptions as absent', () => {
        expect(hasDescription(agent({ id: 'a', description: '' }))).toBe(false);
        expect(hasDescription(agent({ id: 'a', description: '  ' }))).toBe(false);
        expect(hasDescription(agent({ id: 'a', description: 'S2 nspin4 A/B vehicle' }))).toBe(true);
    });
});
// ============================================================================
// addressFor
// ============================================================================
describe('addressFor', () => {
    it('prefers the explicit name (unchanged named-agent addressing)', () => {
        expect(addressFor(agent({ id: 'id-1', name: 'worker-1', description: 'does things' }))).toBe('worker-1');
    });
    it('falls back to the full description for unnamed agents', () => {
        expect(addressFor(agent({ id: 'id-1', description: 'S2 nspin4 A/B vehicle' }))).toBe('S2 nspin4 A/B vehicle');
    });
    it('falls back to the full id for legacy records without name/description', () => {
        expect(addressFor(agent({ id: 'ae1e2be26cb41fc74' }))).toBe('ae1e2be26cb41fc74');
    });
    it('trims surrounding whitespace from the address', () => {
        expect(addressFor(agent({ id: 'id-1', description: '  padded  ' }))).toBe('padded');
    });
    it('never surfaces the prompt as an address (no privacy leak)', () => {
        // The contract only ever reads name/description/id — a prompt-like field
        // must not be picked up as a fallback address.
        const a = agent({ id: 'id-1' });
        a.prompt = 'Top-secret task instructions';
        expect(addressFor(a)).toBe('id-1');
        expect(addressFor(a)).not.toContain('Top-secret');
    });
});
// ============================================================================
// listingLabel
// ============================================================================
describe('listingLabel', () => {
    it('keeps the explicit name as the label (backward compatible)', () => {
        const a = agent({ id: 'id-1', name: 'worker-1', description: 'does things' });
        expect(listingLabel(a)).toBe('worker-1');
    });
    it('shows description + short id for unnamed agents', () => {
        const a = agent({ id: 'ae1e2be26cb41fc74', description: 'S2 nspin4 A/B vehicle' });
        expect(listingLabel(a)).toBe('S2 nspin4 A/B vehicle (ae1e2be)');
    });
    it('shows the full id for unnamed agents without a description (legacy records)', () => {
        expect(listingLabel(agent({ id: 'ae1e2be26cb41fc74' }))).toBe('ae1e2be26cb41fc74');
    });
    it('truncates long descriptions for display but always keeps the short id', () => {
        const a = agent({
            id: 'ae1e2be26cb41fc74',
            description: 'This is a very long description that should be truncated for display',
        });
        const label = listingLabel(a, 30);
        expect(label).toContain('(ae1e2be)');
        expect(label).toContain('...');
        // Visual width must not exceed the requested max (id suffix + ellipsis included).
        const width = label
            .replace(/\x1b\[[0-9;]*m/g, '')
            .split('')
            .reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
        expect(width).toBeLessThanOrEqual(30);
    });
    it('truncates CJK descriptions by visual width, preserving the short id', () => {
        const a = agent({
            id: 'ae1e2be26cb41fc74',
            description: '分析并行架构并给出优化建议的详细说明文档内容',
        });
        const label = listingLabel(a, 24);
        expect(label).toContain('(ae1e2be)');
        const visible = label.replace(/\x1b\[[0-9;]*m/g, '');
        const width = visible
            .split('')
            .reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
        expect(width).toBeLessThanOrEqual(24);
    });
    it('handles tiny max widths without dropping the short id', () => {
        const a = agent({ id: 'ae1e2be26cb41fc74', description: 'long description here' });
        expect(listingLabel(a, 4)).toContain('(ae1e2be)');
    });
});
// ============================================================================
// notificationReference
// ============================================================================
describe('notificationReference', () => {
    it('uses the explicit name for named agents', () => {
        expect(notificationReference(agent({ id: 'id-1', name: 'worker-1', description: 'd' }))).toBe('worker-1');
    });
    it('uses full description + short id for unnamed agents — never truncated', () => {
        const long = 'x'.repeat(500);
        expect(notificationReference(agent({ id: 'ae1e2be26cb41fc74', description: long })))
            .toBe(`${long} (ae1e2be)`);
    });
    it('falls back to the full id for legacy records', () => {
        expect(notificationReference(agent({ id: 'ae1e2be26cb41fc74' }))).toBe('ae1e2be26cb41fc74');
    });
});
// ============================================================================
// resolveAgent — exact addressing
// ============================================================================
describe('resolveAgent', () => {
    const issueScenario = () => [
        agent({ id: 'ae1e2be26cb41fc74', description: 'S2 nspin4 A/B vehicle' }),
        agent({ id: 'a31df4cfac7e5ba7f', description: 'S3 logistics payload' }),
        agent({ id: 'a90685ed2d7441ca9', description: 'S4 comms relay' }),
    ];
    it('resolves by full description for unnamed agents (the #3665 scenario)', () => {
        const result = resolveAgent(issueScenario(), 'S2 nspin4 A/B vehicle');
        expect(result).toMatchObject({
            resolved: true,
            matchedBy: 'description',
        });
        if (result.resolved) {
            expect(result.agent.id).toBe('ae1e2be26cb41fc74');
        }
    });
    it('resolves by explicit name (unchanged named-agent addressing)', () => {
        const agents = [agent({ id: 'id-1', name: 'worker-1', description: 'd' })];
        const result = resolveAgent(agents, 'worker-1');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'name' });
    });
    it('resolves by full id', () => {
        const agents = issueScenario();
        const result = resolveAgent(agents, 'a90685ed2d7441ca9');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'id' });
        if (result.resolved) {
            expect(result.agent.description).toBe('S4 comms relay');
        }
    });
    it('never resolves by short id — ids are matched in full only', () => {
        const result = resolveAgent(issueScenario(), 'ae1e2be');
        expect(result).toMatchObject({ resolved: false, reason: 'not_found' });
    });
    it('trims surrounding whitespace from the query', () => {
        const result = resolveAgent(issueScenario(), '  S2 nspin4 A/B vehicle  ');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'description' });
    });
    it('rejects an empty query', () => {
        expect(resolveAgent(issueScenario(), '')).toMatchObject({
            resolved: false,
            reason: 'empty',
        });
        expect(resolveAgent(issueScenario(), '   ')).toMatchObject({
            resolved: false,
            reason: 'empty',
        });
    });
    it('returns not_found for unknown recipients', () => {
        expect(resolveAgent(issueScenario(), 'S9 unknown vehicle')).toMatchObject({
            resolved: false,
            reason: 'not_found',
        });
    });
    it('does not match a truncated description (no truncation ambiguity)', () => {
        const result = resolveAgent(issueScenario(), 'S2 nspin4 A/B veh');
        expect(result).toMatchObject({ resolved: false, reason: 'not_found' });
    });
    it('does not do substring matching', () => {
        expect(resolveAgent(issueScenario(), 'nspin4')).toMatchObject({
            resolved: false,
            reason: 'not_found',
        });
    });
    // --- duplicates ---------------------------------------------------------
    it('refuses to resolve by description when two agents share it (ambiguous)', () => {
        const agents = [
            agent({ id: 'ae1e2be26cb41fc74', description: 'duplicate task' }),
            agent({ id: 'a31df4cfac7e5ba7f', description: 'duplicate task' }),
        ];
        const result = resolveAgent(agents, 'duplicate task');
        expect(result).toMatchObject({
            resolved: false,
            reason: 'ambiguous',
            matchedBy: 'description',
        });
        if (!result.resolved) {
            expect(result.candidates?.map((a) => a.id).sort()).toEqual([
                'a31df4cfac7e5ba7f',
                'ae1e2be26cb41fc74',
            ]);
        }
    });
    it('still resolves by id when descriptions collide', () => {
        const agents = [
            agent({ id: 'ae1e2be26cb41fc74', description: 'duplicate task' }),
            agent({ id: 'a31df4cfac7e5ba7f', description: 'duplicate task' }),
        ];
        const result = resolveAgent(agents, 'a31df4cfac7e5ba7f');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'id' });
    });
    it('refuses to resolve by name when two agents share a name (ambiguous)', () => {
        const agents = [
            agent({ id: 'id-1', name: 'dup' }),
            agent({ id: 'id-2', name: 'dup' }),
        ];
        expect(resolveAgent(agents, 'dup')).toMatchObject({
            resolved: false,
            reason: 'ambiguous',
            matchedBy: 'name',
        });
    });
    // --- spoofing / precedence ----------------------------------------------
    it('a description that equals another agent\'s name never shadows the name', () => {
        const agents = [
            agent({ id: 'id-1', name: 'worker-1', description: 'd1' }),
            agent({ id: 'id-2', description: 'worker-1' }), // tries to spoof the name
        ];
        const result = resolveAgent(agents, 'worker-1');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'name' });
        if (result.resolved) {
            expect(result.agent.id).toBe('id-1');
        }
    });
    it('a description that equals another agent\'s id never shadows the id', () => {
        const agents = [
            agent({ id: 'ae1e2be26cb41fc74', description: 'd1' }),
            agent({ id: 'id-2', description: 'ae1e2be26cb41fc74' }), // tries to spoof the id
        ];
        const result = resolveAgent(agents, 'ae1e2be26cb41fc74');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'id' });
        if (result.resolved) {
            expect(result.agent.id).toBe('ae1e2be26cb41fc74');
        }
    });
    it('does not add description addressing to explicitly named agents', () => {
        // Named agents keep name addressing; their description is display-only
        // metadata and must not become a second, shadowable address.
        const agents = [agent({ id: 'id-1', name: 'worker-1', description: 'shadowable' })];
        expect(resolveAgent(agents, 'shadowable')).toMatchObject({
            resolved: false,
            reason: 'not_found',
        });
    });
    // --- unicode / long descriptions ----------------------------------------
    it('resolves CJK descriptions exactly', () => {
        const agents = [agent({ id: 'id-1', description: '分析并行架构并给出优化建议' })];
        const result = resolveAgent(agents, '分析并行架构并给出优化建议');
        expect(result).toMatchObject({ resolved: true, matchedBy: 'description' });
    });
    it('resolves emoji and symbol-heavy descriptions exactly', () => {
        const description = '🚀 phase-2 → 🧪 a/b & (c) [d]';
        const agents = [agent({ id: 'id-1', description })];
        const result = resolveAgent(agents, description);
        expect(result).toMatchObject({ resolved: true, matchedBy: 'description' });
    });
    it('resolves very long descriptions exactly (full string, not truncated)', () => {
        const long = 'task-' + 'z'.repeat(500);
        const agents = [agent({ id: 'id-1', description: long })];
        const result = resolveAgent(agents, long);
        expect(result).toMatchObject({ resolved: true, matchedBy: 'description' });
        // And the displayed truncation of that description must NOT resolve.
        expect(resolveAgent(agents, `${long.slice(0, 40)}...`)).toMatchObject({
            resolved: false,
            reason: 'not_found',
        });
    });
    // --- lifecycle -----------------------------------------------------------
    it('still resolves completed agents by description and id', () => {
        const agents = [
            agent({ id: 'id-1', description: 'finished work', status: 'completed' }),
        ];
        expect(resolveAgent(agents, 'finished work')).toMatchObject({
            resolved: true,
            matchedBy: 'description',
        });
        expect(resolveAgent(agents, 'id-1')).toMatchObject({
            resolved: true,
            matchedBy: 'id',
        });
    });
    it('still resolves failed agents by description and id', () => {
        const agents = [
            agent({ id: 'id-1', description: 'failed work', status: 'failed' }),
        ];
        expect(resolveAgent(agents, 'failed work')).toMatchObject({
            resolved: true,
            matchedBy: 'description',
        });
        expect(resolveAgent(agents, 'id-1')).toMatchObject({
            resolved: true,
            matchedBy: 'id',
        });
    });
    // --- session isolation ---------------------------------------------------
    it('keeps per-session address spaces isolated for identical descriptions', () => {
        const sessionA = [agent({ id: 'sess-a-1', description: 'same task', sessionId: 'A' })];
        const sessionB = [agent({ id: 'sess-b-1', description: 'same task', sessionId: 'B' })];
        const inA = resolveAgent(sessionA, 'same task');
        const inB = resolveAgent(sessionB, 'same task');
        expect(inA).toMatchObject({ resolved: true, matchedBy: 'description' });
        expect(inB).toMatchObject({ resolved: true, matchedBy: 'description' });
        if (inA.resolved)
            expect(inA.agent.sessionId).toBe('A');
        if (inB.resolved)
            expect(inB.agent.sessionId).toBe('B');
        // Cross-session addressing must fail: B's id is not in A's address space.
        expect(resolveAgent(sessionA, 'sess-b-1')).toMatchObject({
            resolved: false,
            reason: 'not_found',
        });
    });
    // --- legacy records ------------------------------------------------------
    it('handles legacy records with only an id (no name/description)', () => {
        const agents = [agent({ id: 'ae1e2be26cb41fc74' })];
        expect(resolveAgent(agents, 'ae1e2be26cb41fc74')).toMatchObject({
            resolved: true,
            matchedBy: 'id',
        });
        expect(resolveAgent(agents, 'ae1e2be26cb41fc74')).not.toBeUndefined();
    });
    it('treats empty-string name/description on records as absent', () => {
        const agents = [agent({ id: 'id-1', name: '', description: '' })];
        expect(resolveAgent(agents, 'id-1')).toMatchObject({ resolved: true, matchedBy: 'id' });
        expect(resolveAgent(agents, '')).toMatchObject({ resolved: false, reason: 'empty' });
    });
});
// ============================================================================
// formatAgentList
// ============================================================================
describe('formatAgentList', () => {
    const now = new Date('2026-08-10T03:30:00Z');
    it('renders a full listing with label, type, status, started, and full id', () => {
        const agents = [
            agent({
                id: 'ae1e2be26cb41fc74',
                description: 'S2 nspin4 A/B vehicle',
                startedAt: new Date('2026-08-10T03:11:00Z'),
            }),
            agent({
                id: 'a31df4cfac7e5ba7f',
                name: 'worker-1',
                startedAt: new Date('2026-08-10T03:12:00Z'),
            }),
        ];
        const listing = formatAgentList(agents, { now });
        expect(listing).toContain('Subagents (2):');
        expect(listing).toContain('S2 nspin4 A/B vehicle (ae1e2be) · general-purpose · running · started 19m ago · ae1e2be26cb41fc74');
        // Named agents keep their name label (unchanged) and still expose the id.
        expect(listing).toContain('worker-1 · general-purpose · running · started 18m ago · a31df4cfac7e5ba7f');
    });
    it('shows lifecycle status for completed and failed agents', () => {
        const agents = [
            agent({ id: 'id-1', description: 'done', status: 'completed' }),
            agent({ id: 'id-2', description: 'broke', status: 'failed' }),
        ];
        const listing = formatAgentList(agents, { now });
        expect(listing).toContain('done (id-1) · general-purpose · completed');
        expect(listing).toContain('broke (id-2) · general-purpose · failed');
    });
    it('avoids duplicating the id column when the id is already the label', () => {
        const agents = [agent({ id: 'ae1e2be26cb41fc74', startedAt: now })];
        const listing = formatAgentList(agents, { now });
        const row = listing.split('\n')[1];
        expect(row).toBe('  ae1e2be26cb41fc74 · general-purpose · running · started just now');
    });
    it('renders an empty listing', () => {
        expect(formatAgentList([], { now })).toBe('Subagents (0):\n  (none)');
    });
    it('renders relative start times', () => {
        const cases = [
            [30_000, 'started just now'],
            [5 * 60_000, 'started 5m ago'],
            [3 * 3600_000, 'started 3h ago'],
            [2 * 86400_000, 'started 2d ago'],
        ];
        for (const [offsetMs, expected] of cases) {
            const agents = [
                agent({ id: 'id-1', startedAt: new Date(now.getTime() - offsetMs) }),
            ];
            expect(formatAgentList(agents, { now })).toContain(expected);
        }
    });
    it('omits status/started columns when disabled', () => {
        const agents = [agent({ id: 'id-1', status: 'failed', startedAt: now })];
        const listing = formatAgentList(agents, {
            now,
            showStatus: false,
            showStartedAt: false,
        });
        expect(listing).toContain('  id-1 · general-purpose');
        expect(listing).not.toContain('failed');
        expect(listing).not.toContain('started');
    });
    it('supports a custom title', () => {
        const listing = formatAgentList([agent({ id: 'id-1' })], { now, title: 'Agents' });
        expect(listing).toContain('Agents (1):');
    });
});
//# sourceMappingURL=addressability.test.js.map