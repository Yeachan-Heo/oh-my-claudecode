import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStateFileLocked, occCommitAuthenticatedExternalState, occCommitMutation, occReadCurrentState, writeStateFileLockedCreateIf, writeStateFileLockedIf, } from '../lib/mode-state-io.js';
const tmpRoots = [];
function freshStateFile() {
    const root = mkdtempSync(join(tmpdir(), 'omc-occ-authority-'));
    tmpRoots.push(root);
    return join(root, 'state.json');
}
afterEach(() => {
    for (const root of tmpRoots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
describe('OCC journal authority regressions', () => {
    it('never rolls the journal back when canonical is a stale cache and a conditional mutation skips', () => {
        const filePath = freshStateFile();
        expect(occCommitMutation(filePath, () => ({ state: { owner: 'original' }, result: true }))).not.toBeNull();
        expect(occCommitMutation(filePath, () => ({ state: { owner: 'journal-head' }, result: true }))).not.toBeNull();
        // A delayed legacy cache publication reintroduces the old canonical bytes.
        // It is not journal-authenticated and must never become a new journal head.
        const staleRaw = '{"owner":"original"}';
        writeFileSync(filePath, staleRaw);
        expect(writeStateFileLockedIf(filePath, (state) => state.owner === 'does-not-match', (state) => ({ ...state, mutated: true }))).toBe('skipped');
        // A skip never turns a stale cache into durable authority.
        expect(readFileSync(filePath, 'utf8')).toBe(staleRaw);
        expect(occReadCurrentState(filePath)).toEqual({ owner: 'journal-head' });
        // The durable journal itself remains on the newer generation.
        const journalDir = `${filePath}.journal`;
        const latestComplete = readdirSync(journalDir)
            .map((name) => ({ name, match: /^(\d+)\.([0-9a-f-]{36})\.complete$/i.exec(name) }))
            .filter((entry) => entry.match !== null)
            .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0];
        expect(latestComplete).toBeDefined();
        const entryPath = join(journalDir, `${latestComplete.match[1]}.${latestComplete.match[2]}.json`);
        expect(JSON.parse(readFileSync(entryPath, 'utf8')).state).toEqual({ owner: 'journal-head' });
    });
    it('derives a mutation from the journal head and repairs a stale canonical cache', () => {
        const filePath = freshStateFile();
        expect(occCommitMutation(filePath, () => ({ state: { revision: 1 }, result: true }))).not.toBeNull();
        expect(occCommitMutation(filePath, () => ({ state: { revision: 2 }, result: true }))).not.toBeNull();
        writeFileSync(filePath, '{"revision":1}');
        expect(writeStateFileLockedIf(filePath, (state) => state.revision === 2, (state) => ({ ...state, revision: 3 }))).toBe('written');
        expect(occReadCurrentState(filePath)).toEqual({ revision: 3 });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ revision: 3 });
    });
    it('accepts an emergency publication only through its authenticated parent fence', () => {
        const filePath = freshStateFile();
        expect(occCommitMutation(filePath, () => ({ state: { revision: 1 }, result: true }))).not.toBeNull();
        // The emergency transaction captured revision 1, but another OCC writer
        // committed revision 2 before the transaction could sequence its publish.
        expect(occCommitMutation(filePath, () => ({ state: { revision: 2 }, result: true }))).not.toBeNull();
        writeFileSync(filePath, '{"revision":1,"emergency":true}');
        expect(occCommitAuthenticatedExternalState(filePath, { revision: 1 }, { revision: 1, emergency: true })).toBe(false);
        expect(occReadCurrentState(filePath)).toEqual({ revision: 2 });
    });
    it('commits a clear tombstone so the journal cannot resurrect a removed canonical state', () => {
        const filePath = freshStateFile();
        expect(occCommitMutation(filePath, () => ({ state: { owner: 'live' }, result: true }))).not.toBeNull();
        expect(clearStateFileLocked(filePath)).toBe(true);
        expect(occReadCurrentState(filePath)).toBeNull();
        expect(writeStateFileLockedCreateIf(filePath, (state) => state === null, () => ({ owner: 'created-after-clear' }))).toBe('written');
        expect(occReadCurrentState(filePath)).toEqual({ owner: 'created-after-clear' });
    });
});
//# sourceMappingURL=occ-journal-authority-regressions.test.js.map