import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OCC_TEST_HOOKS, occCleanupOwner, occCommitMutation, occReadCurrentState, } from '../lib/mode-state-io.js';
// Deterministic, pure-Node/O_EXCL probe tests for the OCC journal (B11 root cure).
// These MUST run on macOS (flock-less) - they use only O_EXCL, no flock, no
// liveness probe. The bar (per the maintainer): a stale holder that publishes
// AFTER a successor must NOT overwrite the successor, and the overlap must be
// DETECTED, not silent.
const tmpRoots = [];
function freshStateFile() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-occ-b11-'));
    tmpRoots.push(dir);
    return join(dir, 'state.json');
}
afterEach(() => {
    OCC_TEST_HOOKS.pauseAfterClaim = undefined;
    for (const dir of tmpRoots.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
describe('OCC journal B11 probe: stale-holder-publishes-after-reclaim', () => {
    it('a stale writer A does NOT publish its stale value; A re-sequences after B and the fork is detected', () => {
        const filePath = freshStateFile();
        // Seed an initial committed state (seq 0): value A0.
        expect(occCommitMutation(filePath, () => ({ state: { v: 'A0' }, result: true }))).not.toBeNull();
        expect(occReadCurrentState(filePath)).toEqual({ v: 'A0' });
        // Writer A's mutation is a PURE function of current: it appends '+A' to the
        // current value. If A ran against A0 it would produce 'A0+A' (the STALE
        // publish). The B11 race is: A computes 'A0+A' off A0, but B commits first;
        // A must NOT publish 'A0+A' over B. Under OCC, A detects the fork and
        // re-runs its mutation against B's state, producing 'B-wins+A' (NOT the
        // stale 'A0+A').
        const stalePublish = 'A0+A';
        const aMutate = (current) => {
            const v = (current && typeof current === 'object' && 'v' in current ? current.v : '');
            return { state: { v: `${v}+A` }, result: true };
        };
        // A claims seq=1 (parent=0, computed 'A0+A') and is descheduled BEFORE its
        // fence revalidation. In the window, B reclaims and commits a successor.
        // The hook fires ONLY for A's first claim (then disarms) so B's nested
        // commit does not recurse.
        let armed = true;
        OCC_TEST_HOOKS.pauseAfterClaim = {
            filePath,
            fn: () => {
                if (!armed)
                    return;
                armed = false;
                // B reclaims and commits on top of A0 while A is descheduled.
                const b = occCommitMutation(filePath, () => ({ state: { v: 'B-wins' }, result: true }));
                expect(b).not.toBeNull();
                expect(occReadCurrentState(filePath)).toEqual({ v: 'B-wins' });
            },
        };
        const aResult = occCommitMutation(filePath, aMutate);
        // A must have committed (re-sequenced after B).
        expect(aResult).not.toBeNull();
        // THE BAR: the final committed state is NOT writer-A's stale publish.
        // A re-ran against B's state, so its committed value is 'B-wins+A', not 'A0+A'.
        const finalState = occReadCurrentState(filePath);
        expect(finalState.v).not.toBe(stalePublish);
        expect(finalState.v).toBe('B-wins+A');
        // B's committed state is preserved in the history tail (A sequenced AFTER
        // B, it did not clobber B's entry).
        const dir = `${filePath}.journal`;
        const names = readdirSync(dir);
        const entryCounts = new Map();
        for (const name of names) {
            const match = name.match(/^(\d+)\.[0-9a-f-]{36}\.json$/i);
            if (match)
                entryCounts.set(Number(match[1]), (entryCounts.get(Number(match[1])) ?? 0) + 1);
        }
        // P1: a sequence is reserved by `<seq>.claim`, so competing tokens can
        // never both create entries for the same sequence.
        expect([...entryCounts.values()].every((count) => count === 1)).toBe(true);
        expect(names.filter((name) => /^\d+\.claim$/.test(name)).length).toBeGreaterThanOrEqual(entryCounts.size);
        const committedStates = names
            .filter((n) => n.endsWith('.complete'))
            .map((n) => {
            const entryName = n.replace(/\.complete$/, '.json');
            const entry = JSON.parse(readFileSync(join(dir, entryName), 'utf8'));
            return entry.state;
        });
        expect(committedStates.some((s) => s.v === 'B-wins')).toBe(true);
        // The fork was DETECTED: A's stale first attempt (parent_seq=0, state
        // 'A0+A') was rejected and left an .aborted marker. A's COMMITTED entry has
        // parent_seq pointing at B's seq (>= 1), proving re-sequencing.
        const hasAborted = names.some((n) => n.endsWith('.aborted'));
        const aCommittedEntry = names
            .map((n) => {
            const m = n.match(/^(\d+)\.([0-9a-f-]{36})\.json$/i);
            if (!m)
                return null;
            try {
                const entry = JSON.parse(readFileSync(join(dir, n), 'utf8'));
                return entry.state && entry.state.v === 'B-wins+A' ? entry : null;
            }
            catch {
                return null;
            }
        })
            .find((e) => e !== null);
        expect(hasAborted).toBe(true);
        expect(aCommittedEntry).not.toBeNull();
        expect(aCommittedEntry.parent_seq).toBeGreaterThan(0); // re-sequenced after B
    });
});
describe('OCC journal B11 probe: stale-releaser-unlinks-successor', () => {
    it('occCleanupOwner removes ONLY the owner token\'s own incomplete entries, never a successor\'s', () => {
        const filePath = freshStateFile();
        // Two distinct owner tokens.
        const tokenA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const tokenB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        // A commits seq 0.
        occCommitMutation(filePath, () => ({ state: { v: 'A0' }, result: true }), { ownerToken: tokenA });
        // B commits seq 1 (a successor).
        occCommitMutation(filePath, () => ({ state: { v: 'B1' }, result: true }), { ownerToken: tokenB });
        // A leaves a stale INCOMPLETE entry (a forked claim that never committed).
        // Simulate by creating an incomplete entry for A at a parent_seq that is
        // now stale, WITHOUT a .complete marker.
        const dir = `${filePath}.journal`;
        mkdirSync(dir, { recursive: true });
        // A's incomplete entry (e.g. a claimed-but-uncommitted fork).
        // Use a seq that won't collide with committed ones: pick a high seq.
        const staleSeq = 99;
        const incompleteEntryPath = join(dir, `${staleSeq}.${tokenA}.json`);
        const fd = openSync(incompleteEntryPath, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ seq: staleSeq, parent_seq: 0, owner_token: tokenA, state: { v: 'A-incomplete' } }));
        closeSync(fd);
        const before = readdirSync(dir);
        expect(before.some((n) => n.includes(tokenA) && n.endsWith('.json'))).toBe(true);
        expect(before.some((n) => n.includes(tokenB))).toBe(true); // B's committed entry + marker
        // A's release/cleanup runs: it must remove ONLY A's own INCOMPLETE entries.
        occCleanupOwner(filePath, tokenA);
        const after = readdirSync(dir);
        // A's incomplete entry is gone.
        expect(after.some((n) => n.includes(tokenA) && n.endsWith('.json') && n.startsWith(`${staleSeq}.`))).toBe(false);
        // B's entries are INTACT (the successor was not unlinked by A's cleanup).
        expect(after.some((n) => n.includes(tokenB) && n.endsWith('.json'))).toBe(true);
        expect(after.some((n) => n.includes(tokenB) && n.endsWith('.complete'))).toBe(true);
        // The committed current is still B1 (A's cleanup did not disturb it).
        expect(occReadCurrentState(filePath)).toEqual({ v: 'B1' });
    });
});
//# sourceMappingURL=occ-journal-b11-probe.test.js.map