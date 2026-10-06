import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendRunLedger, closeoutWrittenFor, observeModeStateClear, observeModeStateWrite, } from '../runs-ledger.js';
const fixtures = [];
afterAll(() => {
    for (const dir of fixtures)
        rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-runs-ledger-'));
    fixtures.push(dir);
    return dir;
}
function statePath(dir, mode = 'ralph', sessionId) {
    return sessionId
        ? join(dir, 'state', 'sessions', sessionId, `${mode}-state.json`)
        : join(dir, 'state', `${mode}-state.json`);
}
function ledgerLines(dir) {
    const path = join(dir, 'state', 'runs', 'ledger.jsonl');
    if (!existsSyncSafe(path))
        return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function existsSyncSafe(path) {
    try {
        return readFileSync(path, 'utf8').length >= 0;
    }
    catch {
        return false;
    }
}
describe('runs ledger', () => {
    it('records a start edge when a watched mode state becomes active', () => {
        const dir = fixture();
        const path = statePath(dir, 'ralph');
        mkdirSync(join(path, '..'), { recursive: true });
        observeModeStateWrite(dir, path, { active: true, started_at: '2026-09-27T00:00:00Z' });
        const lines = ledgerLines(dir);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ run: 'ralph', event: 'start', outcome: 'running' });
    });
    it('does not duplicate the start edge for repeated writes in the same process', () => {
        const dir = fixture();
        const path = statePath(dir, 'ralph');
        mkdirSync(join(path, '..'), { recursive: true });
        observeModeStateWrite(dir, path, { active: true });
        observeModeStateWrite(dir, path, { active: true, iteration: 2 });
        expect(ledgerLines(dir)).toHaveLength(1);
    });
    it('ignores non-watched modes and inactive states', () => {
        const dir = fixture();
        const other = statePath(dir, 'deep-interview');
        mkdirSync(join(other, '..'), { recursive: true });
        observeModeStateWrite(dir, other, { active: true });
        const inactive = statePath(dir, 'ralph');
        mkdirSync(join(inactive, '..'), { recursive: true });
        observeModeStateWrite(dir, inactive, { active: false });
        expect(ledgerLines(dir)).toEqual([]);
    });
    it('records an end edge with closeoutWritten when a previously-active state is cleared', () => {
        const dir = fixture();
        const mode = 'ralph';
        const notepad = join(dir, 'notepads', mode, 'problems.md');
        mkdirSync(join(notepad, '..'), { recursive: true });
        writeFileSync(notepad, '- 2026-09-27 closeout line\n');
        const started = new Date(Date.now() - 3600_000).toISOString();
        utimesSync(notepad, new Date(), new Date(Date.now() - 1800_000)); // after startedAt
        observeModeStateClear(dir, statePath(dir, mode), { active: true, started_at: started, current_phase: 'complete' });
        const lines = ledgerLines(dir);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ run: mode, event: 'end', outcome: 'completed', closeoutWritten: true });
    });
    it('marks closeoutWritten false when the notepad has no post-start write', () => {
        const dir = fixture();
        observeModeStateClear(dir, statePath(dir, 'ralph'), { active: true, started_at: new Date().toISOString() });
        const lines = ledgerLines(dir);
        expect(lines).toHaveLength(1);
        expect(lines[0].closeoutWritten).toBe(false);
    });
    it('appendRunLedger is callable directly and rotation keeps the tail bounded', () => {
        const dir = fixture();
        for (let i = 0; i < 1005; i += 1) {
            appendRunLedger(dir, { ts: 't', run: 'ralph', event: 'start', outcome: 'running' });
        }
        const path = join(dir, 'state', 'runs', 'ledger.jsonl');
        const lines = readFileSync(path, 'utf8').trim().split('\n');
        expect(lines.length).toBe(5);
        expect(readFileSync(`${path}.1`, 'utf8').trim().split('\n').length).toBe(1000);
    });
    it('closeoutWrittenFor requires a parseable startedAt', () => {
        const dir = fixture();
        expect(closeoutWrittenFor(dir, 'ralph', undefined)).toBe(false);
        expect(closeoutWrittenFor(dir, 'ralph', 'not-a-date')).toBe(false);
    });
});
//# sourceMappingURL=runs-ledger.test.js.map