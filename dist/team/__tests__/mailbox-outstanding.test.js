/**
 * Unit tests for mailbox outstanding-work scanning (issue #3662).
 * Covers mailbox format variants, delivery/ack transitions, and
 * race tolerance (malformed/missing files must never throw).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanMailboxOutstanding, countOutstandingForWorker, ZERO_OUTSTANDING, } from '../mailbox-outstanding.js';
describe('scanMailboxOutstanding', () => {
    let dir;
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'omc-mailbox-outstanding-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    it('counts undelivered inbound and outbound directed messages per worker', async () => {
        const nowIso = new Date().toISOString();
        writeFileSync(join(dir, 'worker-1.json'), JSON.stringify({
            worker: 'worker-1',
            messages: [
                { message_id: 'm1', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'review', created_at: nowIso },
                { message_id: 'm2', from_worker: 'worker-2', to_worker: 'worker-1', body: 'ping', created_at: nowIso },
                { message_id: 'm3', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'acked', created_at: nowIso, delivered_at: nowIso },
            ],
        }));
        writeFileSync(join(dir, 'leader-fixed.json'), JSON.stringify({
            worker: 'leader-fixed',
            messages: [
                { message_id: 'm4', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'report', created_at: nowIso },
            ],
        }));
        const result = await scanMailboxOutstanding(dir);
        expect(result['worker-1']).toEqual({ undeliveredInbound: 2, undeliveredOutbound: 1 });
        expect(result['worker-2']).toEqual({ undeliveredInbound: 0, undeliveredOutbound: 1 });
        expect(result['leader-fixed']).toEqual({ undeliveredInbound: 1, undeliveredOutbound: 1 });
    });
    it('treats delivered messages as non-outstanding (ack transition clears)', async () => {
        const nowIso = new Date().toISOString();
        writeFileSync(join(dir, 'worker-1.json'), JSON.stringify({
            worker: 'worker-1',
            messages: [
                { message_id: 'm1', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'review', created_at: nowIso, delivered_at: nowIso },
            ],
        }));
        const result = await scanMailboxOutstanding(dir);
        expect(result['worker-1']).toEqual({ undeliveredInbound: 0, undeliveredOutbound: 0 });
    });
    it('supports legacy JSONL mailboxes and bare-array JSON mailboxes', async () => {
        const nowIso = new Date().toISOString();
        writeFileSync(join(dir, 'worker-1.jsonl'), `${JSON.stringify({ message_id: 'j1', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'jsonl', created_at: nowIso })}\n${JSON.stringify({ message_id: 'j2', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'report', created_at: nowIso, delivered_at: nowIso })}\n`);
        writeFileSync(join(dir, 'worker-2.json'), JSON.stringify([
            { message_id: 'b1', from_worker: 'leader-fixed', to_worker: 'worker-2', body: 'bare', created_at: nowIso },
        ]));
        const result = await scanMailboxOutstanding(dir);
        expect(result['worker-1']).toEqual({ undeliveredInbound: 1, undeliveredOutbound: 0 });
        expect(result['worker-2']).toEqual({ undeliveredInbound: 1, undeliveredOutbound: 0 });
    });
    it('tolerates missing directories, missing files, and malformed JSON (race)', async () => {
        const result = await scanMailboxOutstanding(join(dir, 'does-not-exist'));
        expect(result).toEqual({});
        writeFileSync(join(dir, 'worker-1.json'), '{broken json');
        const mixed = await scanMailboxOutstanding(dir);
        expect(mixed['worker-1']).toEqual({ undeliveredInbound: 0, undeliveredOutbound: 0 });
        const single = await countOutstandingForWorker(dir, 'worker-1');
        expect(single).toEqual(ZERO_OUTSTANDING);
    });
    it('skips lock/dotfiles and unknown extensions', async () => {
        const nowIso = new Date().toISOString();
        writeFileSync(join(dir, '.lock-worker-1'), 'lock');
        writeFileSync(join(dir, 'worker-1.txt'), 'ignored');
        writeFileSync(join(dir, 'worker-1.json'), JSON.stringify({ worker: 'worker-1', messages: [{ message_id: 'm1', from_worker: 'x', to_worker: 'worker-1', body: 'b', created_at: nowIso }] }));
        const result = await scanMailboxOutstanding(dir);
        expect(result['worker-1']).toEqual({ undeliveredInbound: 1, undeliveredOutbound: 0 });
        // 'x' appears as the sender-ledger key for the undelivered message; lock
        // and unknown-extension files are never parsed as mailboxes.
        expect(Object.keys(result).sort()).toEqual(['worker-1', 'x']);
    });
    it('returns zero for an unknown or empty worker name', async () => {
        expect(await countOutstandingForWorker(dir, '')).toEqual(ZERO_OUTSTANDING);
        expect(await countOutstandingForWorker(dir, 'ghost')).toEqual(ZERO_OUTSTANDING);
    });
});
//# sourceMappingURL=mailbox-outstanding.test.js.map