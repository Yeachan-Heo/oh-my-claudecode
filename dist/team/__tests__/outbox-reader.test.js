import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readNewOutboxMessages, readAllTeamOutboxMessages, resetOutboxCursor, } from '../outbox-reader.js';
const TEST_TEAM = 'test-team-outbox-reader';
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);
beforeEach(() => {
    mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
});
afterEach(() => {
    rmSync(TEAMS_DIR, { recursive: true, force: true });
});
describe('readNewOutboxMessages', () => {
    it('reads new messages after cursor', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const msg1 = { type: 'task_complete', taskId: 't1', summary: 'done', timestamp: '2026-01-01T00:00:00Z' };
        const msg2 = { type: 'idle', message: 'standing by', timestamp: '2026-01-01T00:01:00Z' };
        writeFileSync(outbox, JSON.stringify(msg1) + '\n');
        const batch1 = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(batch1).toHaveLength(1);
        expect(batch1[0].type).toBe('task_complete');
        expect(batch1[0].taskId).toBe('t1');
        // Append more - cursor should skip first message
        const content = readFileSync(outbox, 'utf-8');
        writeFileSync(outbox, content + JSON.stringify(msg2) + '\n');
        const batch2 = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(batch2).toHaveLength(1);
        expect(batch2[0].type).toBe('idle');
    });
    it('cursor advances correctly', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const cursorFile = join(TEAMS_DIR, 'outbox', 'w1.outbox-offset');
        const msg = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox, JSON.stringify(msg) + '\n');
        readNewOutboxMessages(TEST_TEAM, 'w1');
        // Cursor should exist and have advanced
        expect(existsSync(cursorFile)).toBe(true);
        const cursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
        expect(cursor.bytesRead).toBeGreaterThan(0);
        // Reading again should return empty (no new data)
        const batch2 = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(batch2).toHaveLength(0);
    });
    it('handles empty/missing outbox', () => {
        expect(readNewOutboxMessages(TEST_TEAM, 'noworker')).toEqual([]);
    });
    it('handles file truncation (cursor > file size)', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const longMsg = { type: 'task_complete', taskId: 't1', summary: 'a'.repeat(100), timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox, JSON.stringify(longMsg) + '\n');
        readNewOutboxMessages(TEST_TEAM, 'w1'); // sets cursor past EOF
        // Truncate file to something smaller
        const shortMsg = { type: 'idle', message: 'new', timestamp: '2026-01-01T00:01:00Z' };
        writeFileSync(outbox, JSON.stringify(shortMsg) + '\n');
        const msgs = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('idle');
    });
    it('skips malformed lines', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const msg = { type: 'idle', timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox, 'not-json\n' + JSON.stringify(msg) + '\n');
        const msgs = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('idle');
    });
    it('does not drop messages when read window ends mid-JSON line', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const cursorFile = join(TEAMS_DIR, 'outbox', 'w1.outbox-offset');
        const msg1 = { type: 'task_complete', taskId: 't1', timestamp: '2026-01-01T00:00:00Z' };
        const msg2 = { type: 'idle', message: 'standing by', timestamp: '2026-01-01T00:01:00Z' };
        const msg2json = JSON.stringify(msg2);
        // Write first complete line plus a partial second line (no trailing newline)
        writeFileSync(outbox, JSON.stringify(msg1) + '\n' + msg2json.slice(0, 10));
        const batch1 = readNewOutboxMessages(TEST_TEAM, 'w1');
        // Only the complete first line should be returned
        expect(batch1).toHaveLength(1);
        expect(batch1[0].type).toBe('task_complete');
        // Cursor must NOT have advanced past the partial line; verify by checking
        // that the cursor points to the byte just after the first newline
        const cursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
        const firstLineBytes = Buffer.byteLength(JSON.stringify(msg1) + '\n', 'utf-8');
        expect(cursor.bytesRead).toBe(firstLineBytes);
        // Now complete the second line
        writeFileSync(outbox, JSON.stringify(msg1) + '\n' + msg2json + '\n');
        const batch2 = readNewOutboxMessages(TEST_TEAM, 'w1');
        // The previously partial line should now be delivered
        expect(batch2).toHaveLength(1);
        expect(batch2[0].type).toBe('idle');
        expect(batch2[0].message).toBe('standing by');
    });
});
describe('readAllTeamOutboxMessages', () => {
    it('aggregates across workers', () => {
        const outbox1 = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const outbox2 = join(TEAMS_DIR, 'outbox', 'w2.jsonl');
        const msg1 = { type: 'task_complete', taskId: 't1', timestamp: '2026-01-01T00:00:00Z' };
        const msg2 = { type: 'idle', message: 'ready', timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox1, JSON.stringify(msg1) + '\n');
        writeFileSync(outbox2, JSON.stringify(msg2) + '\n');
        const results = readAllTeamOutboxMessages(TEST_TEAM);
        expect(results).toHaveLength(2);
        const workerNames = results.map(r => r.workerName).sort();
        expect(workerNames).toEqual(['w1', 'w2']);
        for (const r of results) {
            expect(r.messages.length).toBeGreaterThan(0);
        }
    });
    it('returns empty for missing outbox dir', () => {
        rmSync(TEAMS_DIR, { recursive: true, force: true });
        expect(readAllTeamOutboxMessages(TEST_TEAM)).toEqual([]);
    });
    it('skips workers with no new messages', () => {
        const outbox1 = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const outbox2 = join(TEAMS_DIR, 'outbox', 'w2.jsonl');
        const msg1 = { type: 'task_complete', taskId: 't1', timestamp: '2026-01-01T00:00:00Z' };
        const msg2 = { type: 'idle', timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox1, JSON.stringify(msg1) + '\n');
        writeFileSync(outbox2, JSON.stringify(msg2) + '\n');
        // Read w2 first so its cursor is advanced
        readNewOutboxMessages(TEST_TEAM, 'w2');
        const results = readAllTeamOutboxMessages(TEST_TEAM);
        // Only w1 should have new messages
        expect(results).toHaveLength(1);
        expect(results[0].workerName).toBe('w1');
    });
});
describe('resetOutboxCursor', () => {
    it('resets cursor to 0', () => {
        const outbox = join(TEAMS_DIR, 'outbox', 'w1.jsonl');
        const cursorFile = join(TEAMS_DIR, 'outbox', 'w1.outbox-offset');
        const msg = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
        writeFileSync(outbox, JSON.stringify(msg) + '\n');
        // Advance cursor
        readNewOutboxMessages(TEST_TEAM, 'w1');
        const cursorBefore = JSON.parse(readFileSync(cursorFile, 'utf-8'));
        expect(cursorBefore.bytesRead).toBeGreaterThan(0);
        // Reset
        resetOutboxCursor(TEST_TEAM, 'w1');
        const cursorAfter = JSON.parse(readFileSync(cursorFile, 'utf-8'));
        expect(cursorAfter.bytesRead).toBe(0);
        // Should re-read the same message
        const msgs = readNewOutboxMessages(TEST_TEAM, 'w1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('heartbeat');
    });
});
//# sourceMappingURL=outbox-reader.test.js.map